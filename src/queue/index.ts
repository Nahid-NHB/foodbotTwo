import { Queue, Worker, type Processor, type WorkerOptions } from 'bullmq';
import { redis } from '../redis/client.js';
import { logger } from '../logger.js';
import { transcribe } from '../speech/transcribe.js';
import { getCachedTranscript, setCachedTranscript } from '../speech/cache.js';
import { resolveMediaUrl, downloadMedia, sendText } from '../whatsapp/client.js';
import * as ConversationService from '../conversation/service.js';
import { runConversationTurn } from '../ai/agent.js';
import { findOrCreateByPhone } from '../customer/service.js';
import { loggerForJob } from '../middleware/requestId.js';
import { startWorkerHeartbeat } from '../middleware/workerHeartbeat.js';
import db from '../db/client.js';

// Transcribe job retry policy: 3 attempts total with exponential backoff.
// Tuned for transient failures (Gemini 500s, WhatsApp media URL 5-min expiry).
// With base delay 5000ms and exponential: retry 1 ≈ 5s, retry 2 ≈ 10s.
const TRANSCRIBE_RETRY = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5000 },
};

// Bangla fallback the customer sees if STT ultimately fails — we still try to
// run the conversation so they can re-voice or type.
const TRANSCRIBE_FALLBACK_BN =
  'ভাই, ভয়েসটা বুঝতে পারিনি। টেক্সটে লিখে দিলে দ্রুত অর্ডার নিতে পারব।';

const QUEUE_PREFIX = 'foodbot';

export interface TranscribeJobData {
  messageId: string;
  mediaId: string;
  mimeType: string;
  conversationId: string;
  customerId: string;
  restaurantId: string;
  whatsappPhoneE164: string;
  reqId?: string;
}

export interface ConversationJobData {
  messageId: string;
  conversationId: string;
  customerId: string;
  restaurantId: string;
  whatsappPhoneE164: string;
  userText: string;
  reqId?: string;
}

export interface SendJobData {
  to: string;
  body: string;
  conversationId: string;
}

export const audioQueue = new Queue<TranscribeJobData>('audio.transcribe', {
  connection: redis,
  prefix: QUEUE_PREFIX,
  defaultJobOptions: {
    attempts: TRANSCRIBE_RETRY.attempts,
    backoff: TRANSCRIBE_RETRY.backoff,
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 1000 },
  },
});

export const processQueue = new Queue<ConversationJobData>('conversation.process', {
  connection: redis,
  prefix: QUEUE_PREFIX,
});

export const sendQueue = new Queue<SendJobData>('whatsapp.send', {
  connection: redis,
  prefix: QUEUE_PREFIX,
});

const defaultWorkerOpts: Omit<WorkerOptions, 'connection'> = {
  prefix: QUEUE_PREFIX,
  concurrency: 4,
};

const transcribeProcessor: Processor<TranscribeJobData> = async (job) => {
  const { messageId, mediaId, conversationId, customerId, restaurantId, whatsappPhoneE164 } =
    job.data;
  const log = loggerForJob(job, { name: 'audio.transcribe' });

  // Idempotency: skip if transcript already set on the message row.
  const rows = await db.query<{ transcript: string | null }>(
    `SELECT transcript FROM messages WHERE id = $1`,
    [messageId],
  );
  if (rows[0]?.transcript) {
    log.info({ messageId }, 'transcribe: already transcribed, skipping');
    return { skipped: true };
  }

  // Cache lookup — Meta resends the same media_id for replays/retries. Skip
  // the network round trip if we already have a transcript for this media_id.
  const cached = await getCachedTranscript(mediaId);
  if (cached) {
    log.info({ mediaId, messageId }, 'transcribe: cache hit');
    await db.query(`UPDATE messages SET transcript = $1 WHERE id = $2`, [cached, messageId]);
    await processQueue.add('turn', {
      messageId,
      conversationId,
      customerId,
      restaurantId,
      whatsappPhoneE164,
      userText: cached,
      reqId: job.data.reqId,
    });
    return { cache_hit: true, transcript_length: cached.length };
  }

  const url = await resolveMediaUrl(mediaId);
  const buf = await downloadMedia(url);

  const transcript = await transcribe(buf, job.data.mimeType);

  // Fire-and-forget cache write — we don't want a cache failure to fail the job.
  void setCachedTranscript(mediaId, transcript);

  await db.query(`UPDATE messages SET transcript = $1 WHERE id = $2`, [transcript, messageId]);

  await processQueue.add('turn', {
    messageId,
    conversationId,
    customerId,
    restaurantId,
    whatsappPhoneE164,
    userText: transcript,
    reqId: job.data.reqId,
  });

  return { transcript_length: transcript.length };
};

const conversationProcessor: Processor<ConversationJobData> = async (job) => {
  const { conversationId, customerId, restaurantId, userText } = job.data;
  const log = loggerForJob(job, { name: 'conversation.process' });

  const result = await runConversationTurn({
    conversationId,
    customerId,
    restaurantId,
    userText,
  });

  await db.query(
    `UPDATE messages
     SET llm_output = $1::jsonb, tool_calls = $2::jsonb
     WHERE id = $3`,
    [JSON.stringify({ reply: result.reply }), JSON.stringify(result.toolCalls), job.data.messageId],
  );

  // Persist outbound message + enqueue send
  if (result.reply) {
    const { newId } = await import('../common/id.js');
    const outId = newId();
    await db.query(
      `INSERT INTO messages (id, conversation_id, direction, kind, raw_payload)
       VALUES ($1, $2, 'outbound', 'text', $3::jsonb)`,
      [outId, conversationId, JSON.stringify({ body: result.reply })],
    );
    await sendQueue.add('send', {
      to: job.data.whatsappPhoneE164,
      body: result.reply,
      conversationId,
    });
  }
  return { reply_length: result.reply.length, tool_calls: result.toolCalls.length };
};

const sendProcessor: Processor<SendJobData> = async (job) => {
  await sendText({ to: job.data.to, body: job.data.body });
  return { sent: true };
};

/**
 * On terminal STT failure (all retries exhausted), surface a Bangla fallback
 * to the customer instead of going silent: enqueue a conversation turn with
 * the fallback text and enqueue the fallback reply. The customer can then
 * re-voice or type what they actually wanted.
 *
 * Only fires for transcribe jobs that exhausted retries (`attemptsMade >=
 * attempts` and `failedReason` is set). Mid-retry failures fall through to
 * the `failed` listener above which just logs.
 */
async function handleTranscribeFinalFailure(
  job: { id?: string; data: TranscribeJobData; attemptsMade: number },
  err: Error,
): Promise<void> {
  const { messageId, conversationId, customerId, restaurantId, whatsappPhoneE164 } = job.data;
  const log = loggerForJob(job, { name: 'audio.transcribe' });
  log.error(
    { messageId, attemptsMade: job.attemptsMade, err: err.message },
    'transcribe: all attempts exhausted — sending fallback',
  );
  try {
    await db.query(`UPDATE messages SET transcript = $1 WHERE id = $2`, [TRANSCRIBE_FALLBACK_BN, messageId]);
    await processQueue.add('turn', {
      messageId,
      conversationId,
      customerId,
      restaurantId,
      whatsappPhoneE164,
      userText: TRANSCRIBE_FALLBACK_BN,
      reqId: job.data.reqId,
    });
  } catch (writeErr) {
    log.error({ err: writeErr }, 'transcribe fallback: failed to enqueue fallback turn');
  }
}

export function createWorkers(): {
  close: () => Promise<void>;
} {
  const transcribeWorker = new Worker<TranscribeJobData>(
    'audio.transcribe',
    transcribeProcessor,
    { ...defaultWorkerOpts, connection: redis },
  );
  const conversationWorker = new Worker<ConversationJobData>(
    'conversation.process',
    conversationProcessor,
    { ...defaultWorkerOpts, connection: redis },
  );
  const sendWorker = new Worker<SendJobData>(
    'whatsapp.send',
    sendProcessor,
    { ...defaultWorkerOpts, connection: redis },
  );

  // Start heartbeats so /healthz can reflect liveness.
  const stopAudioHb = startWorkerHeartbeat('audio.transcribe');
  const stopConvHb = startWorkerHeartbeat('conversation.process');
  const stopSendHb = startWorkerHeartbeat('whatsapp.send');

  for (const w of [transcribeWorker, conversationWorker, sendWorker]) {
    w.on('failed', (job, err) => {
      const log = job ? loggerForJob(job, { name: w.name }) : logger;
      log.error(
        { attemptsMade: job?.attemptsMade, err: err.message },
        'worker job failed',
      );
      if (w === transcribeWorker && job && job.attemptsMade >= TRANSCRIBE_RETRY.attempts) {
        void handleTranscribeFinalFailure(
          { id: job.id, data: job.data, attemptsMade: job.attemptsMade },
          err,
        );
      }
    });
  }

  return {
    async close() {
      await Promise.all([
        transcribeWorker.close(),
        conversationWorker.close(),
        sendWorker.close(),
      ]);
      stopAudioHb();
      stopConvHb();
      stopSendHb();
    },
  };
}

export async function closeQueues(): Promise<void> {
  await Promise.all([audioQueue.close(), processQueue.close(), sendQueue.close()]);
}
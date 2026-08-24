import { Queue, Worker, type Processor, type WorkerOptions } from 'bullmq';
import { redis } from '../redis/client.js';
import { logger } from '../logger.js';
import { transcribe } from '../speech/whisper.js';
import { resolveMediaUrl, downloadMedia, sendText } from '../whatsapp/client.js';
import * as ConversationService from '../conversation/service.js';
import { runConversationTurn } from '../ai/agent.js';
import { findOrCreateByPhone } from '../customer/service.js';
import db from '../db/client.js';

const QUEUE_PREFIX = 'foodbot';

export interface TranscribeJobData {
  messageId: string;
  mediaId: string;
  mimeType: string;
  conversationId: string;
  customerId: string;
  restaurantId: string;
  whatsappPhoneE164: string;
}

export interface ConversationJobData {
  messageId: string;
  conversationId: string;
  customerId: string;
  restaurantId: string;
  whatsappPhoneE164: string;
  userText: string;
}

export interface SendJobData {
  to: string;
  body: string;
  conversationId: string;
}

export const audioQueue = new Queue<TranscribeJobData>('audio.transcribe', {
  connection: redis,
  prefix: QUEUE_PREFIX,
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

  // Idempotency: skip if transcript already set on the message row.
  const rows = await db.query<{ transcript: string | null }>(
    `SELECT transcript FROM messages WHERE id = $1`,
    [messageId],
  );
  if (rows[0]?.transcript) {
    logger.info({ messageId }, 'transcribe: already transcribed, skipping');
    return { skipped: true };
  }

  const url = await resolveMediaUrl(mediaId);
  const buf = await downloadMedia(url);

  const transcript = await transcribe(buf, job.data.mimeType);

  await db.query(`UPDATE messages SET transcript = $1 WHERE id = $2`, [transcript, messageId]);

  await processQueue.add('turn', {
    messageId,
    conversationId,
    customerId,
    restaurantId,
    whatsappPhoneE164,
    userText: transcript,
  });

  return { transcript_length: transcript.length };
};

const conversationProcessor: Processor<ConversationJobData> = async (job) => {
  const { conversationId, customerId, restaurantId, userText } = job.data;

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

  for (const w of [transcribeWorker, conversationWorker, sendWorker]) {
    w.on('failed', (job, err) => {
      logger.error({ jobId: job?.id, err: err.message }, 'worker job failed');
    });
  }

  return {
    async close() {
      await Promise.all([
        transcribeWorker.close(),
        conversationWorker.close(),
        sendWorker.close(),
      ]);
    },
  };
}

export async function closeQueues(): Promise<void> {
  await Promise.all([audioQueue.close(), processQueue.close(), sendQueue.close()]);
}
import type { FastifyInstance, FastifyRequest } from 'fastify';
// We accept any-compatible app shape to avoid Fastify's strict logger generics.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _Unused = FastifyInstance;
import { config } from '../config.js';
import { logger } from '../logger.js';
import { verifySignature } from './verify.js';
import { findOrCreateByPhone } from '../customer/service.js';
import * as ConversationService from '../conversation/service.js';
import { audioQueue, processQueue } from '../queue/index.js';
import { newId } from '../common/id.js';
import db from '../db/client.js';

interface WebhookMessage {
  from: string;
  id: string;
  timestamp: string;
  type: 'text' | 'audio' | string;
  text?: { body: string };
  audio?: { id: string; mime_type: string };
}

interface WebhookValue {
  messaging_product: string;
  metadata: { phone_number_id: string };
  contacts?: Array<{ profile: { name: string }; wa_id: string }>;
  messages?: WebhookMessage[];
}

interface WebhookPayload {
  object?: string;
  entry?: Array<{
    changes?: Array<{ value?: WebhookValue; field?: string }>;
  }>;
}

/**
 * Meta WhatsApp Cloud API webhook.
 *
 *   GET  /webhook  — verification challenge (sets up webhook in Meta dashboard).
 *   POST /webhook  — inbound messages. Idempotent on wamid; returns 200 fast.
 *
 * The POST handler is registered with raw body parsing so we can verify
 * the X-Hub-Signature-256 HMAC. The parsed JSON is exposed on req.body.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function registerWebhook(app: any): Promise<void> {
  // The Fastify generic logger type clashes with our pino instance. Cast here
  // so subsequent route() calls don't fight the type system.
  const a = app as unknown as {
    get: (
      url: string,
      handler: (req: FastifyRequest, reply: {
        code: (n: number) => { send: (b: string) => unknown };
        send: (b: string) => unknown;
      }) => unknown,
    ) => void;
    post: (
      url: string,
      handler: (req: FastifyRequest, reply: {
        code: (n: number) => { send: (b: string) => unknown };
        send: (b: string) => unknown;
      }) => unknown,
    ) => void;
  };
  void a; // silence unused warning if any
  a.get('/webhook', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === config.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
      return reply.code(200).send(q['hub.challenge'] ?? '');
    }
    return reply.code(403).send('forbidden');
  });

  a.post('/webhook', async (req, reply) => {
    const r = req as FastifyRequest & { rawBody?: Buffer };
    const rawBody: Buffer = r.rawBody ?? Buffer.from(JSON.stringify(req.body));
    const signature = req.headers['x-hub-signature-256'] as string | undefined;

    // Signature verification is required in production but skippable in dev.
    if (config.NODE_ENV === 'production' || signature) {
      const ok = verifySignature(rawBody, signature, config.WHATSAPP_APP_SECRET);
      if (!ok) {
        logger.warn({ hasSig: !!signature }, 'webhook signature invalid');
        return reply.code(401).send('invalid signature');
      }
    }

    const payload = req.body as WebhookPayload;
    if (payload.object !== 'whatsapp_business_account' || !payload.entry) {
      return reply.code(200).send('ok');
    }

    const phoneNumberId = payload.entry
      .flatMap((e) => e.changes ?? [])
      .map((c) => c.value?.metadata?.phone_number_id)
      .find((id): id is string => !!id);
    if (!phoneNumberId) return reply.code(200).send('ok');

    const restRows = await db.query<{ id: string }>(
      `SELECT id FROM restaurants WHERE whatsapp_phone_number_id = $1 LIMIT 1`,
      [phoneNumberId],
    );
    const restaurant = restRows[0];
    if (!restaurant) {
      logger.warn({ phoneNumberId }, 'webhook: unknown phone_number_id');
      return reply.code(200).send('ok');
    }

    for (const entry of payload.entry) {
      const reqId = (req as { id?: string }).id ?? '';
      for (const change of entry.changes ?? []) {
        const value = change.value;
        if (!value || !value.messages) continue;
        for (const m of value.messages) {
          await handleInbound(m, restaurant.id, reqId).catch((err) => {
            logger.error({ err, wamid: m.id, reqId }, 'failed to handle inbound message');
          });
        }
      }
    }

    return reply.code(200).send('ok');
  });
}

async function handleInbound(m: WebhookMessage, restaurantId: string, reqId: string): Promise<void> {
  // Idempotency on whatsapp_message_id. If already inserted, skip.
  const phoneE164 = m.from.startsWith('+') ? m.from : `+${m.from}`;
  const customer = await findOrCreateByPhone(phoneE164);
  const conversation = await ConversationService.getOrCreate(customer.id, restaurantId);

  const ins = await db.query<{ id: string }>(
    `INSERT INTO messages (id, conversation_id, whatsapp_message_id, direction, kind, raw_payload)
     SELECT $1, $2, $3, 'inbound', $4, $5::jsonb
     WHERE NOT EXISTS (SELECT 1 FROM messages WHERE whatsapp_message_id = $3)
     RETURNING id`,
    [newId(), conversation.id, m.id, m.type === 'audio' ? 'voice' : 'text', JSON.stringify(m)],
  );
  const inserted = ins[0];
  if (!inserted) {
    logger.info({ wamid: m.id, reqId }, 'duplicate inbound — skipping');
    return;
  }
  const messageId = inserted.id;

  await ConversationService.touchLastMessage(conversation.id);

  if (m.type === 'audio' && m.audio) {
    await audioQueue.add('transcribe', {
      messageId,
      mediaId: m.audio.id,
      mimeType: m.audio.mime_type,
      conversationId: conversation.id,
      customerId: customer.id,
      restaurantId,
      whatsappPhoneE164: phoneE164,
      reqId,
    });
    return;
  }

  if (m.type === 'text' && m.text) {
    await db.query(`UPDATE messages SET transcript = $1 WHERE id = $2`, [m.text.body, messageId]);
    await processQueue.add('turn', {
      messageId,
      conversationId: conversation.id,
      customerId: customer.id,
      restaurantId,
      whatsappPhoneE164: phoneE164,
      userText: m.text.body,
      reqId,
    });
    return;
  }

  logger.info({ type: m.type, wamid: m.id, reqId }, 'unsupported message type');
}
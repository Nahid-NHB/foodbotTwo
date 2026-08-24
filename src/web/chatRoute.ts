import type { FastifyInstance, FastifyRequest } from 'fastify';
// We accept any-compatible app shape to avoid Fastify's strict logger generics.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _Unused = FastifyInstance;
import { z } from 'zod';
import { logger } from '../logger.js';
import { findOrCreateByPhone } from '../customer/service.js';
import * as ConversationService from '../conversation/service.js';
import { runConversationTurn } from '../ai/agent.js';
import { newId } from '../common/id.js';
import db from '../db/client.js';

const ChatInputSchema = z.object({
  phone: z.string().min(7).describe('E.164 phone number, e.g. +8801700009999'),
  userText: z.string().min(1).max(2000),
});

/**
 * Internal HTTP endpoint used by the Next.js test-chat UI to drive the agent.
 *
 * The webhook already handles real WhatsApp messages via `/webhook`. This route
 * skips signature verification, queueing, and message persistence — it runs the
 * agent synchronously and returns the reply + tool-call log + current cart.
 *
 * Request:
 *   POST /api/chat
 *   { "phone": "+8801700009999", "userText": "2 ta chicken burger den" }
 *
 * Response:
 *   {
 *     "reply": "...",
 *     "toolCalls": [{ "name", "args", "result" }],
 *     "cart": [...],
 *     "tokensUsed": 87
 *   }
 */
export async function registerChatRoute(app: FastifyInstance): Promise<void> {
  // After CORS registration the app type narrows. Cast back to a loose shape
  // matching the webhook router.
  const a = app as unknown as {
    post: (
      url: string,
      opts: unknown,
      handler: (req: FastifyRequest, reply: {
        code: (n: number) => { send: (b: unknown) => unknown };
        send: (b: unknown) => unknown;
      }) => unknown,
    ) => void;
  };

  a.post(
    '/api/chat',
    {},
    async (req, reply) => {
      // Parse and validate with Zod (we don't use Fastify's JSON schema so
      // we don't need zod-to-json-schema in the bundle).
      const parsed = ChatInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'invalid_body',
          detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        });
      }
      const body = parsed.data;

      // 1. Find or create the customer.
      const customer = await findOrCreateByPhone(body.phone);

      // 2. Pick the first restaurant in the DB (MVP is single-tenant).
      const restRows = await db.query<{ id: string }>(
        `SELECT id FROM restaurants ORDER BY created_at ASC LIMIT 1`,
      );
      const restaurant = restRows[0];
      if (!restaurant) {
        return reply.code(500).send({ error: 'no_restaurant_seeded' });
      }

      // 3. Find or create the conversation.
      const conversation = await ConversationService.getOrCreate(customer.id, restaurant.id);

      // 4. Persist the inbound user text so loadHistory sees it.
      const msgId = newId();
      await db.query(
        `INSERT INTO messages (id, conversation_id, direction, kind, transcript, raw_payload)
         VALUES ($1, $2, 'inbound', 'text', $3, $4::jsonb)`,
        [msgId, conversation.id, body.userText, JSON.stringify({ source: 'test-chat', phone: body.phone })],
      );
      await ConversationService.touchLastMessage(conversation.id);

      // 5. Run the agent synchronously.
      let result;
      try {
        result = await runConversationTurn({
          conversationId: conversation.id,
          customerId: customer.id,
          restaurantId: restaurant.id,
          userText: body.userText,
        });
      } catch (err) {
        logger.error({ err, phone: body.phone }, 'agent turn failed');
        return reply.code(500).send({ error: 'agent_failed', detail: String(err) });
      }

      // 6. Snapshot the cart after the turn.
      const cart = await ConversationService.getCart(conversation.id);

      // 7. Persist the outbound reply so the conversation log is consistent.
      const outId = newId();
      await db.query(
        `INSERT INTO messages (id, conversation_id, direction, kind, transcript, raw_payload)
         VALUES ($1, $2, 'outbound', 'text', $3, $4::jsonb)`,
        [outId, conversation.id, result.reply, JSON.stringify({ source: 'test-chat', tokensUsed: result.totalTokens })],
      );

      return reply.code(200).send({
        reply: result.reply,
        toolCalls: result.toolCalls,
        cart,
        tokensUsed: result.totalTokens,
      });
    },
  );
}
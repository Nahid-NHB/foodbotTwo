import type { FastifyInstance, FastifyRequest } from 'fastify';
import { logger } from '../logger.js';
import db from '../db/client.js';
import { checkBasicAuth } from './basicAuth.js';

/**
 * `GET /admin/notifications/recent` — list recent order status notifications.
 *
 * Operators use this to debug WhatsApp delivery: which notifications were
 * sent, which Meta confirmed (`delivered_at`), which failed
 * (`failed_reason`), and the originating `wamid` for cross-reference with
 * Meta's dashboard.
 *
 * Basic auth from ADMIN_BASIC_AUTH_USER / ADMIN_BASIC_AUTH_PASS env vars.
 * Returns 401 on missing/invalid auth, 200 with payload otherwise.
 *
 * Optional query params:
 *   - order_id: uuid — restrict to a single order
 *   - limit: 1..200 — default 50
 */
export async function registerNotificationRoutes(app: FastifyInstance): Promise<void> {
  const a = app as unknown as {
    get: (
      url: string,
      opts: unknown,
      handler: (req: FastifyRequest, reply: any) => unknown,
    ) => void;
  };

  a.get('/admin/notifications/recent', {
    schema: {
      tags: ['admin'],
      summary: 'Recent order status notifications (basic auth)',
      querystring: {
        type: 'object',
        properties: {
          order_id: { type: 'string', format: 'uuid' },
          limit: {
            type: 'string',
            description: 'Max rows to return (default 50, max 200)',
          },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            count: { type: 'integer' },
            notifications: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  order_id: { type: 'string' },
                  to_state: { type: 'string' },
                  sent_at: { type: 'string' },
                  delivered_at: { type: ['string', 'null'] },
                  failed_reason: { type: ['string', 'null'] },
                  wamid: { type: ['string', 'null'] },
                },
              },
            },
          },
        },
        401: {
          type: 'object',
          properties: { error: { type: 'string' } },
        },
      },
    },
  }, async (req, reply) => {
    if (!checkBasicAuth(req.headers.authorization)) {
      reply.code(401);
      reply.header('WWW-Authenticate', 'Basic realm="admin"');
      return reply.send({ error: 'unauthorized' });
    }

    const q = req.query as Record<string, string | undefined>;
    const limit = Math.min(parseInt(q['limit'] ?? '50', 10) || 50, 200);

    const params: unknown[] = [];
    let where = '1=1';
    if (q['order_id']) {
      params.push(q['order_id']);
      where = 'order_id = $1';
    }
    params.push(limit);

    const rows = await db.query<{
      id: string;
      order_id: string;
      to_state: string;
      sent_at: string;
      delivered_at: string | null;
      failed_reason: string | null;
      wamid: string | null;
    }>(
      `SELECT id, order_id, to_state, sent_at, delivered_at, failed_reason, wamid
         FROM order_status_notifications
         WHERE ${where}
         ORDER BY sent_at DESC LIMIT $${params.length}`,
      params,
    );

    logger.info({ count: rows.length, order_id: q['order_id'] }, 'admin: notifications listed');

    return reply.send({ count: rows.length, notifications: rows });
  });
}
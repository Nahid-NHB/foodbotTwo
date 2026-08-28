import type { FastifyInstance, FastifyRequest } from 'fastify';
import db from '../db/client.js';
import * as OrderService from '../order/service.js';
import * as DeliveryService from '../delivery/service.js';

/**
 * Read-only web API endpoints consumed by the Next.js test-chat UI sidebar.
 *
 * These are unauthenticated because they are only used in the local test UI.
 * Production should put these behind the same auth as the chat route (or
 * proxy them through Next.js with proper auth).
 *
 *   GET /api/orders/recent?phone=+8801700009999
 *     → { orders: OrderHistoryRow[] }   up to 5 most-recent orders (any state)
 *
 *   GET /api/address?phone=+8801700009999
 *     → { address: CustomerAddress | null }
 *
 * Both return empty results for unknown phones (200, not 404) so the UI can
 * render a "no data" state without throwing.
 */
export async function registerWebApi(app: FastifyInstance): Promise<void> {
  // Fastify's strict logger typing clashes with our pino logger; cast to a
  // loose shape for parity with src/web/chatRoute.ts and src/admin/notifications.ts.
  const a = app as unknown as {
    get: (
      url: string,
      opts: unknown,
      handler: (req: FastifyRequest, reply: {
        code: (n: number) => { send: (b: unknown) => unknown };
        send: (b: unknown) => unknown;
      }) => unknown,
    ) => void;
  };

  a.get('/api/orders/recent', {
    schema: {
      tags: ['web'],
      summary: 'Recent orders for a customer (test UI)',
      querystring: {
        type: 'object',
        properties: {
          phone: { type: 'string', description: 'E.164 phone number' },
          limit: { type: 'string', description: 'Override the default of 5 (max 20)' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            orders: { type: 'array', items: { type: 'object' } },
          },
        },
        400: {
          type: 'object',
          properties: { error: { type: 'string' } },
        },
      },
    },
  }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const phone = q['phone'];
    if (!phone) {
      return reply.code(400).send({ error: 'phone required' });
    }
    const limit = Math.min(parseInt(q['limit'] ?? '5', 10) || 5, 20);

    const cust = await db.query<{ id: string }>(
      `SELECT id FROM customers WHERE phone_e164 = $1`,
      [phone],
    );
    if (!cust[0]) {
      return reply.send({ orders: [] });
    }
    const orders = await OrderService.listHistoryByCustomer(cust[0].id, {
      limit,
      beforeIso: null,
      includeTerminal: true,
    });
    return reply.send({ orders });
  });

  a.get('/api/address', {
    schema: {
      tags: ['web'],
      summary: 'Default delivery address for a customer (test UI)',
      querystring: {
        type: 'object',
        properties: {
          phone: { type: 'string', description: 'E.164 phone number' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            address: { type: ['object', 'null'] },
          },
        },
        400: {
          type: 'object',
          properties: { error: { type: 'string' } },
        },
      },
    },
  }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const phone = q['phone'];
    if (!phone) {
      return reply.code(400).send({ error: 'phone required' });
    }

    const cust = await db.query<{ id: string }>(
      `SELECT id FROM customers WHERE phone_e164 = $1`,
      [phone],
    );
    if (!cust[0]) {
      return reply.send({ address: null });
    }
    const addr = await DeliveryService.getDefaultAddress(cust[0].id);
    return reply.send({ address: addr });
  });
}

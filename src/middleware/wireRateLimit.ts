/**
 * Per-route rate-limit wiring.
 *
 * Centralizes the choice of bucket key + limit per route, returning a
 * single Fastify preHandler hook that dispatches by URL.
 *
 * Bypasses:
 *   - When `config.RATELIMIT_DISABLED` is true (used in tests, local dev).
 *
 * Buckets:
 *   - `POST /webhook`     → keyed on client IP, default 30 / min
 *   - `POST /api/chat`    → keyed on body.phone,   default 20 / min
 *
 * Use as: `app.addHook('preHandler', buildRateLimitHook())`
 */
import type { FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config.js';
import { createRateLimiter, clientIp, type FastifyPreHandlerHook } from './rateLimit.js';

export function buildRateLimitHook(): FastifyPreHandlerHook {
  if (config.RATELIMIT_DISABLED) {
    // No-op so the preHandler chain still runs cleanly.
    return async (_req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
      /* no-op */
    };
  }

  const webhookLimiter = createRateLimiter({
    keyFn: (req) => clientIp(req),
    limit: config.RATELIMIT_WEBHOOK_PER_MIN,
    windowSeconds: 60,
    keyPrefix: 'foodbot:rl:webhook:',
  });
  const chatLimiter = createRateLimiter({
    keyFn: (req) => {
      const body = req.body as { phone?: unknown } | undefined;
      if (body && typeof body.phone === 'string') return `phone:${body.phone}`;
      return clientIp(req);
    },
    limit: config.RATELIMIT_CHAT_PER_MIN,
    windowSeconds: 60,
    keyPrefix: 'foodbot:rl:chat:',
  });

  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (req.method === 'POST' && req.url === '/webhook') {
      // Manually invoke the inner limiter which still accepts (req, reply, next).
      await new Promise<void>((resolve, reject) => {
        webhookLimiter(req, reply, (err?: Error) => (err ? reject(err) : resolve()));
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/api/chat') {
      await new Promise<void>((resolve, reject) => {
        chatLimiter(req, reply, (err?: Error) => (err ? reject(err) : resolve()));
      });
      return;
    }
  };
}
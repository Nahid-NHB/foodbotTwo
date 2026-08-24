/**
 * Redis-backed fixed-window rate limiter for Fastify preHandler hooks.
 *
 * Algorithm: fixed-window counter. Each request increments
 * `${prefix}${key}` in Redis with `INCR`; we also read the TTL so we
 * can return Retry-After on overflow. If the TTL is -1 (first
 * increment of the window), apply `EX windowSeconds`.
 *
 * Fail-open: any Redis error logs a warning and lets the request through.
 * Public endpoints are better served with a partial outage of the
 * limiter than a full outage of the API.
 *
 * NOT a sliding window. For a single-restaurant MVP this is plenty.
 */
import { redis } from '../redis/client.js';
import { logger } from '../logger.js';

export interface RateLimitOptions {
  /** Extract the bucket key from the request. */
  keyFn: (req: {
    ip: string;
    headers: Record<string, string | string[] | undefined>;
    body?: unknown;
  }) => string | undefined;
  /** Max requests per window. */
  limit: number;
  /** Window size in seconds. */
  windowSeconds: number;
  /** Redis key prefix; useful for tests. */
  keyPrefix: string;
}

export type FastifyPreHandlerHook = (
  req: any,
  reply: any,
  next: (err?: Error) => void,
) => Promise<void> | void;

/**
 * Extract a client IP, preferring X-Forwarded-For first hop (Meta's edge
 * sets it). Falls back to the socket IP. Caller is responsible for
 * stripping untrusted hops if behind a multi-hop proxy.
 */
export function clientIp(req: {
  ip: string;
  headers: Record<string, string | string[] | undefined>;
}): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string') {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.ip ?? 'unknown';
}

export function createRateLimiter(opts: RateLimitOptions): FastifyPreHandlerHook {
  return async (req, reply, next) => {
    let key: string | undefined;
    try {
      key = opts.keyFn(req);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'rate-limit key extract failed; failing open',
      );
      return next();
    }
    if (!key) return next();

    const fullKey = `${opts.keyPrefix}${key}`;
    let count: number;
    let ttl: number;
    try {
      const tx = redis.multi();
      tx.incr(fullKey);
      tx.ttl(fullKey);
      const results = await tx.exec();
      if (!results) throw new Error('redis tx returned null');
      const [incrErr, incrVal] = results[0]!;
      const [ttlErr, ttlVal] = results[1]!;
      if (incrErr || ttlErr) throw new Error('redis tx failed');
      count = Number(incrVal);
      ttl = Number(ttlVal);
      // First request in the window: -1 means no TTL set yet. Apply one.
      if (ttl === -1) {
        await redis.expire(fullKey, opts.windowSeconds);
        ttl = opts.windowSeconds;
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'rate-limit redis error; failing open',
      );
      return next();
    }

    if (count > opts.limit) {
      const retryAfter = ttl > 0 ? ttl : opts.windowSeconds;
      reply.code(429);
      reply.header('Retry-After', String(retryAfter));
      return reply.send({ error: 'rate_limited', retry_after_seconds: retryAfter });
    }
    return next();
  };
}

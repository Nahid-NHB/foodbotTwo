import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://foodbot:foodbot@127.0.0.1:5432/foodbot';
  process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
  process.env.GEMINI_API_KEY = 'gemini-test';
  process.env.WHATSAPP_TOKEN = 'tkn';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '123';
  process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = '456';
  process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'verify';
  process.env.WHATSAPP_APP_SECRET = 'secret';
  process.env.RESTAURANT_NAME = 'Hungry Bird';
  process.env.RATELIMIT_DISABLED = 'true'; // don't pollute global bucket
});

import { redis } from '../redis/client.js';
import { createRateLimiter } from './rateLimit.js';

async function flushKeys(prefix: string): Promise<void> {
  const keys = await redis.keys(`${prefix}*`);
  if (keys.length) await redis.del(...keys);
}

describe('createRateLimiter', () => {
  beforeAll(async () => {
    await flushKeys('test:rl:');
  });

  beforeEach(async () => {
    await flushKeys('test:rl:');
  });

  function fakeReq(key: string): { ip: string; headers: Record<string, string> } {
    return { ip: '127.0.0.1', headers: { 'x-forwarded-for': key } };
  }
  function fakeReply(): {
    code: (n: number) => fakeReply;
    header: (k: string, v: string) => fakeReply;
    send: (b: unknown) => unknown;
    _status: number;
    _headers: Record<string, string>;
    _body: unknown;
  } {
    const r: any = { _status: 200, _headers: {} };
    r.code = (n: number) => { r._status = n; return r; };
    r.header = (k: string, v: string) => { r._headers[k.toLowerCase()] = v; return r; };
    r.send = (b: unknown) => { r._body = b; return r; };
    return r;
  }

  it('passes when under the limit and increments the counter', async () => {
    const hook = createRateLimiter({
      keyFn: (req: any) => req.headers['x-forwarded-for'],
      limit: 3,
      windowSeconds: 60,
      keyPrefix: 'test:rl:',
    });
    const req = fakeReq('key-a');
    const reply = fakeReply();
    let nextCalled = false;
    await hook(req, reply, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    expect(reply._status).toBe(200);
    const v = await redis.get('test:rl:key-a');
    expect(v).toBe('1');
  });

  it('returns 429 with Retry-After when the limit is exceeded', async () => {
    const hook = createRateLimiter({
      keyFn: (req: any) => req.headers['x-forwarded-for'],
      limit: 2,
      windowSeconds: 60,
      keyPrefix: 'test:rl:',
    });
    for (let i = 0; i < 2; i++) {
      await hook(fakeReq('key-b'), fakeReply(), () => {});
    }
    const reply = fakeReply();
    let nextCalled = false;
    await hook(fakeReq('key-b'), reply, () => { nextCalled = true; });
    expect(nextCalled).toBe(false);
    expect(reply._status).toBe(429);
    expect(reply._headers['retry-after']).toBeDefined();
    expect(parseInt(reply._headers['retry-after'], 10)).toBeGreaterThan(0);
    expect(reply._body).toMatchObject({ error: 'rate_limited' });
  });

  it('different keys do not collide', async () => {
    const hook = createRateLimiter({
      keyFn: (req: any) => req.headers['x-forwarded-for'],
      limit: 1,
      windowSeconds: 60,
      keyPrefix: 'test:rl:',
    });
    await hook(fakeReq('key-c'), fakeReply(), () => {});
    const reply = fakeReply();
    let nextCalled = false;
    await hook(fakeReq('key-d'), reply, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
  });

  it('fails open on Redis error', async () => {
    const hook = createRateLimiter({
      keyFn: (req: any) => req.headers['x-forwarded-for'],
      limit: 1,
      windowSeconds: 60,
      keyPrefix: 'test:rl:',
    });
    const realMulti = (redis as any).multi.bind(redis);
    (redis as any).multi = () => ({
      incr: () => ({}),
      ttl: () => ({}),
      exec: async () => null,
    });
    try {
      const reply = fakeReply();
      let nextCalled = false;
      await hook(fakeReq('key-e'), reply, () => { nextCalled = true; });
      expect(nextCalled).toBe(true);
    } finally {
      (redis as any).multi = realMulti;
    }
  });

  it('passes through when keyFn returns undefined', async () => {
    const hook = createRateLimiter({
      keyFn: () => undefined,
      limit: 1,
      windowSeconds: 60,
      keyPrefix: 'test:rl:',
    });
    const reply = fakeReply();
    let nextCalled = false;
    await hook(fakeReq('key-f'), reply, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
  });
});
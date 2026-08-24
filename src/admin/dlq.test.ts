import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://foodbot:foodbot@127.0.0.1:5432/foodbot';
  process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
  process.env.GEMINI_API_KEY = 'gemini-test';
  process.env.WHATSAPP_TOKEN = 'EAAtest';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '12345';
  process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = '67890';
  process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'verify';
  process.env.WHATSAPP_APP_SECRET = 'secret';
  process.env.RESTAURANT_NAME = 'Hungry Bird';
  process.env.ADMIN_BASIC_AUTH_USER = 'admin';
  process.env.ADMIN_BASIC_AUTH_PASS = 'secret-pass';
});

import { buildApp } from '../index.js';
import { checkBasicAuth } from './basicAuth.js';

describe('admin routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  // ---------- basicAuth ----------

  describe('checkBasicAuth', () => {
    it('accepts the configured credentials', () => {
      const header =
        'Basic ' + Buffer.from('admin:secret-pass').toString('base64');
      expect(checkBasicAuth(header)).toBe(true);
    });

    it('rejects wrong password', () => {
      const header =
        'Basic ' + Buffer.from('admin:wrong').toString('base64');
      expect(checkBasicAuth(header)).toBe(false);
    });

    it('rejects missing header', () => {
      expect(checkBasicAuth(undefined)).toBe(false);
    });

    it('rejects non-Basic scheme', () => {
      expect(checkBasicAuth('Bearer foo')).toBe(false);
    });

    it('rejects malformed base64 (no colon)', () => {
      const header = 'Basic ' + Buffer.from('nocolon').toString('base64');
      expect(checkBasicAuth(header)).toBe(false);
    });

    it('rejects array headers (defensive)', () => {
      expect(checkBasicAuth(['Basic xyz'])).toBe(false);
    });
  });

  // ---------- /readyz ----------

  describe('GET /readyz', () => {
    it('returns ok:true with both checks passing', async () => {
      const res = await app.inject({ method: 'GET', url: '/readyz' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { ok: boolean; checks: { postgres: { ok: boolean }; redis: { ok: boolean } } };
      expect(body.ok).toBe(true);
      expect(body.checks.postgres.ok).toBe(true);
      expect(body.checks.redis.ok).toBe(true);
    });
  });

  // ---------- /admin/queues/dlq ----------

  describe('GET /admin/queues/dlq', () => {
    it('returns 401 without auth header', async () => {
      const res = await app.inject({ method: 'GET', url: '/admin/queues/dlq' });
      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toMatch(/^Basic/);
    });

    it('returns 401 with wrong credentials', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/queues/dlq',
        headers: { authorization: 'Basic ' + Buffer.from('admin:nope').toString('base64') },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 200 + payload with correct credentials', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/queues/dlq',
        headers: {
          authorization: 'Basic ' + Buffer.from('admin:secret-pass').toString('base64'),
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { total: number; queues: Array<{ queue: string; count: number; jobs: unknown[] }> };
      expect(typeof body.total).toBe('number');
      expect(Array.isArray(body.queues)).toBe(true);
      const names = body.queues.map((q) => q.queue);
      expect(names).toContain('audio.transcribe');
      expect(names).toContain('conversation.process');
      expect(names).toContain('whatsapp.send');
    });
  });
});
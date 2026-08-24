import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

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
});

import { closeRedis, redis } from '../redis/client.js';
import { getCachedTranscript, setCachedTranscript } from './cache.js';

/** Best-effort key cleanup that handles the empty-keylist case. */
async function clearCache(): Promise<void> {
  const keys = await redis.keys('foodbot:transcript:*');
  if (keys.length === 0) return;
  await redis.del(...keys);
}

describe('transcript cache', () => {
  const FIXTURE_MEDIA = 'wamid.test.' + Date.now();

  beforeAll(async () => {
    await clearCache();
  });

  afterAll(async () => {
    await clearCache();
    await closeRedis();
  });

  it('returns null for an unknown media_id', async () => {
    const v = await getCachedTranscript('wamid.does.not.exist.' + Date.now());
    expect(v).toBeNull();
  });

  it('round-trips a transcript through get/set', async () => {
    const transcript = 'দুইটা চিকেন বার্গার দিবেন, একটা চিজ টু প্লেইন';
    await setCachedTranscript(FIXTURE_MEDIA, transcript);
    const v = await getCachedTranscript(FIXTURE_MEDIA);
    expect(v).toBe(transcript);
  });

  it('uses a SHA-256 namespace (no raw media_id leakage)', async () => {
    const mediaId = 'wamid.should-not-appear-verbatim';
    await setCachedTranscript(mediaId, 'hi');
    const keys = await redis.keys('*' + mediaId + '*');
    expect(keys).toEqual([]);
    const hashed = await redis.keys('foodbot:transcript:*');
    expect(hashed.length).toBeGreaterThan(0);
  });

  it('applies a 7-day TTL on set', async () => {
    const id = 'wamid.ttl-test';
    await setCachedTranscript(id, 'ttl body');
    // Find the key regardless of what the hash maps to.
    const keys = await redis.keys('foodbot:transcript:*');
    // At least one key exists with the body; check TTL on it.
    let foundTtl: number | null = null;
    for (const k of keys) {
      const v = await redis.get(k);
      if (v === 'ttl body') {
        foundTtl = await redis.ttl(k);
        break;
      }
    }
    expect(foundTtl).not.toBeNull();
    // TTL in seconds; 7 days = 604800. Allow some slack for clock drift.
    expect(foundTtl!).toBeGreaterThan(604000);
    expect(foundTtl!).toBeLessThanOrEqual(604800);
  });

  it('returns null when media_id is empty', async () => {
    expect(await getCachedTranscript('')).toBeNull();
  });

  it('set is a no-op for empty transcript', async () => {
    // Should not throw and should not write anything.
    await expect(setCachedTranscript('wamid.never', '')).resolves.toBeUndefined();
    expect(await getCachedTranscript('wamid.never')).toBeNull();
  });
});
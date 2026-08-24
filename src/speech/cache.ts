/**
 * Redis-backed SHA-256 transcript cache.
 *
 * WhatsApp voice notes come back as the same `media_id` when Meta ever resends
 * them — replays, retries, webhooks re-deliveries. Same `media_id` = same bytes
 * = same transcript. We cache the transcript by SHA-256(media_id) with a
 * 7-day TTL to skip the network round trip on the second occurrence.
 *
 * `media_id` is the right cache key: it's stable, opaque, and identifying.
 * Hashing it is defensive — keeps the key short and avoids leaking the raw id
 * into logs if someone greps the cache.
 */
import { createHash } from 'node:crypto';
import { redis } from '../redis/client.js';
import { logger } from '../logger.js';

const CACHE_PREFIX = 'foodbot:transcript:';
const TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

function keyFor(mediaId: string): string {
  return `${CACHE_PREFIX}${createHash('sha256').update(mediaId).digest('hex')}`;
}

/**
 * Look up a cached transcript for a WhatsApp media_id.
 *
 * Returns the transcript string if present, null if absent or on Redis error
 * (cache failures must never block the pipeline — fall through to fresh STT).
 */
export async function getCachedTranscript(mediaId: string): Promise<string | null> {
  if (!mediaId) return null;
  try {
    const v = await redis.get(keyFor(mediaId));
    return v ?? null;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'transcript cache get failed');
    return null;
  }
}

/**
 * Store a transcript in cache with a 7-day TTL. Best-effort — logs and
 * swallows on failure.
 */
export async function setCachedTranscript(mediaId: string, transcript: string): Promise<void> {
  if (!mediaId || !transcript) return;
  try {
    await redis.set(keyFor(mediaId), transcript, 'EX', TTL_SECONDS);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'transcript cache set failed');
  }
}
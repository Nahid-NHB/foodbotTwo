/**
 * Worker liveness heartbeats for /healthz.
 *
 * Each worker starts a 10s-interval timer that writes
 * `foodbot:worker:<name>:heartbeat` with a 30s TTL. /healthz reads all
 * the keys and reports per-worker liveness; if any is missing or
 * older than 30s the overall probe returns 503.
 *
 * The 10s refresh is well under the 30s TTL — a single missed tick
 * doesn't take the worker offline.
 */
import { redis } from '../redis/client.js';
import { logger } from '../logger.js';

const HEARTBEAT_KEY = (name: string): string => `foodbot:worker:${name}:heartbeat`;
const REFRESH_MS = 10_000;
const TTL_SECONDS = 30;

export type WorkerStatus = { ok: boolean; ageSeconds?: number; error?: string };

export function startWorkerHeartbeat(workerName: string): () => void {
  let cancelled = false;

  const refresh = async (): Promise<void> => {
    if (cancelled) return;
    try {
      await redis.set(HEARTBEAT_KEY(workerName), Date.now().toString(), 'EX', TTL_SECONDS);
    } catch (err) {
      logger.warn(
        { workerName, err: err instanceof Error ? err.message : String(err) },
        'worker heartbeat set failed',
      );
    }
  };

  // Fire one immediately so /healthz reflects state without waiting.
  void refresh();
  const handle = setInterval(() => { void refresh(); }, REFRESH_MS);
  if (typeof handle.unref === 'function') handle.unref();

  return () => {
    cancelled = true;
    clearInterval(handle);
  };
}

export async function readWorkerHeartbeats(
  workerNames: ReadonlyArray<string>,
): Promise<Record<string, WorkerStatus>> {
  const result: Record<string, WorkerStatus> = {};
  for (const name of workerNames) {
    try {
      const v = await redis.get(HEARTBEAT_KEY(name));
      if (!v) {
        result[name] = { ok: false };
        continue;
      }
      const ageMs = Date.now() - parseInt(v, 10);
      result[name] = { ok: ageMs < TTL_SECONDS * 1000, ageSeconds: Math.round(ageMs / 1000) };
    } catch (err) {
      logger.warn(
        { workerName: name, err: err instanceof Error ? err.message : String(err) },
        'worker heartbeat read failed',
      );
      result[name] = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  return result;
}
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { redis } from '../redis/client.js';
import { startWorkerHeartbeat, readWorkerHeartbeats } from './workerHeartbeat.js';

async function flush(): Promise<void> {
  const keys = await redis.keys('foodbot:worker:*');
  if (keys.length) await redis.del(...keys);
}

describe('worker heartbeat', () => {
  beforeAll(async () => {
    await flush();
  });
  beforeEach(async () => {
    await flush();
  });

  let stop: (() => void) | null = null;
  afterEach(() => {
    if (stop) { stop(); stop = null; }
  });

  it('writes a heartbeat key + 30s TTL on start', async () => {
    stop = startWorkerHeartbeat('audio.transcribe');
    await new Promise((r) => setTimeout(r, 50));
    const ttl = await redis.ttl('foodbot:worker:audio.transcribe:heartbeat');
    expect(ttl).toBeGreaterThan(20);
    expect(ttl).toBeLessThanOrEqual(30);
  });

  it('stops writing on stop()', async () => {
    stop = startWorkerHeartbeat('conversation.process');
    await new Promise((r) => setTimeout(r, 50));
    stop();
    await redis.del('foodbot:worker:conversation.process:heartbeat');
    await new Promise((r) => setTimeout(r, 200));
    const v = await redis.get('foodbot:worker:conversation.process:heartbeat');
    expect(v).toBeNull();
  });

  it('readWorkerHeartbeats reports ok:true when the key is fresh', async () => {
    stop = startWorkerHeartbeat('whatsapp.send');
    await new Promise((r) => setTimeout(r, 50));
    const r = await readWorkerHeartbeats(['whatsapp.send']);
    expect(r['whatsapp.send'].ok).toBe(true);
  });

  it('readWorkerHeartbeats reports ok:false when the key is missing', async () => {
    await flush();
    const r = await readWorkerHeartbeats(['audio.transcribe', 'conversation.process', 'whatsapp.send']);
    expect(r['audio.transcribe'].ok).toBe(false);
    expect(r['conversation.process'].ok).toBe(false);
    expect(r['whatsapp.send'].ok).toBe(false);
  });
});
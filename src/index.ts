import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { config } from './config.js';
import { logger } from './logger.js';
import db from './db/client.js';
import { redis } from './redis/client.js';
import { registerWebhook } from './webhook/router.js';
import { registerChatRoute } from './web/chatRoute.js';
import { registerAdminRoutes } from './admin/dlq.js';
import { requestIdHook } from './middleware/requestId.js';
import { buildRateLimitHook } from './middleware/wireRateLimit.js';
import { readWorkerHeartbeats } from './middleware/workerHeartbeat.js';

// Fastify's strict logger typing clashes with our pino logger. Use a loose
// alias for the return type so we don't have to fight the type system.
export type App = Awaited<ReturnType<typeof buildAppRaw>>;

async function buildAppRaw() {
  const app = Fastify({
    logger: logger as never,
    disableRequestLogging: false,
    bodyLimit: 10 * 1024 * 1024, // Meta voice messages can be large
  });

  // Parse application/json ourselves so we can keep the raw bytes for signature
  // verification. The parsed JSON is stored on req.body; the raw buffer on
  // req.rawBody.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body, done) => {
      (req as FastifyRequest & { rawBody?: Buffer }).rawBody = body as Buffer;
      if ((body as Buffer).length === 0) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse((body as Buffer).toString('utf8')));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  // Request-id propagation runs first so every subsequent log line in the
  // request lifecycle carries the correlation id.
  app.addHook('onRequest', requestIdHook);
  // Per-route rate limit; no-op when RATELIMIT_DISABLED=true (tests, local dev).
  app.addHook('preHandler', buildRateLimitHook());

  app.get('/healthz', async (_req, reply) => {
    const workers = await readWorkerHeartbeats([
      'audio.transcribe',
      'conversation.process',
      'whatsapp.send',
    ]);
    const allOk = Object.values(workers).every((w) => w.ok);
    return reply.code(allOk ? 200 : 503).send({ ok: allOk, workers });
  });

  // Real readiness probe: SELECT 1 against Postgres + PING against Redis.
  // Returns 503 with detail when either is unreachable so an orchestrator
  // (k8s, ECS, load balancer) can take the pod out of rotation.
  app.get('/readyz', async (_req, reply) => {
    const checks: Record<string, { ok: boolean; error?: string }> = {
      postgres: { ok: false },
      redis: { ok: false },
    };
    try {
      await db.query('SELECT 1');
      checks.postgres.ok = true;
    } catch (err) {
      checks.postgres.error = err instanceof Error ? err.message : String(err);
    }
    try {
      const pong = await redis.ping();
      checks.redis.ok = pong === 'PONG';
      if (!checks.redis.ok) checks.redis.error = `unexpected reply: ${pong}`;
    } catch (err) {
      checks.redis.error = err instanceof Error ? err.message : String(err);
    }
    const allOk = Object.values(checks).every((c) => c.ok);
    return reply.code(allOk ? 200 : 503).send({ ok: allOk, checks });
  });

  // CORS for the local Next.js UI in dev. Restrict to loopback so the chat
  // route isn't reachable from arbitrary origins. Production should put the
  // UI behind the same origin via the Next.js rewrite proxy.
  await app.register(cors, {
    origin: ['http://127.0.0.1:3001', 'http://localhost:3001'],
    methods: ['POST', 'GET', 'OPTIONS'],
    credentials: false,
  });

  await registerWebhook(app as never);
  await registerChatRoute(app as never);
  await registerAdminRoutes(app as never);

  return app;
}

export async function buildApp(): Promise<App> {
  return buildAppRaw();
}

async function main(): Promise<void> {
  const app = await buildApp();
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  logger.info({ port: config.PORT }, 'server listening');

  const { createWorkers } = await import('./queue/index.js');
  const workers = createWorkers();
  logger.info('workers started');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    try {
      await workers.close();
      await app.close();
      const { closeDb } = await import('./db/client.js');
      const { closeRedis } = await import('./redis/client.js');
      const { closeQueues } = await import('./queue/index.js');
      await closeQueues();
      await closeRedis();
      await closeDb();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main().catch((err) => {
    logger.fatal({ err }, 'fatal boot error');
    process.exit(1);
  });
}
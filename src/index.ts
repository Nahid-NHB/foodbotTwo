import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { config } from './config.js';
import { logger } from './logger.js';
import { registerWebhook } from './webhook/router.js';
import { registerChatRoute } from './web/chatRoute.js';

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

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async () => ({ ok: true }));

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
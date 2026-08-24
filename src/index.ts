import Fastify from 'fastify';
import { config } from './config.js';
import { logger } from './logger.js';

export async function buildApp() {
  // Fastify requires its own base logger shape; reuse our pino instance but cast.
  const app = Fastify({
    logger: logger as never,
    disableRequestLogging: false,
    bodyLimit: 10 * 1024 * 1024, // Meta voice messages can be large
  });

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async () => ({ ok: true }));

  return app;
}

async function main(): Promise<void> {
  const app = await buildApp();
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  logger.info({ port: config.PORT }, 'server listening');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    try {
      await app.close();
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
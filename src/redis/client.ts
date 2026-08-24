import Redis from 'ioredis';
import { config } from '../config.js';
import { logger } from '../logger.js';

export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null, // BullMQ requires this
  enableReadyCheck: true,
  lazyConnect: false,
});

redis.on('error', (err) => logger.error({ err }, 'redis error'));
redis.on('ready', () => logger.info('redis ready'));

export async function closeRedis(): Promise<void> {
  await redis.quit();
}
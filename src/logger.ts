import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.LOG_LEVEL,
  base: { app: 'foodbot', env: config.NODE_ENV },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = typeof logger;
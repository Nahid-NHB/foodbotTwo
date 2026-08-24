import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const REQUIRED_KEYS = [
  'DATABASE_URL',
  'REDIS_URL',
  'OPENAI_API_KEY',
  'WHATSAPP_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_BUSINESS_ACCOUNT_ID',
  'WHATSAPP_WEBHOOK_VERIFY_TOKEN',
  'WHATSAPP_APP_SECRET',
  'RESTAURANT_NAME',
];

const OPTIONAL_KEYS = [
  'NODE_ENV',
  'PORT',
  'LOG_LEVEL',
  'WHISPER_MODEL',
  'LLM_MODEL',
  'LLM_DAILY_TOKEN_BUDGET',
  'RESTAURANT_DEFAULT_DELIVERY_FEE_PAISA',
  'ADMIN_BASIC_AUTH_USER',
  'ADMIN_BASIC_AUTH_PASS',
];

function setBaseEnv() {
  for (const k of [...REQUIRED_KEYS, ...OPTIONAL_KEYS]) delete process.env[k];
  process.env.DATABASE_URL = 'postgres://foodbot:foodbot@localhost:5432/foodbot';
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.WHATSAPP_TOKEN = 'tkn';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '123';
  process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = '456';
  process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'verify';
  process.env.WHATSAPP_APP_SECRET = 'secret';
  process.env.RESTAURANT_NAME = 'Hungry Bird';
}

describe('logger', () => {
  beforeAll(() => {
    setBaseEnv();
    vi.resetModules();
  });

  it('is a pino logger with a level', async () => {
    const { logger } = await import('./logger.js');
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.child).toBe('function');
    expect(logger.levels.values).toBeDefined();
  });

  it('child loggers carry context', async () => {
    const { logger } = await import('./logger.js');
    const child = logger.child({ request_id: 'abc' });
    expect(child.bindings()).toMatchObject({ request_id: 'abc' });
  });
});
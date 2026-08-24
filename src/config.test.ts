import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const REQUIRED_KEYS = [
  'DATABASE_URL',
  'REDIS_URL',
  'GEMINI_API_KEY',
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
  'LLM_MODEL',
  'LLM_DAILY_TOKEN_BUDGET',
  'RESTAURANT_DEFAULT_DELIVERY_FEE_PAISA',
  'ADMIN_BASIC_AUTH_USER',
  'ADMIN_BASIC_AUTH_PASS',
  'RATELIMIT_WEBHOOK_PER_MIN',
  'RATELIMIT_CHAT_PER_MIN',
  'RATELIMIT_DISABLED',
];

function resetEnv() {
  for (const k of [...REQUIRED_KEYS, ...OPTIONAL_KEYS]) delete process.env[k];
}

function setBaseEnv() {
  resetEnv();
  process.env.DATABASE_URL = 'postgres://foodbot:foodbot@localhost:5432/foodbot';
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.GEMINI_API_KEY = 'gemini-test';
  process.env.WHATSAPP_TOKEN = 'tkn';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '123';
  process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = '456';
  process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'verify';
  process.env.WHATSAPP_APP_SECRET = 'secret';
  process.env.RESTAURANT_NAME = 'Hungry Bird';
}

async function loadConfig() {
  vi.resetModules();
  return import('./config.js');
}

describe('config', () => {
  beforeEach(() => setBaseEnv());
  afterEach(() => resetEnv());

  it('loads valid env with defaults', async () => {
    const mod = await loadConfig();
    expect(mod.config.RESTAURANT_NAME).toBe('Hungry Bird');
    expect(mod.config.PORT).toBe(3000);
    expect(mod.config.LOG_LEVEL).toBe('info');
    expect(mod.config.LLM_MODEL).toBe('gemini-3.6-flash');
  });

  it('throws on missing required env', async () => {
    delete process.env.GEMINI_API_KEY;
    await expect(loadConfig()).rejects.toThrow(/GEMINI_API_KEY/);
  });

  it('coerces numeric env vars', async () => {
    process.env.PORT = '8080';
    process.env.RESTAURANT_DEFAULT_DELIVERY_FEE_PAISA = '1234';
    const mod = await loadConfig();
    expect(mod.config.PORT).toBe(8080);
    expect(mod.config.RESTAURANT_DEFAULT_DELIVERY_FEE_PAISA).toBe(1234);
  });

  it('exposes rate-limit defaults', async () => {
    const mod = await loadConfig();
    expect(mod.config.RATELIMIT_WEBHOOK_PER_MIN).toBe(30);
    expect(mod.config.RATELIMIT_CHAT_PER_MIN).toBe(20);
    expect(mod.config.RATELIMIT_DISABLED).toBe(false);
  });

  it('coerces RATELIMIT_DISABLED=true and per-min caps', async () => {
    process.env.RATELIMIT_DISABLED = 'true';
    process.env.RATELIMIT_WEBHOOK_PER_MIN = '5';
    process.env.RATELIMIT_CHAT_PER_MIN = '2';
    const mod = await loadConfig();
    expect(mod.config.RATELIMIT_DISABLED).toBe(true);
    expect(mod.config.RATELIMIT_WEBHOOK_PER_MIN).toBe(5);
    expect(mod.config.RATELIMIT_CHAT_PER_MIN).toBe(2);
  });
});
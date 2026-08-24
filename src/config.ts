import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  GEMINI_API_KEY: z.string().min(1),
  LLM_MODEL: z.string().default('gemini-3.6-flash'),
  LLM_DAILY_TOKEN_BUDGET: z.coerce.number().int().positive().default(500_000),

  WHATSAPP_TOKEN: z.string().min(1),
  WHATSAPP_PHONE_NUMBER_ID: z.string().min(1),
  WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().min(1),
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: z.string().min(1),
  WHATSAPP_APP_SECRET: z.string().min(1),

  RESTAURANT_NAME: z.string().min(1),
  RESTAURANT_DEFAULT_DELIVERY_FEE_PAISA: z.coerce.number().int().nonnegative().default(0),

  ADMIN_BASIC_AUTH_USER: z.string().default('admin'),
  ADMIN_BASIC_AUTH_PASS: z.string().default('changeme'),

  RATELIMIT_WEBHOOK_PER_MIN: z.coerce.number().int().positive().default(30),
  RATELIMIT_CHAT_PER_MIN: z.coerce.number().int().positive().default(20),
  RATELIMIT_DISABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export type Config = z.infer<typeof schema>;

function parse(): Config {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const config: Config = parse();
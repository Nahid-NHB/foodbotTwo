import { describe, it, expect, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://foodbot:foodbot@127.0.0.1:5432/foodbot';
  process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.WHATSAPP_TOKEN = 'tkn';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '123';
  process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = '456';
  process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'verify';
  process.env.WHATSAPP_APP_SECRET = 'secret';
  process.env.RESTAURANT_NAME = 'Hungry Bird';
});

import db, { closeDb } from '../db/client.js';
import { findOrCreateByPhone, getById, update } from './service.js';
import { normalizePhone } from '../common/id.js';
import { CustomerNotFoundError } from '../common/errors.js';

const TEST_PHONE = '+8801700009999';

describe('customer service', () => {
  afterAll(async () => {
    await db.query(`DELETE FROM customers WHERE phone_e164 = $1`, [TEST_PHONE]);
    await closeDb();
  });

  it('findOrCreateByPhone creates a new customer', async () => {
    const c = await findOrCreateByPhone(TEST_PHONE);
    expect(c.phone_e164).toBe(TEST_PHONE);
    expect(c.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('findOrCreateByPhone returns the same id on second call', async () => {
    const a = await findOrCreateByPhone(TEST_PHONE);
    const b = await findOrCreateByPhone(TEST_PHONE);
    expect(a.id).toBe(b.id);
  });

  it('update sets name, address, payment_method', async () => {
    const a = await findOrCreateByPhone(TEST_PHONE);
    const updated = await update(a.id, {
      name: 'Rahim',
      default_address: 'Banani, Dhaka',
      payment_method: 'cod',
    });
    expect(updated.name).toBe('Rahim');
    expect(updated.default_address).toBe('Banani, Dhaka');
    expect(updated.payment_method).toBe('cod');
  });

  it('update with empty patch is a no-op', async () => {
    const a = await findOrCreateByPhone(TEST_PHONE);
    const updated = await update(a.id, {});
    expect(updated.id).toBe(a.id);
  });

  it('getById throws CustomerNotFoundError for unknown id', async () => {
    await expect(getById('00000000-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(
      CustomerNotFoundError,
    );
  });

  it('normalizePhone returns E.164', () => {
    expect(normalizePhone('01712345678')).toBe('+8801712345678');
  });
});
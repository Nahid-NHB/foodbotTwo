import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://foodbot:foodbot@127.0.0.1:5432/foodbot';
  process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
  process.env.GEMINI_API_KEY = 'gemini-test';
  process.env.WHATSAPP_TOKEN = 'tkn';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '123';
  process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = '456';
  process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'verify';
  process.env.WHATSAPP_APP_SECRET = 'secret';
  process.env.RESTAURANT_NAME = 'Hungry Bird';
});

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import db, { pool, closeDb } from './client.js';
import { seed } from './seed.js';
import { findOrCreateByPhone } from '../customer/service.js';

const here = dirname(fileURLToPath(import.meta.url));
const idsPath = join(here, '..', '..', 'data', 'menu-ids.json');

type Ids = {
  restaurant: Record<string, string>;
};

let ids: Ids;
let restaurantId: string;
const BACKFILL_PHONE = '+8801700000999';
let backfillCustomerId: string;
const BACKFILL_ADDRESS = 'House 1, Road 2, Dhanmondi, Dhaka';

describe('seed: delivery zones + customer_addresses backfill', () => {
  beforeAll(async () => {
    if (!existsSync(idsPath)) await seed();
    ids = JSON.parse(readFileSync(idsPath, 'utf8')) as Ids;
    restaurantId = ids.restaurant['hungry_bird']!;

    // Ensure zones + addons are present by re-running seed (idempotent).
    await seed();

    // Create a customer and set a default_address so the backfill path
    // has something to work on. Use a phone not taken by other tests.
    const c = await findOrCreateByPhone(BACKFILL_PHONE);
    backfillCustomerId = c.id;
    await pool.query(
      `UPDATE customers SET default_address = $1, updated_at = now()
       WHERE id = $2 AND default_address IS NULL`,
      [BACKFILL_ADDRESS, backfillCustomerId],
    );

    // Wipe any pre-existing customer_addresses row for this customer so the
    // backfill is guaranteed to be the one that inserts.
    await pool.query(
      `DELETE FROM customer_addresses WHERE customer_id = $1`,
      [backfillCustomerId],
    );

    // Re-run the seed; the backfill INSERT must run and produce a row.
    await seed();
  });

  afterAll(async () => {
    // Clean up so this test is repeatable without leaving residue.
    await pool.query(`DELETE FROM customer_addresses WHERE customer_id = $1`, [backfillCustomerId]);
    await pool.query(`DELETE FROM customers WHERE id = $1`, [backfillCustomerId]);
    await closeDb();
  });

  it('seeds exactly three delivery zones for the restaurant', async () => {
    const rows = await db.query<{ name: string }>(
      `SELECT name FROM delivery_zones
       WHERE restaurant_id = $1 AND is_active = true`,
      [restaurantId],
    );
    const names = rows.map((r) => r.name).sort();
    expect(names).toEqual(['Dhanmondi', 'Mirpur', 'Mohammadpur']);
  });

  it('backfills customer_addresses for customers with default_address', async () => {
    const rows = await db.query<{ line1: string; zone_id: string | null; is_default: boolean }>(
      `SELECT line1, zone_id, is_default
       FROM customer_addresses
       WHERE customer_id = $1`,
      [backfillCustomerId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.line1).toBe(BACKFILL_ADDRESS);
    expect(rows[0]!.zone_id).toBeNull();
    expect(rows[0]!.is_default).toBe(true);
  });
});

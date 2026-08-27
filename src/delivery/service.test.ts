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

import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import db, { closeDb } from '../db/client.js';
import { seed } from '../db/seed.js';
import { listActiveZones, getDefaultAddress, setAddress } from './service.js';
import { ToolError } from '../common/errors.js';

const here = dirname(fileURLToPath(import.meta.url));
const idsPath = join(here, '..', '..', 'data', 'menu-ids.json');

type Ids = {
  restaurant: Record<string, string>;
  item: Record<string, string>;
  variant: Record<string, string>;
  addon: Record<string, string>;
};

let ids: Ids;
let restaurantId: string;
let customerId: string;
let zoneId: string;
let firstAddressId: string;

describe('delivery service (integration)', () => {
  beforeAll(async () => {
    if (!existsSync(idsPath)) await seed();
    ids = JSON.parse(readFileSync(idsPath, 'utf8')) as Ids;
    restaurantId = ids.restaurant['hungry_bird']!;

    const zoneRows = await db.query<{ id: string }>(
      `SELECT id FROM delivery_zones WHERE restaurant_id = $1 AND name = 'Dhanmondi' LIMIT 1`,
      [restaurantId],
    );
    const z = zoneRows[0];
    if (!z) throw new Error('Dhanmondi zone not seeded');
    zoneId = z.id;

    const custRows = await db.query<{ id: string }>(
      `INSERT INTO customers (id, phone_e164) VALUES (gen_random_uuid(), $1) RETURNING id`,
      ['+8801700000777'],
    );
    const c = custRows[0];
    if (!c) throw new Error('customer insert failed');
    customerId = c.id;
  });

  afterAll(async () => {
    await db.query(`DELETE FROM customer_addresses WHERE customer_id = $1`, [customerId]);
    await db.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
    await closeDb();
  });

  it('listActiveZones returns only active zones for the restaurant, sorted by eta_minutes ASC', async () => {
    const zones = await listActiveZones(restaurantId);
    // Filter to seeded zones of interest (seed includes three: Dhanmondi, Mohammadpur, Mirpur).
    const names = zones.map((z) => z.name);
    const idxDhan = names.indexOf('Dhanmondi');
    const idxMoh = names.indexOf('Mohammadpur');
    const idxMir = names.indexOf('Mirpur');
    expect(idxDhan).toBeGreaterThanOrEqual(0);
    expect(idxMoh).toBeGreaterThanOrEqual(0);
    expect(idxMir).toBeGreaterThanOrEqual(0);
    // Sorted by eta_minutes ASC -> Dhanmondi (30) before Mohammadpur (35) before Mirpur (45)
    expect(idxDhan).toBeLessThan(idxMoh);
    expect(idxMoh).toBeLessThan(idxMir);
    for (const z of zones) {
      expect(z.is_active).toBe(true);
      expect(z.restaurant_id).toBe(restaurantId);
    }
  });

  it('setAddress creates a default address, then a second call flips the first to false', async () => {
    const first = await setAddress(customerId, { zone_id: zoneId, line1: 'House 1' });
    expect(first.is_default).toBe(true);
    expect(first.line1).toBe('House 1');
    expect(first.zone_id).toBe(zoneId);
    expect(first.customer_id).toBe(customerId);
    firstAddressId = first.id;

    const second = await setAddress(customerId, {
      zone_id: zoneId,
      line1: 'House 2',
      note_for_rider: 'Ring twice',
    });
    expect(second.is_default).toBe(true);
    expect(second.note_for_rider).toBe('Ring twice');
    expect(second.line1).toBe('House 2');

    const def = await getDefaultAddress(customerId);
    expect(def).not.toBeNull();
    expect(def!.id).toBe(second.id);
    expect(def!.is_default).toBe(true);
    expect(def!.note_for_rider).toBe('Ring twice');

    const firstRow = await db.query<{ is_default: boolean }>(
      `SELECT is_default FROM customer_addresses WHERE id = $1`,
      [firstAddressId],
    );
    expect(firstRow[0]!.is_default).toBe(false);
  });

  it('setAddress throws ToolError with code zone_not_found for an unknown zone', async () => {
    await expect(
      setAddress(customerId, { zone_id: randomUUID(), line1: 'Some place' }),
    ).rejects.toBeInstanceOf(ToolError);

    await expect(
      setAddress(customerId, { zone_id: randomUUID(), line1: 'Some place' }),
    ).rejects.toMatchObject({ code: 'zone_not_found' });
  });
});
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

import { closeDb } from '../db/client.js';
import { closeRedis, redis } from '../redis/client.js';
import { seed } from '../db/seed.js';
import { findOrCreateByPhone } from '../customer/service.js';
import {
  getOrCreate,
  getCart,
  setCart,
  clearCart,
  transitionTo,
  getById,
} from './service.js';
import { redis as redisModule } from '../redis/client.js';
import type { CartItem } from '../cart/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const idsPath = join(here, '..', '..', 'data', 'menu-ids.json');

type Ids = { restaurant: Record<string, string> };

describe('conversation service (integration)', () => {
  let restaurantId: string;
  let customerId: string;
  const TEST_PHONE = '+8801700007777';

  beforeAll(async () => {
    if (!existsSync(idsPath)) await seed();
    const ids = JSON.parse(readFileSync(idsPath, 'utf8')) as Ids;
    restaurantId = ids.restaurant['hungry_bird']!;
    const c = await findOrCreateByPhone(TEST_PHONE);
    customerId = c.id;
  });

  afterAll(async () => {
    // Cleanup: drop any rows for this test customer.
    await redisModule.del(`customer:${TEST_PHONE}`);
    await closeDb();
    await closeRedis();
  });

  it('getOrCreate creates a new conversation', async () => {
    const conv = await getOrCreate(customerId, restaurantId);
    expect(conv.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(conv.state).toBe('idle');
    expect(conv.cart).toEqual([]);
  });

  it('getOrCreate returns the same conversation on second call', async () => {
    const a = await getOrCreate(customerId, restaurantId);
    const b = await getOrCreate(customerId, restaurantId);
    expect(a.id).toBe(b.id);
  });

  it('setCart persists to Redis and DB snapshot', async () => {
    const conv = await getOrCreate(customerId, restaurantId);
    const line: CartItem = {
      menu_item_id: 'm1',
      name: 'Coke',
      quantity: 2,
      unit_price_paisa: 5000,
      addon_ids: [],
      addons: [],
      line_total_paisa: 10000,
    };
    await setCart(conv.id, [line]);

    const fromRedis = await getCart(conv.id);
    expect(fromRedis).toEqual([line]);

    // TTL set (between 1 and 2 hours)
    const ttl = await redis.ttl(`cart:${conv.id}`);
    expect(ttl).toBeGreaterThan(60 * 60);
    expect(ttl).toBeLessThanOrEqual(2 * 60 * 60);

    // DB snapshot persisted
    const c = await getById(conv.id);
    expect(c?.cart).toEqual([line]);
  });

  it('clearCart empties redis and db snapshot', async () => {
    const conv = await getOrCreate(customerId, restaurantId);
    await clearCart(conv.id);
    expect(await getCart(conv.id)).toEqual([]);
    const c = await getById(conv.id);
    expect(c?.cart).toEqual([]);
  });

  it('transitionTo updates state', async () => {
    const conv = await getOrCreate(customerId, restaurantId);
    await transitionTo(conv.id, 'ordering');
    const c = await getById(conv.id);
    expect(c?.state).toBe('ordering');

    await transitionTo(conv.id, 'awaiting_confirmation');
    const c2 = await getById(conv.id);
    expect(c2?.state).toBe('awaiting_confirmation');
  });

  it('transitionTo rejects invalid transitions', async () => {
    const conv = await getOrCreate(customerId, restaurantId);
    // Currently awaiting_confirmation (from previous test)
    await expect(transitionTo(conv.id, 'idle')).resolves.toBeUndefined(); // allowed
    await expect(transitionTo(conv.id, 'awaiting_confirmation')).rejects.toThrow();
  });
});
import { describe, it, expect, afterAll, beforeAll, beforeEach, afterEach, vi } from 'vitest';

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
import { randomUUID } from 'node:crypto';

import db, { closeDb } from '../db/client.js';
import { seed } from '../db/seed.js';
import { revalidateItems } from './menuRevalidator.js';
import {
  MenuItemNotFoundError,
  MenuItemUnavailableError,
} from '../common/errors.js';
import type { OrderItemSnapshot } from './types.js';

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
let chickenBurgerId: string;
let cheeseAddonId: string;

describe('menuRevalidator (integration)', () => {
  beforeAll(async () => {
    if (!existsSync(idsPath)) await seed();
    ids = JSON.parse(readFileSync(idsPath, 'utf8')) as Ids;
    restaurantId = ids.restaurant['hungry_bird']!;
    chickenBurgerId = ids.item['chicken_burger']!;
    cheeseAddonId = ids.addon['chicken_burger_cheese']!;
  });

  afterAll(async () => {
    await closeDb();
  });

  beforeEach(async () => {
    // Ensure item is available before each test
    await db.query(
      `UPDATE menu_items SET is_available = true WHERE id = $1 AND restaurant_id = $2`,
      [chickenBurgerId, restaurantId],
    );
  });

  afterEach(async () => {
    // Restore availability after each test
    await db.query(
      `UPDATE menu_items SET is_available = true WHERE id = $1 AND restaurant_id = $2`,
      [chickenBurgerId, restaurantId],
    );
  });

  function line(overrides: Partial<OrderItemSnapshot> = {}): OrderItemSnapshot {
    return {
      menu_item_id: chickenBurgerId,
      name: 'Chicken Burger',
      quantity: 2,
      unit_price_paisa: 999, // intentionally wrong, server recomputes
      addon_ids: [],
      addons: [],
      line_total_paisa: 999,
      ...overrides,
    };
  }

  it('recomputes totals from live menu (item + addon, qty 2)', async () => {
    const out = await revalidateItems(restaurantId, [
      line({
        addon_ids: [cheeseAddonId],
      }),
    ]);
    expect(out).toHaveLength(1);
    const snapshot = out[0]!;
    // chicken_burger 18000 + cheese_addon 3000 = 21000 unit
    expect(snapshot.unit_price_paisa).toBe(21000);
    // 21000 * qty 2 = 42000
    expect(snapshot.line_total_paisa).toBe(42000);
    expect(snapshot.name).toBe('Chicken Burger');
    expect(snapshot.quantity).toBe(2);
    expect(snapshot.addons).toHaveLength(1);
    expect(snapshot.addons[0]!.id).toBe(cheeseAddonId);
  });

  it('throws MenuItemUnavailableError when item is marked unavailable', async () => {
    await db.query(
      `UPDATE menu_items SET is_available = false WHERE id = $1 AND restaurant_id = $2`,
      [chickenBurgerId, restaurantId],
    );
    await expect(revalidateItems(restaurantId, [line()])).rejects.toBeInstanceOf(
      MenuItemUnavailableError,
    );
  });

  it('throws MenuItemNotFoundError when menu_item_id does not exist', async () => {
    const fakeId = randomUUID();
    await expect(
      revalidateItems(restaurantId, [line({ menu_item_id: fakeId })]),
    ).rejects.toBeInstanceOf(MenuItemNotFoundError);
  });
});

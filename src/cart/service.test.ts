import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

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

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { closeDb } from '../db/client.js';
import { seed } from '../db/seed.js';
import {
  calculateTotal,
  addItem,
  updateQuantity,
  removeItem,
  snapshot,
  assertNonEmpty,
} from './service.js';
import type { CartItem } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));
const idsPath = join(here, '..', '..', 'data', 'menu-ids.json');

type Ids = {
  restaurant: Record<string, string>;
  item: Record<string, string>;
  variant: Record<string, string>;
  addon: Record<string, string>;
};

function makeItem(overrides: Partial<CartItem> = {}): CartItem {
  return {
    menu_item_id: 'm1',
    name: 'Chicken Burger',
    quantity: 2,
    unit_price_paisa: 18000,
    addon_ids: [],
    addons: [],
    line_total_paisa: 36000,
    ...overrides,
  };
}

describe('cart service (pure functions)', () => {
  it('calculateTotal sums line totals + delivery fee', () => {
    const items = [makeItem({ line_total_paisa: 36000 }), makeItem({ menu_item_id: 'm2', name: 'Coke', unit_price_paisa: 5000, quantity: 1, line_total_paisa: 5000 })];
    const cart = calculateTotal(items, 6000);
    expect(cart.subtotal_paisa).toBe(41000);
    expect(cart.delivery_fee_paisa).toBe(6000);
    expect(cart.total_paisa).toBe(47000);
  });

  it('calculateTotal handles empty items', () => {
    const cart = calculateTotal([], 0);
    expect(cart.subtotal_paisa).toBe(0);
    expect(cart.total_paisa).toBe(0);
  });

  it('addItem merges identical lines', () => {
    const a = makeItem({ menu_item_id: 'm1', quantity: 2, unit_price_paisa: 18000, line_total_paisa: 36000 });
    const b = makeItem({ menu_item_id: 'm1', quantity: 1, unit_price_paisa: 18000, line_total_paisa: 18000 });
    const result = addItem([a], b);
    expect(result).toHaveLength(1);
    expect(result[0]!.quantity).toBe(3);
    expect(result[0]!.line_total_paisa).toBe(54000);
  });

  it('addItem keeps different variants separate', () => {
    const small = makeItem({ menu_item_id: 'pizza', variant_id: 'vs', variant_name: 'Small', variant_price_paisa: 30000, unit_price_paisa: 30000, line_total_paisa: 30000 });
    const large = makeItem({ menu_item_id: 'pizza', variant_id: 'vl', variant_name: 'Large', variant_price_paisa: 70000, unit_price_paisa: 70000, line_total_paisa: 70000 });
    const result = addItem([small], large);
    expect(result).toHaveLength(2);
  });

  it('addItem keeps different add-ons separate', () => {
    const plain = makeItem({ menu_item_id: 'm1', addon_ids: [] });
    const cheese = makeItem({ menu_item_id: 'm1', addon_ids: ['ad1'], unit_price_paisa: 21000, line_total_paisa: 21000 });
    const result = addItem([plain], cheese);
    expect(result).toHaveLength(2);
  });

  it('updateQuantity increases quantity', () => {
    const item = makeItem();
    const result = updateQuantity([item], { menu_item_id: 'm1', quantity: 5 });
    expect(result[0]!.quantity).toBe(5);
    expect(result[0]!.line_total_paisa).toBe(90000);
  });

  it('updateQuantity with quantity 0 removes the line', () => {
    const a = makeItem({ menu_item_id: 'a' });
    const b = makeItem({ menu_item_id: 'b' });
    const result = updateQuantity([a, b], { menu_item_id: 'a', quantity: 0 });
    expect(result).toHaveLength(1);
    expect(result[0]!.menu_item_id).toBe('b');
  });

  it('removeItem removes matching line', () => {
    const a = makeItem({ menu_item_id: 'a' });
    const b = makeItem({ menu_item_id: 'b' });
    const result = removeItem([a, b], 'a');
    expect(result).toHaveLength(1);
    expect(result[0]!.menu_item_id).toBe('b');
  });

  it('snapshot returns a copy, not the original reference', () => {
    const items = [makeItem()];
    const cart = snapshot(items, 0);
    expect(cart.items).not.toBe(items);
    cart.items[0]!.quantity = 99;
    expect(items[0]!.quantity).toBe(2);
  });

  it('assertNonEmpty throws on empty cart', () => {
    expect(() => assertNonEmpty([])).toThrow();
  });
});

describe('cart service (integration)', () => {
  let ids: Ids;

  beforeAll(async () => {
    if (!existsSync(idsPath)) await seed();
    ids = JSON.parse(readFileSync(idsPath, 'utf8')) as Ids;
  });
  afterAll(async () => {
    await closeDb();
  });

  const restaurantId = (): string => ids.restaurant['hungry_bird']!;

  it('buildSnapshotLine snapshot equals current menu price at time of call', async () => {
    const { __test } = await import('./service.js');
    const line = await __test.buildSnapshotLine(restaurantId(), {
      menu_item_id: ids.item['chicken_burger']!,
      quantity: 2,
    });
    expect(line.name).toBe('Chicken Burger');
    expect(line.unit_price_paisa).toBe(18000);
    expect(line.line_total_paisa).toBe(36000);
    expect(line.quantity).toBe(2);
  });
});
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? 'postgres://foodbot:foodbot@127.0.0.1:5432/foodbot';
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
import { seed } from '../db/seed.js';
import {
  searchMenu,
  getItemDetails,
  checkAvailability,
  requireItemPrice,
  listRestaurantItems,
} from './service.js';
import { MenuItemNotFoundError, MenuItemUnavailableError } from '../common/errors.js';

const here = dirname(fileURLToPath(import.meta.url));
const idsPath = join(here, '..', '..', 'data', 'menu-ids.json');

type Ids = {
  restaurant: Record<string, string>;
  item: Record<string, string>;
  variant: Record<string, string>;
  addon: Record<string, string>;
};
let ids: Ids;

describe('menu service (integration)', () => {
  beforeAll(async () => {
    if (!existsSync(idsPath)) {
      await seed();
    }
    ids = JSON.parse(readFileSync(idsPath, 'utf8')) as Ids;
  });

  afterAll(async () => {
    await closeDb();
  });

  const restaurantId = (): string => ids.restaurant['hungry_bird']!;

  it('searchMenu with no query returns available items', async () => {
    const results = await searchMenu(restaurantId());
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.is_available)).toBe(true);
  });

  it('searchMenu matches by banglish alias', async () => {
    const results = await searchMenu(restaurantId(), 'ckn burger');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.name).toBe('Chicken Burger');
  });

  it('searchMenu matches by Bangla', async () => {
    const results = await searchMenu(restaurantId(), 'চিকেন');
    expect(results.length).toBeGreaterThan(0);
  });

  it('searchMenu matches by single english word "coke"', async () => {
    const results = await searchMenu(restaurantId(), 'coke');
    expect(results.some((r) => r.name === 'Coke')).toBe(true);
  });

  it('getItemDetails returns item + variants + addons', async () => {
    const pizza = await getItemDetails(restaurantId(), ids.item['pizza']!);
    expect(pizza.name).toBe('Pizza');
    expect(pizza.variants.length).toBe(3);
    expect(pizza.variants.map((v) => v.name)).toEqual(['Small', 'Medium', 'Large']);
    expect(pizza.addons.length).toBe(1);
    expect(pizza.addons[0]!.name).toBe('Extra Cheese');
  });

  it('checkAvailability returns true for available item', async () => {
    const r = await checkAvailability(restaurantId(), ids.item['chicken_burger']!);
    expect(r.available).toBe(true);
  });

  it('checkAvailability returns false on unknown item', async () => {
    const r = await checkAvailability(restaurantId(), '00000000-0000-4000-8000-000000000000');
    expect(r.available).toBe(false);
    expect(r.reason).toBe('item_not_found');
  });

  it('checkAvailability validates variant', async () => {
    const r = await checkAvailability(restaurantId(), ids.item['pizza']!, {
      variantId: ids.variant['pizza:large']!,
    });
    expect(r.available).toBe(true);
  });

  it('checkAvailability rejects unknown variant', async () => {
    const r = await checkAvailability(restaurantId(), ids.item['pizza']!, {
      variantId: '00000000-0000-4000-8000-000000000000',
    });
    expect(r.available).toBe(false);
    expect(r.reason).toBe('variant_not_found');
  });

  it('requireItemPrice returns price for known item', async () => {
    const r = await requireItemPrice(restaurantId(), ids.item['chicken_burger']!);
    expect(r.name).toBe('Chicken Burger');
    expect(r.price_paisa).toBe(18000);
  });

  it('requireItemPrice throws MenuItemNotFoundError for unknown id', async () => {
    await expect(
      requireItemPrice(restaurantId(), '00000000-0000-4000-8000-000000000000'),
    ).rejects.toBeInstanceOf(MenuItemNotFoundError);
  });

  it('listRestaurantItems returns all items', async () => {
    const items = await listRestaurantItems(restaurantId());
    expect(items.length).toBeGreaterThanOrEqual(7);
  });

  it('MenuItemUnavailableError is exported', () => {
    expect(MenuItemUnavailableError).toBeDefined();
    const e = new MenuItemUnavailableError('Coke');
    expect(e.code).toBe('menu_item_unavailable');
  });
});
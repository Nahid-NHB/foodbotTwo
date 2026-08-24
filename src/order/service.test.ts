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
import { seed } from '../db/seed.js';
import { confirm, getById, transition } from './service.js';
import { findOrCreateByPhone } from '../customer/service.js';
import {
  MenuItemNotFoundError,
  MenuItemUnavailableError,
  OrderNotConfirmableError,
  OrderNotFoundError,
  InvalidStateTransitionError,
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
const TEST_PHONE = '+8801700008888';
let customerId: string;
let restaurantId: string;

describe('order service (integration)', () => {
  beforeAll(async () => {
    if (!existsSync(idsPath)) await seed();
    ids = JSON.parse(readFileSync(idsPath, 'utf8')) as Ids;
    restaurantId = ids.restaurant['hungry_bird']!;
    const c = await findOrCreateByPhone(TEST_PHONE);
    customerId = c.id;
  });

  afterAll(async () => {
    await closeDb();
  });

  function line(overrides: Partial<OrderItemSnapshot> = {}): OrderItemSnapshot {
    return {
      menu_item_id: ids.item['chicken_burger']!,
      name: 'Chicken Burger',
      quantity: 2,
      unit_price_paisa: 18000,
      addon_ids: [],
      addons: [],
      line_total_paisa: 36000,
      ...overrides,
    };
  }

  it('confirm creates a pending order with correct totals', async () => {
    const order = await confirm({
      restaurant_id: restaurantId,
      customer_id: customerId,
      items: [line()],
      delivery_fee_paisa: 6000,
    });
    expect(order.state).toBe('pending');
    expect(order.subtotal_paisa).toBe(36000);
    expect(order.delivery_fee_paisa).toBe(6000);
    expect(order.total_paisa).toBe(42000);
    expect(order.confirmed_at).toBeTruthy();
    expect(order.items[0]!.name).toBe('Chicken Burger');
  });

  it('confirm rejects empty cart', async () => {
    await expect(
      confirm({
        restaurant_id: restaurantId,
        customer_id: customerId,
        items: [],
        delivery_fee_paisa: 6000,
      }),
    ).rejects.toBeInstanceOf(OrderNotConfirmableError);
  });

  it('confirm rejects unknown menu item id', async () => {
    await expect(
      confirm({
        restaurant_id: restaurantId,
        customer_id: customerId,
        items: [line({ menu_item_id: '00000000-0000-4000-8000-000000000000' })],
        delivery_fee_paisa: 6000,
      }),
    ).rejects.toBeInstanceOf(MenuItemNotFoundError);
  });

  it('confirm recomputes prices from DB (snapshot is fresh)', async () => {
    const order = await confirm({
      restaurant_id: restaurantId,
      customer_id: customerId,
      items: [line({ unit_price_paisa: 999, line_total_paisa: 999 })], // wrong price on input
      delivery_fee_paisa: 0,
    });
    expect(order.items[0]!.unit_price_paisa).toBe(18000);
    expect(order.items[0]!.line_total_paisa).toBe(36000);
  });

  it('confirm rejects zero quantity', async () => {
    await expect(
      confirm({
        restaurant_id: restaurantId,
        customer_id: customerId,
        items: [line({ quantity: 0 })],
        delivery_fee_paisa: 0,
      }),
    ).rejects.toBeInstanceOf(OrderNotConfirmableError);
  });

  it('transition pending -> confirmed -> preparing -> ready -> out_for_delivery -> delivered', async () => {
    const order = await confirm({
      restaurant_id: restaurantId,
      customer_id: customerId,
      items: [line()],
      delivery_fee_paisa: 0,
    });

    let o = await transition(order.id, 'confirmed', 'staff', 'ok');
    expect(o.state).toBe('confirmed');

    o = await transition(order.id, 'preparing', 'staff');
    expect(o.state).toBe('preparing');

    o = await transition(order.id, 'ready', 'staff');
    expect(o.state).toBe('ready');

    o = await transition(order.id, 'out_for_delivery', 'staff');
    expect(o.state).toBe('out_for_delivery');

    o = await transition(order.id, 'delivered', 'staff');
    expect(o.state).toBe('delivered');
  });

  it('transition rejects invalid transition with InvalidStateTransitionError', async () => {
    const order = await confirm({
      restaurant_id: restaurantId,
      customer_id: customerId,
      items: [line()],
      delivery_fee_paisa: 0,
    });
    await expect(transition(order.id, 'delivered', 'staff')).rejects.toBeInstanceOf(
      InvalidStateTransitionError,
    );
  });

  it('cancelled order cannot transition further', async () => {
    const order = await confirm({
      restaurant_id: restaurantId,
      customer_id: customerId,
      items: [line()],
      delivery_fee_paisa: 0,
    });
    const cancelled = await transition(order.id, 'cancelled', 'customer', 'changed mind');
    expect(cancelled.state).toBe('cancelled');
    expect(cancelled.cancelled_at).toBeTruthy();
    expect(cancelled.cancel_reason).toBe('changed mind');
    await expect(transition(order.id, 'confirmed', 'staff')).rejects.toBeInstanceOf(
      InvalidStateTransitionError,
    );
  });

  it('MenuItemUnavailableError is exported and typed', () => {
    const e = new MenuItemUnavailableError('Coke');
    expect(e.code).toBe('menu_item_unavailable');
  });

  it('getById throws OrderNotFoundError for unknown id', async () => {
    await expect(getById('00000000-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(
      OrderNotFoundError,
    );
  });

  it('confirm rejects negative delivery_fee_paisa', async () => {
    await expect(
      confirm({
        restaurant_id: restaurantId,
        customer_id: customerId,
        items: [line()],
        delivery_fee_paisa: -1,
      }),
    ).rejects.toBeInstanceOf(OrderNotConfirmableError);
  });

  it('confirm rejects non-finite delivery_fee_paisa', async () => {
    await expect(
      confirm({
        restaurant_id: restaurantId,
        customer_id: customerId,
        items: [line()],
        delivery_fee_paisa: Number.NaN,
      }),
    ).rejects.toBeInstanceOf(OrderNotConfirmableError);
  });
});
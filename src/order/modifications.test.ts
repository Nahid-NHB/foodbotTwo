import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';

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

import db, { closeDb, pool } from '../db/client.js';
import { seed } from '../db/seed.js';
import { confirm } from './service.js';
import { applyModification, getCurrentItems } from './modifications.js';
import { findOrCreateByPhone } from '../customer/service.js';
import { MenuItemUnavailableError, ToolError } from '../common/errors.js';
import type { OrderItemSnapshot } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));
const idsPath = join(here, '..', '..', 'data', 'menu-ids.json');

type Ids = {
  restaurant: Record<string, string>;
  item: Record<string, string>;
  variant: Record<string, string>;
  addon: Record<string, string>;
};

const PHONE_PRIMARY = '+8801712345601';
const PHONE_OTHER = '+8801712345602';
const DELIVERY_FEE_PAISA = 6000;

let ids: Ids;
let restaurantId: string;
let customerId: string;
let otherCustomerId: string;
let itemId: string;
let addonId: string;

function line(overrides: Partial<OrderItemSnapshot> = {}): OrderItemSnapshot {
  return {
    menu_item_id: itemId,
    name: 'Chicken Burger',
    quantity: 1,
    unit_price_paisa: 18000,
    addon_ids: [],
    addons: [],
    line_total_paisa: 18000,
    ...overrides,
  };
}

describe('order modification service (integration)', () => {
  beforeAll(async () => {
    if (!existsSync(idsPath)) await seed();
    ids = JSON.parse(readFileSync(idsPath, 'utf8')) as Ids;
    restaurantId = ids.restaurant['hungry_bird']!;
    itemId = ids.item['chicken_burger']!;
    addonId = ids.addon['chicken_burger_cheese']!;

    const c = await findOrCreateByPhone(PHONE_PRIMARY);
    customerId = c.id;
    const o = await findOrCreateByPhone(PHONE_OTHER);
    otherCustomerId = o.id;

    // Ensure both customers and their orders start clean for deterministic assertions.
    for (const cid of [customerId, otherCustomerId]) {
      await pool.query(
        `DELETE FROM order_modifications WHERE order_id IN (SELECT id FROM orders WHERE customer_id = $1)`,
        [cid],
      );
      await pool.query(
        `DELETE FROM order_events WHERE order_id IN (SELECT id FROM orders WHERE customer_id = $1)`,
        [cid],
      );
      await pool.query(`DELETE FROM orders WHERE customer_id = $1`, [cid]);
    }

    // Ensure chicken burger is available at start (in case a prior test left it off).
    await db.query(
      `UPDATE menu_items SET is_available = true WHERE id = $1 AND restaurant_id = $2`,
      [itemId, restaurantId],
    );
  });

  afterAll(async () => {
    // Restore availability so we don't leak state into other suites.
    await db.query(
      `UPDATE menu_items SET is_available = true WHERE id = $1 AND restaurant_id = $2`,
      [itemId, restaurantId],
    );
    await closeDb();
  });

  // Each test gets its own fresh pending order so the row-locked SELECT FOR
  // UPDATE inside applyModification doesn't fight itself across tests.
  let orderId: string;
  let preModifyTotal: number;
  let preModifyDeliveryFee: number;

  beforeEach(async () => {
    // Re-ensure availability — the unavailable test mutates this.
    await db.query(
      `UPDATE menu_items SET is_available = true WHERE id = $1 AND restaurant_id = $2`,
      [itemId, restaurantId],
    );
    const order = await confirm({
      restaurant_id: restaurantId,
      customer_id: customerId,
      items: [line()], // 1 × chicken_burger = 18000
      delivery_fee_paisa: DELIVERY_FEE_PAISA,
    });
    orderId = order.id;
    preModifyTotal = order.total_paisa;
    preModifyDeliveryFee = order.delivery_fee_paisa;
  });

  it('applies a new items array, recomputes totals, writes audit row', async () => {
    // Chicken burger unit = 18000 + cheese addon = 3000 = 21000 paisa.
    // New items: same item with addon × 3.
    const result = await applyModification({
      orderId,
      customerId,
      newItems: [
        {
          menu_item_id: itemId,
          name: 'Chicken Burger',
          quantity: 3,
          unit_price_paisa: 0, // server recomputes
          addon_ids: [addonId],
          addons: [],
          line_total_paisa: 0,
        },
      ],
    });

    // State is unchanged.
    expect(result.order.state).toBe('pending');
    expect(result.order.items).toHaveLength(1);
    expect(result.order.items[0]!.quantity).toBe(3);
    expect(result.order.items[0]!.unit_price_paisa).toBe(21000);
    expect(result.order.items[0]!.line_total_paisa).toBe(63000);

    // Totals: 3 × 21000 = 63000 subtotal + 6000 delivery.
    expect(result.order.subtotal_paisa).toBe(63000);
    expect(result.order.delivery_fee_paisa).toBe(preModifyDeliveryFee);
    expect(result.order.total_paisa).toBe(63000 + preModifyDeliveryFee);

    // Audit row in returned object.
    expect(result.modification.old_items.length).toBe(1);
    expect(result.modification.old_items[0]!.quantity).toBe(1);
    expect(result.modification.old_total_paisa).toBe(preModifyTotal);
    expect(result.modification.new_total_paisa).toBe(result.order.total_paisa);
    expect(result.modification.actor).toBe('customer');
    expect(typeof result.modification.created_at).toBe('string');
    expect(result.modification.new_items[0]!.line_total_paisa).toBe(63000);

    // DB-level assertions.
    const modRows = await db.query<{ order_id: string }>(
      `SELECT order_id FROM order_modifications WHERE order_id = $1`,
      [orderId],
    );
    expect(modRows.length).toBeGreaterThanOrEqual(1);

    const evRows = await db.query<{ from_state: string; to_state: string; note: string }>(
      `SELECT from_state, to_state, note FROM order_events
       WHERE order_id = $1 AND note = 'items modified'`,
      [orderId],
    );
    expect(evRows).toHaveLength(1);
    expect(evRows[0]!.from_state).toBe('pending');
    expect(evRows[0]!.to_state).toBe('pending');
  });

  it('throws order_not_modifiable when state is preparing', async () => {
    await db.query(`UPDATE orders SET state = 'preparing' WHERE id = $1`, [orderId]);
    await expect(
      applyModification({
        orderId,
        customerId,
        newItems: [line()],
      }),
    ).rejects.toMatchObject({ code: 'order_not_modifiable' });
  });

  it('throws order_not_found when orderId belongs to another customer', async () => {
    let caught: unknown;
    try {
      await applyModification({
        orderId,
        customerId: otherCustomerId,
        newItems: [line()],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ToolError);
    expect((caught as ToolError).code).toBe('order_not_found');
  });

  it('throws MenuItemUnavailableError when a line is no longer available', async () => {
    await db.query(
      `UPDATE menu_items SET is_available = false WHERE id = $1 AND restaurant_id = $2`,
      [itemId, restaurantId],
    );
    try {
      await expect(
        applyModification({
          orderId,
          customerId,
          newItems: [line()],
        }),
      ).rejects.toBeInstanceOf(MenuItemUnavailableError);
    } finally {
      // Restore availability so we don't leak state.
      await db.query(
        `UPDATE menu_items SET is_available = true WHERE id = $1 AND restaurant_id = $2`,
        [itemId, restaurantId],
      );
    }
  });

  it('getCurrentItems returns items for the owner', async () => {
    const items = await getCurrentItems(orderId, customerId);
    expect(items).toHaveLength(1);
    expect(items[0]!.menu_item_id).toBe(itemId);
    expect(items[0]!.quantity).toBe(1);
  });

  it('getCurrentItems throws order_not_found on ownership mismatch', async () => {
    let caught: unknown;
    try {
      await getCurrentItems(orderId, otherCustomerId);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ToolError);
    expect((caught as ToolError).code).toBe('order_not_found');
  });
});

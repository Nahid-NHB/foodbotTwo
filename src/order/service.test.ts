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

import { closeDb, pool } from '../db/client.js';
import { seed } from '../db/seed.js';
import { confirm, getById, transition, listHistoryByCustomer } from './service.js';
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

  describe('listHistoryByCustomer', () => {
    it('returns most-recent-first active orders for a customer', async () => {
      // Create a dedicated customer so we don't collide with other tests.
      const c = await findOrCreateByPhone('+8801700000777');
      const cid = c.id;

      // Insert 3 orders with distinct created_at (oldest → newest).
      const itemsJson = JSON.stringify([
        {
          menu_item_id: ids.item['chicken_burger']!,
          name: 'Chicken Burger',
          quantity: 1,
          unit_price_paisa: 18000,
          addon_ids: [],
          addons: [],
          line_total_paisa: 18000,
        },
      ]);
      const insertOne = async (state: string, minsAgo: number) => {
        const id = `00000000-0000-4000-8000-${String(minsAgo).padStart(12, '0')}`;
        await pool.query(
          `INSERT INTO orders (id, restaurant_id, customer_id, state, items,
              subtotal_paisa, delivery_fee_paisa, total_paisa,
              created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, 18000, 0, 18000,
              now() - ($6 || ' minutes')::interval, now() - ($6 || ' minutes')::interval)`,
          [id, restaurantId, cid, state, itemsJson, minsAgo],
        );
        return id;
      };

      const oldest = await insertOne('delivered', 10); // terminal — excluded by default
      await insertOne('pending', 5);
      await insertOne('preparing', 1); // most recent active

      const active = await listHistoryByCustomer(cid, {
        limit: 5,
        beforeIso: null,
        includeTerminal: false,
      });
      expect(active).toHaveLength(2);
      // Most-recent-first: preparing (1 min ago) before pending (5 min ago).
      expect(active[0]!.state).toBe('preparing');
      expect(active[1]!.state).toBe('pending');
      // Sanity: created_at strictly DESC.
      expect(new Date(active[0]!.created_at).getTime()).toBeGreaterThan(
        new Date(active[1]!.created_at).getTime(),
      );

      const all = await listHistoryByCustomer(cid, {
        limit: 5,
        beforeIso: null,
        includeTerminal: true,
      });
      expect(all).toHaveLength(3);
      // First should be the most-recent preparing; oldest delivered last.
      expect(all[0]!.state).toBe('preparing');
      expect(all[all.length - 1]!.id).toBe(oldest);
      expect(all[all.length - 1]!.state).toBe('delivered');
    });

    it('respects limit and beforeIso', async () => {
      const c = await findOrCreateByPhone('+8801700000888');
      const cid = c.id;

      // Wipe any previous orders for this customer from prior runs to make
      // assertions deterministic.
      await pool.query('DELETE FROM order_events WHERE order_id IN (SELECT id FROM orders WHERE customer_id = $1)', [cid]);
      await pool.query('DELETE FROM orders WHERE customer_id = $1', [cid]);

      const itemsJson = JSON.stringify([
        {
          menu_item_id: ids.item['chicken_burger']!,
          name: 'Chicken Burger',
          quantity: 1,
          unit_price_paisa: 18000,
          addon_ids: [],
          addons: [],
          line_total_paisa: 18000,
        },
      ]);

      // Insert 5 orders with explicit ascending created_at.
      const baseTime = Date.now() - 60 * 60 * 1000; // 1h ago
      const ids5: string[] = [];
      for (let i = 0; i < 5; i++) {
        const id = `00000000-0000-4000-8000-${String(100 + i).padStart(12, '0')}`;
        ids5.push(id);
        const ts = new Date(baseTime + i * 60_000).toISOString(); // +1 min each
        await pool.query(
          `INSERT INTO orders (id, restaurant_id, customer_id, state, items,
              subtotal_paisa, delivery_fee_paisa, total_paisa,
              created_at, updated_at)
           VALUES ($1, $2, $3, 'pending', $4::jsonb, 18000, 0, 18000, $5::timestamptz, $5::timestamptz)`,
          [id, restaurantId, cid, itemsJson, ts],
        );
      }

      // 4th order's created_at (index 3). Orders strictly older than that
      // are ids5[0], ids5[1], ids5[2].
      const fourthCreatedAt = await pool.query<{ created_at: string }>(
        `SELECT created_at FROM orders WHERE id = $1`,
        [ids5[3]],
      );
      const before = fourthCreatedAt.rows[0]!.created_at.toString();

      const rows = await listHistoryByCustomer(cid, {
        limit: 2,
        beforeIso: before,
        includeTerminal: true,
      });
      expect(rows).toHaveLength(2);
      const beforeMs = new Date(before).getTime();
      for (const r of rows) {
        expect(new Date(r.created_at).getTime()).toBeLessThan(beforeMs);
      }
      // DESC ordering: most recent of the eligible ones first.
      expect(new Date(rows[0]!.created_at).getTime()).toBeGreaterThan(
        new Date(rows[1]!.created_at).getTime(),
      );
    });

    it('returns empty array for a customer with no orders', async () => {
      const newCust = await pool.query<{ id: string }>(
        `INSERT INTO customers (id, phone_e164) VALUES (uuid_generate_v4(), '+8801700000666') RETURNING id`,
      );
      const newCustomerId = newCust.rows[0]!.id;

      const rows = await listHistoryByCustomer(newCustomerId, {
        limit: 5,
        beforeIso: null,
        includeTerminal: false,
      });
      expect(rows).toEqual([]);
    });

    it('items_summary is computed from the snapshot', async () => {
      const c = await findOrCreateByPhone('+8801700000999');
      const cid = c.id;

      // Wipe orders for determinism.
      await pool.query('DELETE FROM order_events WHERE order_id IN (SELECT id FROM orders WHERE customer_id = $1)', [cid]);
      await pool.query('DELETE FROM orders WHERE customer_id = $1', [cid]);

      const items = [
        {
          menu_item_id: ids.item['chicken_burger']!,
          name: 'Chicken Burger',
          quantity: 2,
          unit_price_paisa: 18000,
          addon_ids: [],
          addons: [],
          line_total_paisa: 36000,
        },
        {
          menu_item_id: ids.item['coke']!,
          name: 'Coke',
          quantity: 1,
          unit_price_paisa: 5000,
          addon_ids: [],
          addons: [],
          line_total_paisa: 5000,
        },
      ];

      const order = await confirm({
        restaurant_id: restaurantId,
        customer_id: cid,
        items,
        delivery_fee_paisa: 0,
      });

      const rows = await listHistoryByCustomer(cid, {
        limit: 5,
        beforeIso: null,
        includeTerminal: true,
      });
      expect(rows).toHaveLength(1);
      const r = rows[0]!;
      expect(r.id).toBe(order.id);
      expect(r.item_count).toBe(3);
      expect(r.items_summary).toContain('Chicken Burger');
      expect(r.items_summary).toContain('Coke');
      expect(r.items_summary).toContain('× ');
      // Snapshot fields.
      expect(r.subtotal_paisa).toBe(41000);
      expect(r.delivery_fee_paisa).toBe(0);
      expect(r.total_paisa).toBe(41000);
      expect(r.confirmed_at).toBeTruthy();
    });
  });
});
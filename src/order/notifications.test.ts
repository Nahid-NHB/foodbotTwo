import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';

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
import {
  recordAndEnqueue,
  renderTemplate,
  markDelivered,
  markFailed,
  markWamid,
} from './notifications.js';
import { sendQueue } from '../queue/index.js';
import { findOrCreateByPhone } from '../customer/service.js';
import type { OrderItemSnapshot, Order } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));
const idsPath = join(here, '..', '..', 'data', 'menu-ids.json');

type Ids = {
  restaurant: Record<string, string>;
  item: Record<string, string>;
};

let ids: Ids;
let restaurantId: string;
let itemId: string;
const TEST_PHONE = '+8801723456701';
let customerId: string;

describe('order notification service (integration)', () => {
  beforeAll(async () => {
    if (!existsSync(idsPath)) await seed();
    ids = JSON.parse(readFileSync(idsPath, 'utf8')) as Ids;
    restaurantId = ids.restaurant['hungry_bird']!;
    itemId = ids.item['chicken_burger']!;

    const c = await findOrCreateByPhone(TEST_PHONE);
    customerId = c.id;

    // Start clean: no orders or notifications for this customer from prior runs.
    await pool.query(
      `DELETE FROM order_status_notifications WHERE order_id IN (SELECT id FROM orders WHERE customer_id = $1)`,
      [customerId],
    );
    await pool.query(
      `DELETE FROM order_events WHERE order_id IN (SELECT id FROM orders WHERE customer_id = $1)`,
      [customerId],
    );
    await pool.query(`DELETE FROM orders WHERE customer_id = $1`, [customerId]);
  });

  afterAll(async () => {
    await closeDb();
  });

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

  let order: Order;

  beforeEach(async () => {
    order = await confirm({
      restaurant_id: restaurantId,
      customer_id: customerId,
      items: [line()],
      delivery_fee_paisa: 0,
    });
    // Wipe any notifications created by previous test runs of this suite
    // (transition hook may have inserted one for 'pending' → 'confirmed'
    // if a prior run left orders in mid-state). beforeEach creates a fresh
    // order, so we only need to clear notifications tied to this customer.
    await pool.query(
      `DELETE FROM order_status_notifications WHERE order_id IN (SELECT id FROM orders WHERE customer_id = $1)`,
      [customerId],
    );
  });

  it('renderTemplate returns Bangla with short id for known states', () => {
    const fakeOrder = { id: 'abcdef1234567890' } as Pick<Order, 'id'>;
    const text = renderTemplate('confirmed', fakeOrder);
    expect(text).not.toBeNull();
    // short id: first 8 chars
    expect(text).toContain('abcdef12');
    // Bangla substring from the 'confirmed' template
    expect(text).toMatch(/কনফার্ম/);
  });

  it('renderTemplate returns null for unknown states', () => {
    // 'pending' has no template — renderTemplate should return null.
    expect(renderTemplate('pending', { id: 'abcdef1234567890' } as Pick<Order, 'id'>)).toBeNull();
  });

  it('recordAndEnqueue inserts one row per (order_id, to_state), idempotent on repeat', async () => {
    const spy = vi.spyOn(sendQueue, 'add').mockResolvedValue({
      // minimal shape that satisfies Queue.add's return type
      id: 'fake',
      name: 'status',
      data: {} as never,
      opts: {},
      toJSON: () => ({}),
    } as never);

    try {
      await recordAndEnqueue(order, 'confirmed');
      await recordAndEnqueue(order, 'confirmed');
      await recordAndEnqueue(order, 'confirmed');

      const rows = await db.query<{ id: string }>(
        `SELECT id FROM order_status_notifications WHERE order_id = $1 AND to_state = 'confirmed'`,
        [order.id],
      );
      expect(rows).toHaveLength(1);

      // Only one send job enqueued despite 3 calls.
      const statusCalls = spy.mock.calls.filter(([, payload]) => {
        const p = payload as { kind?: string };
        return p?.kind === 'status';
      });
      expect(statusCalls).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('recordAndEnqueue enqueues a send job with kind=status, orderId, toState', async () => {
    const spy = vi.spyOn(sendQueue, 'add').mockResolvedValue({
      id: 'fake',
      name: 'status',
      data: {} as never,
      opts: {},
      toJSON: () => ({}),
    } as never);

    try {
      await recordAndEnqueue(order, 'preparing');

      const statusCalls = spy.mock.calls.filter(([, payload]) => {
        const p = payload as { kind?: string };
        return p?.kind === 'status';
      });
      expect(statusCalls).toHaveLength(1);
      const [jobName, payload] = statusCalls[0]!;
      expect(jobName).toBe('status');
      expect(payload).toMatchObject({
        kind: 'status',
        orderId: order.id,
        toState: 'preparing',
        to: TEST_PHONE,
      });
      expect(typeof (payload as { body: string }).body).toBe('string');
      expect((payload as { body: string }).body.length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('markDelivered updates delivered_at; subsequent calls are no-ops when delivered_at is already set', async () => {
    // Set up a row.
    const spy = vi.spyOn(sendQueue, 'add').mockResolvedValue({
      id: 'fake',
      name: 'status',
      data: {} as never,
      opts: {},
      toJSON: () => ({}),
    } as never);
    try {
      await recordAndEnqueue(order, 'ready');
    } finally {
      spy.mockRestore();
    }

    const first = new Date('2026-08-27T10:00:00.000Z');
    await markDelivered(order.id, 'ready', first);

    const rowsAfterFirst = await db.query<{ delivered_at: Date }>(
      `SELECT delivered_at FROM order_status_notifications WHERE order_id = $1 AND to_state = 'ready'`,
      [order.id],
    );
    expect(new Date(rowsAfterFirst[0]!.delivered_at as unknown as string).toISOString()).toBe(
      '2026-08-27T10:00:00.000Z',
    );

    // Second call with a different time should be a no-op because the guard
    // `AND delivered_at IS NULL` doesn't match.
    const later = new Date('2026-08-27T11:00:00.000Z');
    await markDelivered(order.id, 'ready', later);

    const rowsAfterSecond = await db.query<{ delivered_at: Date }>(
      `SELECT delivered_at FROM order_status_notifications WHERE order_id = $1 AND to_state = 'ready'`,
      [order.id],
    );
    expect(new Date(rowsAfterSecond[0]!.delivered_at as unknown as string).toISOString()).toBe(
      '2026-08-27T10:00:00.000Z',
    );
  });

  it('markWamid updates wamid', async () => {
    const spy = vi.spyOn(sendQueue, 'add').mockResolvedValue({
      id: 'fake',
      name: 'status',
      data: {} as never,
      opts: {},
      toJSON: () => ({}),
    } as never);
    try {
      await recordAndEnqueue(order, 'out_for_delivery');
    } finally {
      spy.mockRestore();
    }

    await markWamid(order.id, 'out_for_delivery', 'wamid.test.12345');

    const rows = await db.query<{ wamid: string | null }>(
      `SELECT wamid FROM order_status_notifications WHERE order_id = $1 AND to_state = 'out_for_delivery'`,
      [order.id],
    );
    expect(rows[0]!.wamid).toBe('wamid.test.12345');
  });

  it('markFailed updates failed_reason', async () => {
    const spy = vi.spyOn(sendQueue, 'add').mockResolvedValue({
      id: 'fake',
      name: 'status',
      data: {} as never,
      opts: {},
      toJSON: () => ({}),
    } as never);
    try {
      await recordAndEnqueue(order, 'delivered');
    } finally {
      spy.mockRestore();
    }

    await markFailed(order.id, 'delivered', 'sandbox hiccup');
    const rows = await db.query<{ failed_reason: string | null }>(
      `SELECT failed_reason FROM order_status_notifications WHERE order_id = $1 AND to_state = 'delivered'`,
      [order.id],
    );
    expect(rows[0]!.failed_reason).toBe('sandbox hiccup');
  });
});

// Restore any spies after every test in case a throw bypassed try/finally.
afterEach(() => {
  vi.restoreAllMocks();
});
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://foodbot:foodbot@127.0.0.1:5432/foodbot';
  process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
  process.env.GEMINI_API_KEY = 'gemini-test';
  process.env.WHATSAPP_TOKEN = 'EAAtest';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '12345';
  process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = '67890';
  process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'verify';
  process.env.WHATSAPP_APP_SECRET = 'secret';
  process.env.RESTAURANT_NAME = 'Hungry Bird';
  process.env.ADMIN_BASIC_AUTH_USER = 'admin';
  process.env.ADMIN_BASIC_AUTH_PASS = 'secret-pass';
});

import { buildApp } from '../index.js';
import db, { closeDb } from '../db/client.js';
import { closeRedis } from '../redis/client.js';

const basic = (user: string, pass: string) =>
  'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

describe('GET /admin/notifications/recent', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  // Order we use for the inserted-row test. We create it (and the linked
  // restaurant + customer) up front so the FK on order_status_notifications
  // accepts the insert, and clean it up afterwards.
  let orderId: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    // Seed minimal FK targets so we can insert into order_status_notifications.
    const restaurantId = '11111111-1111-1111-1111-111111111111';
    const customerId = '22222222-2222-2222-2222-222222222222';
    const wamid = 'wamid.test.' + Math.random().toString(36).slice(2, 10);

    await db.query(
      `INSERT INTO restaurants (id, name, whatsapp_phone_number_id, whatsapp_business_account_id)
       VALUES ($1, 'Test Bistro', '12345', '67890')
       ON CONFLICT (id) DO NOTHING`,
      [restaurantId],
    );
    await db.query(
      `INSERT INTO customers (id, phone_e164, name)
       VALUES ($1, '+15555550100', 'Test Customer')
       ON CONFLICT (id) DO NOTHING`,
      [customerId],
    );

    const orderRows = await db.query<{ id: string }>(
      `INSERT INTO orders (
         id, restaurant_id, customer_id, state,
         items, subtotal_paisa, delivery_fee_paisa, total_paisa,
         delivery_address
       ) VALUES (
         gen_random_uuid(), $1, $2, 'confirmed',
         '[]'::jsonb, 10000, 0, 10000,
         '123 Test St'
       ) RETURNING id`,
      [restaurantId, customerId],
    );
    orderId = orderRows[0]!.id;

    await db.query(
      `INSERT INTO order_status_notifications (id, order_id, to_state, wamid, sent_at)
       VALUES (gen_random_uuid(), $1, 'confirmed', $2, now() - interval '5 seconds'),
              (gen_random_uuid(), $1, 'preparing', $2, now())`,
      [orderId, wamid],
    );
  });

  afterAll(async () => {
    await app.close();
    // Clean up the notification rows + order we created (in FK-safe order).
    if (orderId) {
      await db.query(`DELETE FROM order_status_notifications WHERE order_id = $1`, [orderId]);
      await db.query(`DELETE FROM orders WHERE id = $1`, [orderId]);
    }
    await db.query(`DELETE FROM customers WHERE id = '22222222-2222-2222-2222-222222222222'`);
    await db.query(`DELETE FROM restaurants WHERE id = '11111111-1111-1111-1111-111111111111'`);
    await closeDb();
    await closeRedis();
  });

  it('returns 401 without auth header', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/notifications/recent' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/^Basic/);
  });

  it('returns 401 with wrong credentials', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/notifications/recent',
      headers: { authorization: basic('admin', 'wrong') },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 200 with correct credentials', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/notifications/recent',
      headers: { authorization: basic('admin', 'secret-pass') },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { count: number; notifications: Array<unknown> };
    expect(typeof body.count).toBe('number');
    expect(Array.isArray(body.notifications)).toBe(true);
  });

  it('returns the inserted notification row when filtered by order_id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/admin/notifications/recent?order_id=${orderId}`,
      headers: { authorization: basic('admin', 'secret-pass') },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      count: number;
      notifications: Array<{
        id: string;
        order_id: string;
        to_state: string;
        sent_at: string;
        delivered_at: string | null;
        failed_reason: string | null;
        wamid: string | null;
      }>;
    };
    expect(body.count).toBe(2);
    expect(body.notifications.length).toBe(2);
    for (const n of body.notifications) {
      expect(n.order_id).toBe(orderId);
      expect(['confirmed', 'preparing']).toContain(n.to_state);
      expect(typeof n.sent_at).toBe('string');
      expect(n.delivered_at).toBeNull();
      expect(n.failed_reason).toBeNull();
      expect(n.wamid).toMatch(/^wamid\.test\./);
    }
    // sent_at DESC ordering: the second insert (preparing) should come first.
    expect(body.notifications[0]!.to_state).toBe('preparing');
    expect(body.notifications[1]!.to_state).toBe('confirmed');
  });

  it('honors the limit query param', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/admin/notifications/recent?limit=1`,
      headers: { authorization: basic('admin', 'secret-pass') },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { count: number; notifications: unknown[] };
    expect(body.notifications.length).toBeLessThanOrEqual(1);
  });
});
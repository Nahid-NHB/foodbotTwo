import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

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
import { closeRedis } from '../redis/client.js';
import { seed } from '../db/seed.js';
import { findOrCreateByPhone } from '../customer/service.js';
import * as ConversationService from '../conversation/service.js';
import { runTool, toolDefinitions } from './tools.js';

const here = dirname(fileURLToPath(import.meta.url));
const idsPath = join(here, '..', '..', 'data', 'menu-ids.json');

type Ids = { restaurant: Record<string, string>; item: Record<string, string>; variant: Record<string, string> };

describe('tool handlers (integration)', () => {
  let ids: Ids;
  let restaurantId: string;
  let customerId: string;
  const TEST_PHONE = '+8801700008888';
  let conversationId: string;

  beforeAll(async () => {
    if (!existsSync(idsPath)) await seed();
    ids = JSON.parse(readFileSync(idsPath, 'utf8')) as Ids;
    restaurantId = ids.restaurant['hungry_bird']!;
    const c = await findOrCreateByPhone(TEST_PHONE);
    customerId = c.id;
    const conv = await ConversationService.getOrCreate(customerId, restaurantId);
    conversationId = conv.id;
  });

  afterAll(async () => {
    await closeDb();
    await closeRedis();
  });

  beforeEach(async () => {
    await ConversationService.clearCart(conversationId);
  });

  // ---------- tool surface ----------

  it('toolDefinitions now includes check_item_availability and cancel_order', () => {
    const names = toolDefinitions.map((t) => t.name);
    expect(names).toContain('check_item_availability');
    expect(names).toContain('cancel_order');
  });

  // ---------- check_item_availability ----------

  it('check_item_availability: returns available:true for an available seeded item', async () => {
    const result = await runTool(
      'check_item_availability',
      { item_id: ids.item['chicken_burger'] },
      { conversationId, customerId, restaurantId },
    );
    expect(JSON.parse(result)).toMatchObject({ available: true });
  });

  it('check_item_availability: returns available:false for an unknown item', async () => {
    const result = await runTool(
      'check_item_availability',
      { item_id: '00000000-0000-0000-0000-000000000000' },
      { conversationId, customerId, restaurantId },
    );
    expect(JSON.parse(result)).toMatchObject({ available: false, reason: 'item_not_found' });
  });

  it('check_item_availability: rejects non-uuid item_id', async () => {
    await expect(
      runTool(
        'check_item_availability',
        { item_id: 'not-a-uuid' },
        { conversationId, customerId, restaurantId },
      ),
    ).rejects.toThrow();
  });

  // ---------- cancel_order ----------

  async function createPendingOrder(): Promise<string> {
    // Build a single-line cart, run summarize (puts conv in awaiting_confirmation),
    // then confirm by writing the order row directly via OrderService.confirm.
    const items = [
      {
        menu_item_id: ids.item['chicken_burger']!,
        name: 'Chicken Burger',
        quantity: 1,
        unit_price_paisa: 18000,
        addon_ids: [],
        addons: [],
        line_total_paisa: 18000,
      },
    ];
    const { confirm } = await import('../order/service.js');
    const order = await confirm({
      restaurant_id: restaurantId,
      customer_id: customerId,
      conversation_id: conversationId,
      items,
      delivery_fee_paisa: 0,
    });
    return order.id;
  }

  it('cancel_order: cancels a pending order owned by the customer', async () => {
    const orderId = await createPendingOrder();

    const result = await runTool(
      'cancel_order',
      { order_id: orderId, reason: 'ঠিকানা ভুল হয়েছে' },
      { conversationId, customerId, restaurantId },
    );
    const parsed = JSON.parse(result);
    expect(parsed.order_id).toBe(orderId);
    expect(parsed.state).toBe('cancelled');
    expect(parsed.cancel_reason).toBe('ঠিকানা ভুল হয়েছে');
  });

  it('cancel_order: rejects an order owned by a different customer', async () => {
    const orderId = await createPendingOrder();
    const other = await findOrCreateByPhone('+8801700007777');
    const otherConv = await ConversationService.getOrCreate(other.id, restaurantId);

    await expect(
      runTool(
        'cancel_order',
        { order_id: orderId, reason: 'টেস্ট' },
        { conversationId: otherConv.id, customerId: other.id, restaurantId },
      ),
    ).rejects.toThrow(/order_not_found|অর্ডার খুঁজে পাওয়া যায়নি|not owned/);
  });

  it('cancel_order: rejects a missing required field (no reason)', async () => {
    const orderId = await createPendingOrder();
    await expect(
      runTool(
        'cancel_order',
        { order_id: orderId },
        { conversationId, customerId, restaurantId },
      ),
    ).rejects.toThrow();
  });

  it('cancel_order: refuses to re-cancel an already cancelled order', async () => {
    const orderId = await createPendingOrder();
    await runTool(
      'cancel_order',
      { order_id: orderId, reason: 'প্রথম বাতিল' },
      { conversationId, customerId, restaurantId },
    );
    // Second cancel should fail at the state machine.
    await expect(
      runTool(
        'cancel_order',
        { order_id: orderId, reason: 'দ্বিতীয় বাতিল' },
        { conversationId, customerId, restaurantId },
      ),
    ).rejects.toThrow();
  });
});
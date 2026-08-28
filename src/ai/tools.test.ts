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

import db, { closeDb } from '../db/client.js';
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

  // NOTE: closeDb/closeRedis is now invoked once at the file level (top-level
  // afterAll below) so the second describe block ("phase 2 tools (gated)")
  // still has a live connection. The earlier per-describe closeDb was a
  // happy accident of having only one describe in this file.

  beforeEach(async () => {
    await ConversationService.clearCart(conversationId);
  });

  // ---------- tool surface ----------

  it('toolDefinitions now includes check_item_availability and cancel_order', () => {
    const names = toolDefinitions.map((t) => t.name);
    expect(names).toContain('check_item_availability');
    expect(names).toContain('cancel_order');
    expect(names).toContain('get_order_status');
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

  // ---------- get_order_status ----------

  it('get_order_status: returns the most recent order when no order_id is passed', async () => {
    // Place a fresh order; "most recent" is whichever order was last inserted.
    const orderId = await createPendingOrder();

    const result = await runTool(
      'get_order_status',
      {},
      { conversationId, customerId, restaurantId },
    );
    const parsed = JSON.parse(result);
    // Should match one of this customer's orders. The DB-level ORDER BY
    // created_at DESC means it'll be the most recent one we just placed.
    expect([orderId, ...[]]).toContain(parsed.order_id);
    expect(parsed.state).toBeTruthy();
    expect(parsed.total_paisa).toBeGreaterThan(0);
    expect(parsed.total_display).toMatch(/^৳/);
    expect(Array.isArray(parsed.items)).toBe(true);
  });

  it('get_order_status: returns the named order when order_id is passed', async () => {
    const orderId = await createPendingOrder();

    const result = await runTool(
      'get_order_status',
      { order_id: orderId },
      { conversationId, customerId, restaurantId },
    );
    const parsed = JSON.parse(result);
    expect(parsed.order_id).toBe(orderId);
    expect(parsed.state).toBe('pending');
  });

  it('get_order_status: rejects an order owned by a different customer', async () => {
    const orderId = await createPendingOrder();
    const other = await findOrCreateByPhone('+8801700006666');
    const otherConv = await ConversationService.getOrCreate(other.id, restaurantId);

    await expect(
      runTool(
        'get_order_status',
        { order_id: orderId },
        { conversationId: otherConv.id, customerId: other.id, restaurantId },
      ),
    ).rejects.toThrow(/not owned|order_not_found/);
  });

  it('get_order_status: returns a friendly error when the customer has no orders', async () => {
    const other = await findOrCreateByPhone('+8801700005555');
    const otherConv = await ConversationService.getOrCreate(other.id, restaurantId);
    await expect(
      runTool(
        'get_order_status',
        {},
        { conversationId: otherConv.id, customerId: other.id, restaurantId },
      ),
    ).rejects.toThrow(/has no orders|order_not_found/);
  });

  it('get_order_status: rejects non-uuid order_id', async () => {
    await expect(
      runTool(
        'get_order_status',
        { order_id: 'not-a-uuid' },
        { conversationId, customerId, restaurantId },
      ),
    ).rejects.toThrow();
  });
});

// ============================================================================
// Phase 2 tools (gated behind FEATURE_CUSTOMER_ORDER_PHASE2)
//
// The default test env sets FEATURE_CUSTOMER_ORDER_PHASE2=false (via config
// schema default), so calling any phase2 tool should throw a stable
// `feature_disabled` ToolError before the handler ever runs.
//
// We do NOT cover the "enabled" code path here because `config` is parsed
// once at module load and the env flag cannot be flipped mid-suite without
// vi.resetModules + dynamic re-import. See src/ai/tools.phase2.test.ts for
// the enabled-case integration tests (run separately or with the flag set
// before the process boots).
// ============================================================================

describe('phase 2 tools (gated)', () => {
  let ids: Ids;
  let restaurantId: string;
  let customerId: string;
  let conversationId: string;
  const PHASE2_TEST_PHONE = '+8801712345701';

  beforeAll(async () => {
    if (!existsSync(idsPath)) await seed();
    ids = JSON.parse(readFileSync(idsPath, 'utf8')) as Ids;
    restaurantId = ids.restaurant['hungry_bird']!;
    // Dedicated customer so this block's state doesn't collide with the
    // existing "tool handlers" suite's +8801700008888.
    const c = await findOrCreateByPhone(PHASE2_TEST_PHONE);
    customerId = c.id;
    const conv = await ConversationService.getOrCreate(customerId, restaurantId);
    conversationId = conv.id;

    // Clean slate — no leftover orders, addresses, mods, or notifications
    // from a previous run of this block.
    await db.query(`DELETE FROM order_status_notifications WHERE order_id IN (SELECT id FROM orders WHERE customer_id = $1)`, [customerId]);
    await db.query(`DELETE FROM order_modifications WHERE order_id IN (SELECT id FROM orders WHERE customer_id = $1)`, [customerId]);
    await db.query(`DELETE FROM orders WHERE customer_id = $1`, [customerId]);
    await db.query(`DELETE FROM customer_addresses WHERE customer_id = $1`, [customerId]);
  });

  afterAll(async () => {
    // Best-effort cleanup. Don't fail the suite if these run before closeDb.
    try {
      await db.query(`DELETE FROM order_status_notifications WHERE order_id IN (SELECT id FROM orders WHERE customer_id = $1)`, [customerId]);
      await db.query(`DELETE FROM order_modifications WHERE order_id IN (SELECT id FROM orders WHERE customer_id = $1)`, [customerId]);
      await db.query(`DELETE FROM orders WHERE customer_id = $1`, [customerId]);
      await db.query(`DELETE FROM customer_addresses WHERE customer_id = $1`, [customerId]);
    } catch {
      // DB may already be closed by the earlier suite's afterAll — that's fine.
    }
  });

  const PHASE2_NAMES = [
    'get_delivery_zones',
    'set_delivery_address',
    'get_order_history',
    'reorder_from_history',
    'modify_order',
    'schedule_order',
  ] as const;

  for (const name of PHASE2_NAMES) {
    it(`${name}: throws feature_disabled when FEATURE_CUSTOMER_ORDER_PHASE2=false (default)`, async () => {
      const ctx = { conversationId, customerId, restaurantId };
      // Even with an obviously invalid payload, the gate must reject before
      // any handler or schema parsing runs.
      await expect(runTool(name, {}, ctx)).rejects.toMatchObject({
        code: 'feature_disabled',
      });
    });
  }

  it('toolDefinitions includes the six new phase 2 tools', () => {
    const names = toolDefinitions.map((t) => t.name);
    for (const name of PHASE2_NAMES) {
      expect(names).toContain(name);
    }
  });

  it('non-phase2 tools are NOT gated by the feature flag', async () => {
    // Sanity check: a normal tool (get_order_status) with no args should
    // either succeed or hit a different error code, never feature_disabled.
    // It will throw 'order_not_found' here because the customer has no orders.
    await expect(
      runTool('get_order_status', {}, { conversationId, customerId, restaurantId }),
    ).rejects.not.toMatchObject({ code: 'feature_disabled' });
  });
});

// File-level teardown — runs AFTER every describe (including the gated one)
// so the second describe's beforeAll can still talk to the DB.
afterAll(async () => {
  await closeDb();
  await closeRedis();
});
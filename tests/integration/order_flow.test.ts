/**
 * End-to-end test: webhook POST → conversation worker →
 * Gemini agent (mocked) → customer confirms → order created in DB.
 *
 * All external HTTP calls (Gemini, WhatsApp) are mocked. Postgres and Redis
 * are real (local docker compose).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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
  process.env.RESTAURANT_DEFAULT_DELIVERY_FEE_PAISA = '6000';
});

import {
  FakeGemini,
  geminiTextReply,
  geminiToolCall,
} from '../../src/testUtils/fakeGemini.js';
import { setFetchImpl } from '../../src/ai/gemini.js';

setFetchImpl(FakeGemini.fetchImpl as typeof fetch);

// ---------- mocks for outbound whatsapp ----------
vi.mock('../../src/whatsapp/client.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/whatsapp/client.js')>(
    '../../src/whatsapp/client.js',
  );
  return {
    ...actual,
    sendText: vi.fn().mockResolvedValue({ wamid: 'wamid.out.1', raw: {} }),
  };
});

// ---------- imports ----------
import db, { closeDb } from '../../src/db/client.js';
import { closeRedis, redis } from '../../src/redis/client.js';
import { seed } from '../../src/db/seed.js';
import { buildApp } from '../../src/index.js';
import { sign } from '../../src/webhook/verify.js';
import { config } from '../../src/config.js';
import * as ConversationService from '../../src/conversation/service.js';
import { runConversationTurn } from '../../src/ai/agent.js';
import { sendText } from '../../src/whatsapp/client.js';
import { findOrCreateByPhone } from '../../src/customer/service.js';

const here = dirname(fileURLToPath(import.meta.url));
const idsPath = join(here, '..', '..', 'data', 'menu-ids.json');

type Ids = {
  restaurant: Record<string, string>;
  item: Record<string, string>;
  variant: Record<string, string>;
};

let ids: Ids;
let restaurantId: string;
let restaurantPhoneNumberId: string;
let app: Awaited<ReturnType<typeof buildApp>>;
const TEST_PHONE = '+8801790000001';

describe('end-to-end order flow', () => {
  beforeAll(async () => {
    if (!existsSync(idsPath)) await seed();
    ids = JSON.parse(readFileSync(idsPath, 'utf8')) as Ids;
    restaurantId = ids.restaurant['hungry_bird']!;
    const r = await db.query<{ whatsapp_phone_number_id: string }>(
      `SELECT whatsapp_phone_number_id FROM restaurants WHERE id = $1`,
      [restaurantId],
    );
    restaurantPhoneNumberId = r[0]!.whatsapp_phone_number_id;
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    // cleanup test customer + their messages/conversations
    await db.query(`DELETE FROM customers WHERE phone_e164 = $1`, [TEST_PHONE]);
    await closeDb();
    await closeRedis();
  });

  beforeEach(async () => {
    FakeGemini.responses = [];
    FakeGemini.requests = [];
    vi.mocked(sendText).mockClear();
    await redis.flushdb();
    // Clean up orders from previous test to prevent leakage between tests.
    await db.query(
      `DELETE FROM orders WHERE customer_id IN (SELECT id FROM customers WHERE phone_e164 = $1)`,
      [TEST_PHONE],
    );
  });

  /**
   * Helper: post a text message webhook and run the conversation worker
   * synchronously (in this test we don't actually run the BullMQ worker —
   * we just call runConversationTurn directly).
   */
  async function postTextAndRun(textBody: string): Promise<{ reply: string; toolCalls: string[] }> {
    const wamid = `wamid.e2e.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    const body = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: restaurantPhoneNumberId },
                messages: [
                  {
                    from: TEST_PHONE.replace('+', ''),
                    id: wamid,
                    timestamp: '1700000000',
                    type: 'text',
                    text: { body: textBody },
                  },
                ],
              },
              field: 'messages',
            },
          ],
        },
      ],
    };
    const raw = Buffer.from(JSON.stringify(body));
    const signature = sign(raw, config.WHATSAPP_APP_SECRET);
    const res = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
      payload: raw,
    });
    expect(res.statusCode).toBe(200);

    const m = await db.query<{ id: string; conversation_id: string; transcript: string }>(
      `SELECT id, conversation_id, transcript FROM messages WHERE whatsapp_message_id = $1`,
      [wamid],
    );
    const conversationId = m[0]!.conversation_id;
    const customer = await findOrCreateByPhone(TEST_PHONE);

    const result = await runConversationTurn({
      conversationId,
      customerId: customer.id,
      restaurantId,
      userText: m[0]!.transcript ?? textBody,
    });
    return {
      reply: result.reply,
      toolCalls: result.toolCalls.map((t) => t.name),
    };
  }

  it('full flow: customer orders 2 chicken burgers, confirms → order in DB', async () => {
    // Turn 1: "2 ta chicken burger den" → model asks no clarification, just adds to cart
    FakeGemini.responses = [
      geminiToolCall('add_to_cart', {
        menu_item_id: ids.item['chicken_burger'],
        quantity: 2,
      }, 30),
      geminiTextReply('ঠিক আছে, ২টা চিকেন বার্গার। আর কিছু লাগবে?', 20),
    ];
    const t1 = await postTextAndRun('2 ta chicken burger den');
    expect(t1.reply).toMatch(/চিকেন বার্গার/);
    expect(t1.toolCalls).toContain('add_to_cart');

    // Turn 2: "2 ta coke o den" → adds coke
    FakeGemini.responses = [
      geminiToolCall('add_to_cart', {
        menu_item_id: ids.item['coke'],
        quantity: 2,
      }, 25),
      geminiTextReply('আর কিছু?', 15),
    ];
    await postTextAndRun('2 ta coke o den');

    // Turn 3: "bas. order koro" → summarize
    FakeGemini.responses = [
      geminiToolCall('summarize_cart_for_confirmation', {}, 30),
      geminiTextReply('অর্ডারটি কনফার্ম করবেন?', 10),
    ];
    await postTextAndRun('bas. order koro');

    // Turn 4: "হ্যাঁ" → create_order
    FakeGemini.responses = [
      geminiToolCall('create_order', { confirm: true }, 40),
      geminiTextReply('অর্ডার গ্রহণ করা হয়েছে!', 15),
    ];
    await postTextAndRun('হ্যাঁ');

    // Verify order in DB
    const customer = await findOrCreateByPhone(TEST_PHONE);
    const orders = await db.query<{
      id: string;
      state: string;
      subtotal_paisa: number;
      delivery_fee_paisa: number;
      total_paisa: number;
      items: Array<{ name: string; quantity: number; line_total_paisa: number }>;
    }>(
      `SELECT id, state, subtotal_paisa, delivery_fee_paisa, total_paisa, items
       FROM orders WHERE customer_id = $1`,
      [customer.id],
    );
    expect(orders.length).toBe(1);
    const order = orders[0]!;
    expect(order.state).toBe('pending');
    // 2×180 + 2×50 = 460; +60 delivery = 520
    expect(order.subtotal_paisa).toBe(46000);
    expect(order.delivery_fee_paisa).toBe(6000);
    expect(order.total_paisa).toBe(52000);
    expect(order.items).toHaveLength(2);

    const chickenLine = order.items.find((i) => i.name === 'Chicken Burger');
    expect(chickenLine!.quantity).toBe(2);
    expect(chickenLine!.line_total_paisa).toBe(36000);

    const cokeLine = order.items.find((i) => i.name === 'Coke');
    expect(cokeLine!.quantity).toBe(2);
    expect(cokeLine!.line_total_paisa).toBe(10000);

    // Cart should be cleared, conversation back to idle
    const conv = await ConversationService.getById(
      (await db.query<{ id: string }>(
        `SELECT id FROM conversations WHERE customer_id = $1 LIMIT 1`,
        [customer.id],
      ))[0]!.id,
    );
    expect(conv?.state).toBe('idle');
    expect(conv?.cart).toEqual([]);
  });

  it('rejects order when menu item is unavailable (turns off, then orders)', async () => {
    // Disable Chicken Burger for this test
    await db.query(`UPDATE menu_items SET is_available = false WHERE id = $1`, [
      ids.item['chicken_burger']!,
    ]);
    try {
      FakeGemini.responses = [
        geminiToolCall('add_to_cart', {
          menu_item_id: ids.item['chicken_burger'],
          quantity: 1,
        }, 10),
        // After tool error, agent returns apology
        geminiTextReply('দুঃখিত, এই মুহূর্তে Chicken Burger পাওয়া যাচ্ছে না।', 10),
      ];
      const result = await postTextAndRun('1 ta chicken burger den');
      expect(result.reply).toMatch(/পাওয়া যাচ্ছে না/);
      // No order created
      const customer = await findOrCreateByPhone(TEST_PHONE);
      const orders = await db.query(
        `SELECT id FROM orders WHERE customer_id = $1`,
        [customer.id],
      );
      expect(orders.length).toBe(0);
    } finally {
      await db.query(`UPDATE menu_items SET is_available = true WHERE id = $1`, [
        ids.item['chicken_burger']!,
      ]);
    }
  });
});
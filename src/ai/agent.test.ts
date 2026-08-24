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
import { runConversationTurn } from './agent.js';
import { systemPrompt } from './prompts.js';
import { toolDefinitions, runTool } from './tools.js';
import { setFetchImpl } from './gemini.js';
import {
  FakeGemini,
  useFakeGemini,
  geminiTextReply,
  geminiToolCall,
} from '../testUtils/fakeGemini.js';

const here = dirname(fileURLToPath(import.meta.url));
const idsPath = join(here, '..', '..', 'data', 'menu-ids.json');

type Ids = { restaurant: Record<string, string>; item: Record<string, string>; variant: Record<string, string> };

// ---------- Gemini mock (hoisted before vi.mock) ----------

useFakeGemini();
setFetchImpl(FakeGemini.fetchImpl as typeof fetch);

// ---------- tests ----------

let ids: Ids;
let restaurantId: string;
let customerId: string;
const TEST_PHONE = '+8801700006666';
let conversationId: string;

describe('AI agent (integration with mocked Gemini)', () => {
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
    FakeGemini.responses = [];
    FakeGemini.requests = [];
    // Clear any leftover cart state
    await ConversationService.clearCart(conversationId);
  });

  it('systemPrompt mentions the restaurant name and ৳ rule', () => {
    const sp = systemPrompt('TestH Restaurant');
    expect(sp).toMatch(/TestH Restaurant/);
    expect(sp).toMatch(/৳/);
    expect(sp).toMatch(/NEVER invent/);
  });

  it('toolDefinitions include search_menu, add_to_cart, create_order', () => {
    const names = toolDefinitions.map((t) => t.name);
    expect(names).toContain('search_menu');
    expect(names).toContain('add_to_cart');
    expect(names).toContain('create_order');
    expect(names).toContain('summarize_cart_for_confirmation');
  });

  it('runConversationTurn: simple text reply without tools', async () => {
    FakeGemini.responses = [
      geminiTextReply('আসসালামু আলাইকুম! কী অর্ডার করবেন?', 100),
    ];
    const r = await runConversationTurn({
      conversationId,
      customerId,
      restaurantId,
      userText: 'আসসালামু আলাইকুম',
    });
    expect(r.reply).toMatch(/অর্ডার/);
    expect(r.toolCalls).toEqual([]);
    expect(r.totalTokens).toBe(100);
  });

  it('runConversationTurn: tool call loop executes add_to_cart, then final reply', async () => {
    FakeGemini.responses = [
      geminiToolCall('add_to_cart', {
        menu_item_id: ids.item['chicken_burger'],
        quantity: 2,
      }, 50),
      geminiTextReply('ঠিক আছে, ২টা চিকেন বার্গার। আর কিছু লাগবে?', 30),
    ];
    const r = await runConversationTurn({
      conversationId,
      customerId,
      restaurantId,
      userText: '2 ta chicken burger den',
    });
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0]!.name).toBe('add_to_cart');
    expect(r.reply).toMatch(/চিকেন বার্গার/);

    // Cart should have 2 chicken burgers. Read from DB (the source of truth
    // snapshot) to avoid races with the Redis read in getCart.
    const conv = await ConversationService.getById(conversationId);
    expect(conv?.cart.length).toBe(1);
    expect(conv!.cart[0]!.quantity).toBe(2);
    expect(conv!.cart[0]!.name).toBe('Chicken Burger');
  });

  it('runConversationTurn: max iterations guard', async () => {
    // Always return tool_calls (loop won't terminate naturally)
    FakeGemini.responses = Array.from({ length: 10 }, () =>
      geminiToolCall('search_menu', { query: 'loop' }, 10),
    );
    const r = await runConversationTurn({
      conversationId,
      customerId,
      restaurantId,
      userText: 'loop test',
    });
    expect(FakeGemini.requests.length).toBe(5); // MAX_TOOL_ITERATIONS
    expect(r.reply).toMatch(/জটিল/);
  });

  it('runTool: unknown tool name throws', async () => {
    await expect(
      runTool('nonexistent', {}, { conversationId, customerId, restaurantId }),
    ).rejects.toThrow();
  });

  it('create_order rejects confirm:false', async () => {
    // Even though schema is `z.literal(true)`, defensively make sure.
    await expect(
      runTool('create_order', { confirm: false }, { conversationId, customerId, restaurantId }),
    ).rejects.toThrow();
  });
});
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://foodbot:foodbot@127.0.0.1:5432/foodbot';
  process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
  process.env.OPENAI_API_KEY = 'sk-test';
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

const here = dirname(fileURLToPath(import.meta.url));
const idsPath = join(here, '..', '..', 'data', 'menu-ids.json');

type Ids = { restaurant: Record<string, string>; item: Record<string, string>; variant: Record<string, string> };

// ---------- OpenAI mock (hoisted before vi.mock) ----------
type CompletionRequest = {
  messages: Array<Record<string, unknown>>;
  tools?: unknown[];
};
type CompletionResponse = {
  choices: Array<{
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
  }>;
  usage: { total_tokens: number };
};

const FakeOpenAI = vi.hoisted(() => {
  class Fake {
    static responses: CompletionResponse[] = [];
    static requests: CompletionRequest[] = [];
    chat: { completions: { create: (req: CompletionRequest) => Promise<CompletionResponse> } };
    constructor() {
      this.chat = {
        completions: {
          create: async (req: CompletionRequest) => {
            Fake.requests.push(req);
            const next = Fake.responses.shift();
            if (!next) throw new Error('FakeOpenAI: no responses queued');
            return next;
          },
        },
      };
    }
  }
  return Fake;
});

vi.mock('openai', () => ({
  default: FakeOpenAI,
}));

vi.mock('./client.js', () => ({
  openai: new FakeOpenAI(),
  recordTokens: () => undefined,
  budgetExceeded: () => false,
  tokensUsedToday: () => 0,
}));

// ---------- tests ----------

let ids: Ids;
let restaurantId: string;
let customerId: string;
const TEST_PHONE = '+8801700006666';
let conversationId: string;

describe('AI agent (integration with mocked OpenAI)', () => {
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
    FakeOpenAI.responses = [];
    FakeOpenAI.requests = [];
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
    const names = toolDefinitions.map((t) => t.function.name);
    expect(names).toContain('search_menu');
    expect(names).toContain('add_to_cart');
    expect(names).toContain('create_order');
    expect(names).toContain('summarize_cart_for_confirmation');
  });

  it('runConversationTurn: simple text reply without tools', async () => {
    FakeOpenAI.responses = [
      {
        choices: [
          { message: { role: 'assistant', content: 'আসসালামু আলাইকুম! কী অর্ডার করবেন?' } },
        ],
        usage: { total_tokens: 100 },
      },
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
    // First call: model wants to add to cart
    FakeOpenAI.responses = [
      {
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'add_to_cart',
                    arguments: JSON.stringify({
                      menu_item_id: ids.item['chicken_burger'],
                      quantity: 2,
                    }),
                  },
                },
              ],
            },
          },
        ],
        usage: { total_tokens: 50 },
      },
      // Second call: model gives final reply
      {
        choices: [
          { message: { role: 'assistant', content: 'ঠিক আছে, ২টা চিকেন বার্গার। আর কিছু লাগবে?' } },
        ],
        usage: { total_tokens: 30 },
      },
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

    // Cart should have 2 chicken burgers
    const cart = await ConversationService.getCart(conversationId);
    expect(cart.length).toBe(1);
    expect(cart[0]!.quantity).toBe(2);
    expect(cart[0]!.name).toBe('Chicken Burger');
  });

  it('runConversationTurn: max iterations guard', async () => {
    // Always return tool_calls (loop won't terminate naturally)
    FakeOpenAI.responses = Array.from({ length: 10 }, () => ({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'loop',
                type: 'function',
                function: {
                  name: 'search_menu',
                  arguments: JSON.stringify({ query: 'loop' }),
                },
              },
            ],
          },
        },
      ],
      usage: { total_tokens: 10 },
    }));
    const r = await runConversationTurn({
      conversationId,
      customerId,
      restaurantId,
      userText: 'loop test',
    });
    expect(FakeOpenAI.requests.length).toBe(5); // MAX_TOOL_ITERATIONS
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
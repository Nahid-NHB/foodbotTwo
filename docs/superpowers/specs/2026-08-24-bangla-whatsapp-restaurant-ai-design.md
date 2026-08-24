# Bangla WhatsApp Restaurant Ordering AI — Design

**Date:** 2026-08-24
**Status:** Approved (user said "go finish everything")
**Scope:** Phase 1 MVP only

## 1. Purpose

A voice-first WhatsApp ordering assistant for a single Bangladeshi restaurant. Customers send Bangla (or Banglish) voice or text messages; the system understands the order, validates it against the real menu, asks for clarification when ambiguous, and produces a confirmed order stored in PostgreSQL.

Out of scope for this phase: dashboard, TTS, payments, multi-restaurant, analytics, template messages.

## 2. Customer journey

1. Customer sends a Bangla voice or text message to the restaurant's WhatsApp Business number.
2. Webhook receives it, persists inbound message, returns 200 fast.
3. If voice: enqueue `audio.transcribe`. Worker downloads media, calls Whisper (`language: 'bn'`), writes transcript back to the message row, enqueues `conversation.process`.
4. If text: enqueue `conversation.process` directly.
5. Conversation worker loads message history, calls GPT-4o with system prompt + tool schema.
6. GPT selects tools; deterministic TS handlers perform menu lookup, cart manipulation, customer info updates.
7. GPT produces a Bangla reply; outbound message is enqueued to `whatsapp.send`.
8. Worker calls Meta Cloud API to send text reply.
9. Customer confirms ("হ্যাঁ"); agent calls `create_order({confirm: true})`; OrderService re-validates and inserts the order with a snapshot of items and prices.

## 3. Technology stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 20+, TypeScript (strict) |
| Web framework | Fastify (low overhead, JSON-schema validation built in) |
| LLM | OpenAI gpt-4o via `openai` SDK, native tool calling |
| Speech-to-text | OpenAI `whisper-1`, `language: 'bn'`, `temperature: 0` |
| Database | PostgreSQL 16 |
| Cache / queue state | Redis 7 |
| Queue | BullMQ |
| Validation | zod |
| Testing | Vitest + Supertest (for Fastify) |
| Lint / format | ESLint + Prettier |
| Container | Docker, docker-compose for local dev |

## 4. Database schema

PostgreSQL. Money stored as integer paisa (1 BDT = 100 paisa). All tables: `id uuid PK`, `created_at timestamptz`, `updated_at timestamptz` unless noted.

Tables:

- `restaurants` — Phase 1 has one row, but the table exists. Holds WhatsApp phone number ID and WABA ID.
- `categories` — Menu grouping ("Burger", "Pizza").
- `menu_items` — `name`, `description`, `price_paisa`, `is_available`, `search_text` (lower-cased name + aliases for trigram fuzzy search).GIN index on `search_text`.
- `menu_item_variants` — Size/type variations (Small/Medium/Large).
- `menu_item_addons` — Optional add-ons (Extra Cheese).
- `customers` — keyed by `phone_e164` UNIQUE.
- `conversations` — per-customer-per-restaurant session. `state` enum, `cart_snapshot jsonb`.
- `messages` — every inbound/outbound. `whatsapp_message_id` UNIQUE for idempotency. Stores `transcript`, `llm_input`, `llm_output`, `tool_calls`.
- `orders` — `state order_state` ENUM, `items jsonb` snapshot, totals in paisa.
- `order_events` — append-only audit of state changes.

## 5. API & webhook surface

| Method | Path | Purpose |
|---|---|---|
| GET | `/webhook` | Meta verification challenge |
| POST | `/webhook` | Inbound messages, status updates |
| GET | `/healthz` | Liveness |
| GET | `/readyz` | Readiness (DB + Redis ping) |
| GET | `/admin/queues/dlq` | List dead-letter jobs (basic auth) |

No public REST in Phase 1; all flows are webhook-driven.

## 6. AI agent design

GPT-4o receives:

- System prompt (in `src/ai/prompts.ts`) describing persona "Maya", language rules (Bangla + Banglish ok, never invent prices, never confirm without explicit yes, ask when ambiguous).
- Last 20 messages from the conversation.
- `tools=[...]` schema with deterministic handlers.

Loop:

1. Call `openai.chat.completions.create`.
2. If `tool_calls`: execute each handler (zod-validated args), append results, re-call. Max 5 iterations.
3. If `stop`: take assistant content as the reply.

Handlers (TS, deterministic):

- `search_menu(query?)` → trigram search
- `get_item_details(item_id)`
- `check_item_availability(item_id, variant_id?, addon_ids?)`
- `add_to_cart`, `update_cart_item`, `remove_from_cart`, `clear_cart`
- `calculate_order_total()`
- `summarize_cart_for_confirmation()` → returns formatted Bangla summary
- `get_customer_information()`, `update_customer_information()`
- `create_order({confirm: true})` → calls OrderService.confirm (server-side re-validates everything)
- `cancel_order(order_id, reason)`

Safety:

- `create_order` handler rejects unless `confirm === true`.
- OrderService always re-reads menu items and recomputes prices; never trusts GPT-supplied prices.
- Cart total is always computed server-side.
- LLM input/output/tool calls persisted on the `messages` row for audit.

## 7. Voice pipeline

```
voice message → webhook → queue audio.transcribe →
  download media (Meta graph API, 15s timeout, retry x3) →
  openai.audio.transcriptions.create({file, language:'bn', temperature:0}) →
  write messages.transcript → queue conversation.process
```

Cache: SHA-256 of `media_id` → transcript, 7-day TTL in Redis. Whisper is the slow step; queue it so the webhook stays fast. Failure modes (network, 5xx, rate limit) handled with exponential backoff (5s/15s/45s) and dead-lettering. On unrecoverable failure, send Bangla fallback: "ভাই, ভয়েসটা বুঝতে পারিনি, টেক্সটে লিখে দিবেন?"

## 8. Error handling

- Webhook returns 200 once message is persisted. Failures inside the pipeline do not produce 5xx (Meta would retry).
- BullMQ: 5 retries, exponential backoff, then dead-letter.
- Idempotency: `INSERT ... ON CONFLICT (whatsapp_message_id) DO NOTHING` before any side effect.
- All errors typed (`MenuItemNotFoundError`, etc.) → logged with request-id, never sent to customer verbatim (sent a polite Bangla reply instead).
- LLM daily token budget guard; if exceeded, switch to a static "please text instead" reply.

## 9. Conversation state machine

```
idle ⇄ ordering ⇄ awaiting_confirmation
                ordering ← (modify/cancel)
```

State stored in `conversations.state`. Cart in Redis `cart:{conversation_id}` (2h TTL) + snapshot in `conversations.cart_snapshot`.

## 10. Order state machine

```
pending → confirmed → preparing → ready → out_for_delivery → delivered
    ↘ cancelled ↙
```

Transitions validated server-side; every change appended to `order_events`.

## 11. Environment variables

```
DATABASE_URL
REDIS_URL
OPENAI_API_KEY
WHATSAPP_TOKEN
WHATSAPP_PHONE_NUMBER_ID
WHATSAPP_BUSINESS_ACCOUNT_ID
WHATSAPP_WEBHOOK_VERIFY_TOKEN
RESTAURANT_NAME
RESTAURANT_DEFAULT_DELIVERY_FEE_PAISA
PORT (default 3000)
LOG_LEVEL (default info)
NODE_ENV
WHISPER_MODEL (default whisper-1)
LLM_MODEL (default gpt-4o)
LLM_DAILY_TOKEN_BUDGET (default 500000)
ADMIN_BASIC_AUTH_USER
ADMIN_BASIC_AUTH_PASS
```

Validated at boot with zod (`src/config.ts`).

## 12. Folder structure

See `Design Section 8` of brainstorming. Layout:

```
src/
  index.ts config.ts logger.ts
  db/   redis/   queue/
  webhook/   whatsapp/   speech/
  ai/  conversation/  menu/  cart/  customer/  order/
  common/   admin/
data/menu.json
db/migrations/
docs/superpowers/specs/
docker-compose.yml
Dockerfile
package.json
tsconfig.json
vitest.config.ts
.env.example
```

## 13. MVP scope

In: WhatsApp text + voice (Bangla), GPT-4o with tool calling, cart + confirmation, Postgres persistence, state machine + audit, Docker Compose, Vitest unit + integration.

Out: TTS, dashboard, payments, multi-tenant, templates, analytics.

## 14. Open questions / known risks

- Whisper Bangla accuracy on noisy street recordings: mitigate by `language: 'bn'` hint and accepting that some messages will fall back to "please type instead".
- Meta 24h customer service window: free-form replies only within 24h of customer's last message. No templates in Phase 1.
- LLM latency on first call: cold start ~3-5s. Acceptable for ordering flow.
- Cost: ~$0.03/order assuming 3 turns × ~1500 tokens. Whisper adds ~$0.006/min of audio.

## 15. Implementation plan

Handed off to the writing-plans skill output.
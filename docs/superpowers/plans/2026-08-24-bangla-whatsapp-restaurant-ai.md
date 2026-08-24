# Bangla WhatsApp Restaurant AI MVP — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (this plan is executed inline in one session).

**Goal:** Ship a Phase 1 MVP: a Node/TypeScript service that takes WhatsApp Bangla/Banglish voice or text messages, extracts orders with GPT-4o + tools, validates against a seeded menu, and stores confirmed orders in PostgreSQL.

**Architecture:** Modular monolith. BullMQ queues for slow external calls (Whisper, Meta send). Postgres for persistence, Redis for cart + idempotency. Deterministic TS handlers behind OpenAI tool-calling.

**Tech Stack:** Node 20, TypeScript (strict), Fastify, PostgreSQL 16, Redis 7, BullMQ, OpenAI SDK (gpt-4o, whisper-1), zod, pino, Vitest, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-08-24-bangla-whatsapp-restaurant-ai-design.md`

## Global Constraints

- Node 20+, TypeScript `strict: true`, ESM modules.
- Money in **integer paisa** (1 BDT = 100 paisa). Never floats.
- All outbound API keys via env; `src/config.ts` validates with zod at boot.
- Logger: `pino` JSON output. Each request gets a `request_id`.
- All error types in `src/common/errors.ts`; never send raw exception text to customer.
- Webhook returns 200 once payload is persisted (idempotent via `whatsapp_message_id` UNIQUE).
- Tests live next to code: `src/foo/bar.ts` ↔ `src/foo/bar.test.ts`. Use Vitest.
- All commits use Conventional Commits (`feat:`, `chore:`, `test:`, `docs:`, `fix:`).
- Bangla replies: use ৳ for prices, keep concise, no emojis in critical info.

---

## Task 1: Project bootstrap

**Files:**
- Create: `package.json`, `tsconfig.json`, `.eslintrc.cjs`, `.prettierrc`, `vitest.config.ts`, `docker-compose.yml`, `Dockerfile`, `.env.example`, `README.md`, `src/index.ts`, `src/config.ts`, `src/logger.ts`

- [ ] **Step 1: package.json** — declare deps:
  - runtime: `fastify`, `pg`, `ioredis`, `bullmq`, `openai`, `zod`, `pino`, `pino-pretty`, `dotenv`
  - dev: `typescript`, `@types/node`, `@types/pg`, `tsx`, `vitest`, `@vitest/coverage-v8`, `eslint`, `@typescript-eslint/parser`, `@typescript-eslint/eslint-plugin`, `prettier`, `supertest`
  - scripts: `dev`, `build`, `start`, `test`, `test:watch`, `lint`, `format`, `migrate`, `seed`
- [ ] **Step 2: tsconfig.json** — `target: ES2022`, `module: ESNext`, `moduleResolution: bundler`, `strict: true`, `esModuleInterop: true`, `outDir: dist`, `rootDir: src`.
- [ ] **Step 3: vitest.config.ts** — node environment, coverage provider v8, include `src/**/*.test.ts`.
- [ ] **Step 4: docker-compose.yml** — services `postgres:16-alpine` (port 5432, env POSTGRES_DB=foodbot, POSTGRES_USER=foodbot, POSTGRES_PASSWORD=foodbot), `redis:7-alpine` (port 6379), `app` (build context, depends_on, command `npm run dev`, port 3000).
- [ ] **Step 5: Dockerfile** — multi-stage: builder (`npm ci && npm run build`), runtime (`node:20-alpine`, copy dist + node_modules, expose 3000).
- [ ] **Step 6: .env.example** — all variables from spec §11 with empty values + comments.
- [ ] **Step 7: src/config.ts** — zod schema; `export const config = parseConfig(process.env)`; throws on boot if missing.
- [ ] **Step 8: src/logger.ts** — `pino({ level: config.LOG_LEVEL })` exported as `logger`.
- [ ] **Step 9: src/index.ts** — minimal Fastify with `GET /healthz` returning `{ok:true}`.
- [ ] **Step 10: README.md** — setup, env, `docker compose up`, `npm run migrate`, `npm run seed`, Meta dashboard notes.
- [ ] **Step 11: Tests** — `src/config.test.ts` (valid + invalid env), `src/logger.test.ts` (name + level).
- [ ] **Step 12: Run `npm test` — green.**
- [ ] **Step 13: Commit** `chore: project bootstrap (ts, fastify, docker, vitest)`.

---

## Task 2: Database migrations + seed

**Files:**
- Create: `db/migrations/001_init.sql`, `data/menu.json`, `src/db/client.ts`, `src/db/migrate.ts`, `src/db/seed.ts`

- [ ] **Step 1: 001_init.sql** — full schema from spec §4 (restaurants, categories, menu_items, menu_item_variants, menu_item_addons, customers, conversations, messages, orders, order_events). Include `CREATE EXTENSION IF NOT EXISTS pg_trgm` and indexes.
- [ ] **Step 2: src/db/client.ts** — `pg.Pool` singleton built from `config.DATABASE_URL`. Exports `query(text, params)` helper.
- [ ] **Step 3: src/db/migrate.ts** — CLI: reads all `*.sql` from `db/migrations/`, applies in order, tracks applied in `_migrations` table.
- [ ] **Step 4: data/menu.json** — single restaurant "Hungry Bird" with categories Burger (Chicken 180, Beef 220, Cheese add-on 30), Pizza (Small 300, Medium 500, Large 700), Drinks (Coke 50, Water 20), Biryani (Chicken Biryani 250, Beef Biryani 320). Include `search_text` aliases like "চিকেন বার্গার", "chicken burger", "ckn burger".
- [ ] **Step 5: src/db/seed.ts** — CLI: idempotent insert (`ON CONFLICT (id) DO NOTHING`) for restaurant + categories + items + variants + add-ons.
- [ ] **Step 6: Tests** — `src/db/migrate.test.ts` (runs migrations against a temp DB), `src/db/seed.test.ts` (loads JSON, asserts row counts).
- [ ] **Step 7: Run migrations + seed against local docker compose.** Verify rows.
- [ ] **Step 8: Commit** `feat(db): migrations, seed loader, menu json`.

---

## Task 3: Common utilities (money, errors, ids)

**Files:**
- Create: `src/common/money.ts`, `src/common/errors.ts`, `src/common/id.ts`, plus tests

- [ ] **Step 1: src/common/money.ts** — `formatBDT(paisa: number): string` returns `"৳1,234"`; `toPaisa(bdt: number): number`; `fromPaisa(paisa): number`. Pure, no I/O.
- [ ] **Step 2: src/common/errors.ts** — `AppError`, `MenuItemNotFoundError`, `MenuItemUnavailableError`, `CartEmptyError`, `OrderNotConfirmableError`, `InvalidStateTransitionError`. Each extends `AppError` with `code: string` and Bangla `customerMessage: string`.
- [ ] **Step 3: src/common/id.ts** — `newId(): string` using `crypto.randomUUID()`.
- [ ] **Step 4: Tests** — cover each function with happy + edge cases (0, large numbers, negative).
- [ ] **Step 5: Commit** `feat(common): money, errors, id utilities`.

---

## Task 4: Menu service

**Files:**
- Create: `src/menu/types.ts`, `src/menu/service.ts`, `src/menu/service.test.ts`

- [ ] **Step 1: types.ts** — interfaces `MenuItem`, `MenuItemVariant`, `MenuItemAddon`, `MenuSearchResult`.
- [ ] **Step 2: service.ts** — `searchMenu(query?: string, restaurantId: string)` (trigram ILIKE on `search_text` + name, limit 10), `getItemDetails(itemId, restaurantId)`, `checkAvailability(itemId, variantId?, addonIds?)` returns `{available, reason?}`.
- [ ] **Step 3: Tests** — with a seeded test DB: search by banglish ("ckn burger") returns Chicken Burger; unavailable item returns false; nonexistent id throws `MenuItemNotFoundError`.
- [ ] **Step 4: Commit** `feat(menu): search, getDetails, availability with tests`.

---

## Task 5: Cart service

**Files:**
- Create: `src/cart/types.ts`, `src/cart/service.ts`, `src/cart/service.test.ts`

- [ ] **Step 1: types.ts** — `CartItem { menu_item_id, name, quantity, unit_price_paisa, variant_id?, variant_name?, addon_ids[], addons: {id,name,price_paisa}[], line_total_paisa }`, `Cart { items: CartItem[], subtotal_paisa, delivery_fee_paisa, total_paisa }`.
- [ ] **Step 2: service.ts** — `addToCart`, `updateQuantity`, `removeFromCart`, `clearCart`, `getCart`, `calculateTotal`. Each calls MenuService to fetch current price — never trusts caller-supplied prices. Throws `MenuItemUnavailableError` if item not available. Snapshots name at time of add so later menu changes don't mutate cart.
- [ ] **Step 3: Tests** — add two items, total correct; update qty; remove; unavailable item rejected; price snapshot stable even if menu price changes.
- [ ] **Step 4: Commit** `feat(cart): cart math + validation, server-side pricing`.

---

## Task 6: Customer service

**Files:**
- Create: `src/customer/types.ts`, `src/customer/service.ts`, `src/customer/service.test.ts`

- [ ] **Step 1: types.ts** — `Customer { id, phone_e164, name?, default_address?, payment_method?, ... }`.
- [ ] **Step 2: service.ts** — `findOrCreateByPhone(phone_e164)` upsert; `getById(id)`; `update(id, patch)`.
- [ ] **Step 3: Tests** — create then find; update fields; phone uniqueness.
- [ ] **Step 4: Commit** `feat(customer): phone-keyed upsert`.

---

## Task 7: Order service + state machine

**Files:**
- Create: `src/order/types.ts`, `src/order/state.ts`, `src/order/service.ts`, `src/order/service.test.ts`

- [ ] **Step 1: state.ts** — `OrderState` type + `canTransition(from, to): boolean` function. Allowed: `pending→confirmed`, `pending→cancelled`, `confirmed→preparing`, `confirmed→cancelled`, `preparing→ready`, `ready→out_for_delivery`, `out_for_delivery→delivered`.
- [ ] **Step 2: service.ts** — `createOrder({customer_id, items, delivery_address, payment_method, special_instructions})` builds order row + appends `order_events`. **Re-reads each menu_item by id, re-computes every price server-side; rejects if any item missing or unavailable.** `transition(orderId, to, actor, note?)` validates + writes event.
- [ ] **Step 3: Tests** — happy path create + transitions; price mismatch rejected; invalid transition throws; cancelled order cannot transition to confirmed.
- [ ] **Step 4: Commit** `feat(order): state machine + server-side revalidation`.

---

## Task 8: Conversation service + Redis cart

**Files:**
- Create: `src/redis/client.ts`, `src/conversation/types.ts`, `src/conversation/service.ts`, `src/conversation/state.ts`, `src/conversation/service.test.ts`

- [ ] **Step 1: src/redis/client.ts** — `ioredis` from `config.REDIS_URL`.
- [ ] **Step 2: conversation/state.ts** — `canTransitionConversation(from, to): boolean`. Allowed: `idle→ordering`, `ordering→awaiting_confirmation`, `awaiting_confirmation→ordering`, `awaiting_confirmation→idle`.
- [ ] **Step 3: conversation/service.ts** — `getOrCreate(customerId, restaurantId)` returns Conversation with redis-backed cart key `cart:{conv_id}` (2h TTL). Helpers: `setCart`, `getCart`, `clearCart`. Each write also persists snapshot to `conversations.cart_snapshot`.
- [ ] **Step 4: Tests** — round-trip cart, TTL set, snapshot persisted.
- [ ] **Step 5: Commit** `feat(conversation): redis cart + state machine`.

---

## Task 9: AI agent (GPT-4o + tool calling)

**Files:**
- Create: `src/ai/client.ts`, `src/ai/prompts.ts`, `src/ai/tools/{index.ts,menu.tools.ts,cart.tools.ts,customer.tools.ts,order.tools.ts,summarize.ts}`, `src/ai/agent.ts`, `src/ai/agent.test.ts`

- [ ] **Step 1: client.ts** — exports `openai = new OpenAI({apiKey: config.OPENAI_API_KEY})`.
- [ ] **Step 2: prompts.ts** — `systemPrompt(restaurantName: string): string` with persona "Maya", Bangla rules, hard rules (no inventing, always confirm, ask when ambiguous, use ৳).
- [ ] **Step 3: tools/** — each file exports `{definitions: ChatCompletionTool[], handlers: Record<string, ToolHandler>}` where `ToolHandler = (args, ctx) => Promise<string>`. All args validated with zod schemas. Handlers return JSON-stringified results.
- [ ] **Step 4: agent.ts** — `runConversationTurn({conversation, message, history, ctx}): Promise<{reply: string, toolCalls: ToolCall[]}>`. Loads history (last 20), calls OpenAI, executes tool calls (max 5 iterations), persists llm_input/llm_output/tool_calls to the messages row.
- [ ] **Step 5: Tests** — with `vi.mock('openai')`: stub returns a tool_call → handler executes and result returned to model; final assistant reply returned; max-iteration guard kicks in.
- [ ] **Step 6: Commit** `feat(ai): gpt-4o agent with deterministic tool handlers`.

---

## Task 10: Whisper STT client

**Files:**
- Create: `src/speech/whisper.ts`, `src/speech/whisper.test.ts`

- [ ] **Step 1: whisper.ts** — `transcribe(buffer: Buffer, mimeType: string): Promise<string>` calls `openai.audio.transcriptions.create({file, model: config.WHISPER_MODEL, language: 'bn', temperature: 0, response_format: 'json'})`.
- [ ] **Step 2: Tests** — mock OpenAI client, assert bangla language hint + temperature 0 passed; return value unwrapped.
- [ ] **Step 3: Commit** `feat(speech): whisper client with bn hint`.

---

## Task 11: WhatsApp client

**Files:**
- Create: `src/whatsapp/client.ts`, `src/whatsapp/messages.ts`, `src/whatsapp/media.ts`, `src/whatsapp/messages.test.ts`

- [ ] **Step 1: client.ts** — `sendText({to, body}): Promise<{wamid, ...}>` POSTs to `https://graph.facebook.com/v20.0/{PHONE_NUMBER_ID}/messages` with bearer auth.
- [ ] **Step 2: media.ts** — `downloadMedia(mediaId): Promise<Buffer>` GETs the media_url returned by Meta, follows redirect.
- [ ] **Step 3: messages.ts** — text message builder matching Meta schema.
- [ ] **Step 4: Tests** — mock `fetch` (or use undici MockAgent) and assert correct URL, headers, body.
- [ ] **Step 5: Commit** `feat(whatsapp): meta cloud api client (send + media)`.

---

## Task 12: BullMQ queues

**Files:**
- Create: `src/queue/index.ts`, `src/queue/audio.transcribe.ts`, `src/queue/whatsapp.send.ts`, `src/queue/conversation.process.ts`, `src/queue/index.test.ts`

- [ ] **Step 1: index.ts** — exports `audioQueue`, `sendQueue`, `processQueue` (BullMQ Queue instances) + `createWorkers()` that registers processors and returns `{close}`.
- [ ] **Step 2: audio.transcribe.ts** — worker fetches message + media, downloads, calls whisper, updates transcript, enqueues `conversation.process`.
- [ ] **Step 3: whatsapp.send.ts** — worker calls `whatsapp.client.sendText`.
- [ ] **Step 4: conversation.process.ts** — worker invokes `ai.agent.runConversationTurn`, enqueues `whatsapp.send` with reply, persists outbound message row.
- [ ] **Step 5: Tests** — happy path with mocked whisper + openai + meta; retry behavior on simulated failure.
- [ ] **Step 6: Commit** `feat(queue): bullmq workers for transcribe/send/process`.

---

## Task 13: Webhook router + signature verification

**Files:**
- Create: `src/webhook/router.ts`, `src/webhook/verify.ts`, `src/webhook/router.test.ts`

- [ ] **Step 1: verify.ts** — `verifySignature(rawBody: Buffer, signatureHeader: string, appSecret: string): boolean` using HMAC SHA-256 constant-time compare.
- [ ] **Step 2: router.ts** — `GET /webhook` accepts `hub.mode=subscribe`, `hub.verify_token`, `hub.challenge` (returns challenge if token matches). `POST /webhook` verifies signature, parses payload, for each `messages[]` entry: idempotently inserts `messages` row (ON CONFLICT DO NOTHING), if `type=text` enqueues `conversation.process`, if `type=audio` enqueues `audio.transcribe`. Returns 200 fast.
- [ ] **Step 3: Tests** — verification challenge succeeds/fails; signature valid/invalid; duplicate `wamid` does not double-enqueue; voice message goes to transcribe queue.
- [ ] **Step 4: Commit** `feat(webhook): signature verify, idempotency, queue dispatch`.

---

## Task 14: Wire it all up + admin endpoints

**Files:**
- Modify: `src/index.ts`
- Create: `src/admin/queues.ts`

- [ ] **Step 1: index.ts** — build Fastify, register webhook router, mount admin router, call `createWorkers()`, listen on `config.PORT`. Graceful shutdown closes workers + DB + Redis.
- [ ] **Step 2: src/admin/queues.ts** — basic-auth-protected `GET /admin/queues/dlq` lists failed jobs (count + sample).
- [ ] **Step 3: Commit** `feat: boot webhooks + workers + admin endpoint`.

---

## Task 15: End-to-end integration test + README polish

**Files:**
- Create: `tests/integration/order_flow.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Integration test** — boots the full app against a test Postgres + Redis, mocks OpenAI + Whisper + Meta fetch. Simulates:
  1. POST `/webhook` with text "2 ta chicken burger den"
  2. assert `audio.transcribe` not enqueued
  3. assert `conversation.process` worker runs
  4. stubbed agent asks for variant clarification (returns tool_call `add_to_cart` then a clarification message)
  5. user replies "plain" → cart = 2× Chicken Burger
  6. user replies "হ্যাঁ" to confirmation → `orders` row exists, state=`pending`, items snapshotted, totals match menu.
- [ ] **Step 2: README** — full setup, env vars, Meta dashboard config, ngrok instructions, sample `curl` for webhook test.
- [ ] **Step 3: Run full `npm test`** — all green.
- [ ] **Step 4: `docker compose up` + load menu.json + simulate webhook end-to-end.** Document results in README.
- [ ] **Step 5: Commit** `test(e2e): webhook → confirmed order` + `docs: README`.

---

## Self-review checklist (run before declaring done)

- [ ] All spec sections mapped to at least one task.
- [ ] No "TBD"/"TODO" in any task.
- [ ] Type names consistent across tasks (e.g. `MenuItem`, `CartItem`, `Conversation`, `Order`).
- [ ] Money always in `*_paisa: number` int.
- [ ] Every service has a test task.
- [ ] Webhook is idempotent + verified.
- [ ] Order always revalidated server-side.
- [ ] TDD: failing test written before implementation in every service.
- [ ] Each task ends in a commit.

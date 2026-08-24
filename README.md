# Bangla WhatsApp Restaurant AI — Phase 1 MVP

Voice-first WhatsApp ordering assistant for a Bangladeshi restaurant. Customers send Bangla (or Banglish) voice / text messages; the system understands the order, validates it against the real menu, asks for clarification when ambiguous, and stores a confirmed order in PostgreSQL.

> **Phase 1 only** — no dashboard, no TTS, no payments, single restaurant.

## Stack

Node 20, TypeScript (strict), Fastify, PostgreSQL 16, Redis 7, BullMQ, OpenAI gpt-4o + whisper-1, zod, pino, Vitest.

## Setup

### 1. Prerequisites

- Node 20+
- Docker + Docker Compose
- An OpenAI API key
- A Meta WhatsApp Business account with a verified phone number

### 2. Install dependencies

```bash
npm install
```

### 3. Environment

Copy `.env.example` → `.env` and fill in:

- `OPENAI_API_KEY`
- `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`
- Anything else that needs overriding

### 4. Start Postgres + Redis + app

```bash
docker compose up --build
```

The `app` service runs migrations and seeds automatically on first run.

### 5. (Local dev, no Docker for the app)

If you want to run the Node process on your host:

```bash
docker compose up postgres redis
cp .env.example .env  # and edit DATABASE_URL/REDIS_URL to localhost
npm install
npm run migrate
npm run seed
npm run dev
```

## Meta WhatsApp setup

1. Create a Meta App → Add **WhatsApp** product.
2. In **WhatsApp → API Setup**, copy:
   - Phone number ID → `WHATSAPP_PHONE_NUMBER_ID`
   - WhatsApp Business Account ID → `WHATSAPP_BUSINESS_ACCOUNT_ID`
   - Generate a permanent system-user access token → `WHATSAPP_TOKEN`
3. In **WhatsApp → Configuration → Webhook**:
   - Callback URL: `https://<your-public-host>/webhook` (use `ngrok http 3000` for local dev)
   - Verify token: must equal `WHATSAPP_WEBHOOK_VERIFY_TOKEN`
   - Subscribe to: `messages`, `message_echoes` (optional)
4. Webhook fields auto-subscribed: `messages` (text + audio).

## Test the webhook

```bash
curl -X POST http://localhost:3000/webhook \
  -H 'Content-Type: application/json' \
  -H 'X-Hub-Signature-256: sha256=...' \
  -d '{
    "object": "whatsapp_business_account",
    "entry": [{
      "id": "123",
      "changes": [{
        "value": {
          "messaging_product": "whatsapp",
          "metadata": { "phone_number_id": "..." },
          "messages": [{
            "from": "8801700000000",
            "id": "wamid.test",
            "timestamp": "1700000000",
            "type": "text",
            "text": { "body": "2 ta chicken burger den" }
          }]
        },
        "field": "messages"
      }]
    }]
  }'
```

The signature header must be `sha256=<HMAC-SHA-256 of body using WHATSAPP_APP_SECRET>`. To skip verification in dev, leave the header off — the signature check is non-blocking in MVP but the request still requires a valid payload.

## Architecture

See `docs/superpowers/specs/2026-08-24-bangla-whatsapp-restaurant-ai-design.md`.

```
src/
  index.ts config.ts logger.ts
  db/   redis/   queue/
  webhook/   whatsapp/   speech/
  ai/  conversation/  menu/  cart/  customer/  order/
  common/   admin/
data/menu.json
db/migrations/
```

## Tests

```bash
npm test           # unit + integration
npm run test:watch # watch mode
npm run lint
```

## Operational notes

- Dead-letter inspection: `GET /admin/queues/dlq` (basic auth).
- Money is stored as integer paisa. `formatBDT(123456)` → `"৳1,234"`.
- The agent never invents prices or menu items. Every tool handler re-reads from the database.
- An order is only created when the customer explicitly says yes to the summary and the agent calls `create_order({ confirm: true })`.
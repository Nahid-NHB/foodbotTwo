# Customer Order Features — Phase 2

**Date:** 2026-08-27
**Status:** Approved (user said "go" through all design sections)
**Scope:** Phase 2 customer-facing order features. Extends the Phase 1 MVP without breaking its API.

## 1. Purpose

Phase 1 proved the WhatsApp → agent → order loop. Phase 2 gives the customer the things that turn a one-shot order into a relationship:

1. **Order status tracking** with proactive push notifications when the kitchen moves the order.
2. **Order history & one-tap reorder** so repeat customers don't retype the same items.
3. **Modify / cancel order** after placement (items + quantities, while still in the early states).
4. **Delivery address + ETA + scheduling** so the customer knows when the food will arrive and can pre-order.

All four are layered on the existing service stack. The agent's role stays the same — Bangla conversation, tool-calling loop, server-side revalidation. We extend the tool surface and the data model behind it.

Out of scope: real geocoding, live driver tracking, multi-restaurant, payments, owner dashboard.

## 2. Customer journeys

### 2.1 Status tracking + push

- After `create_order`, every state transition triggers a localized Bangla push to the customer via WhatsApp.
- The customer can ask "আমার অর্ডার কোথায়?" at any time. Agent calls `get_order_status`, gets the current state plus the list of sent notifications, and replies.
- Meta's `message_status` webhook updates `delivered_at` on the matching `order_status_notifications` row.

### 2.2 History & reorder

- "আমার আগের অর্ডারটা দেখান" → agent calls `get_order_history(limit=5)`, reads back the items + totals.
- "আবার দিন" → agent calls `reorder_from_history(order_id)`. Server revalidates every line against the live menu. Unavailable items come back as a partial-failure report so the agent can ask "এগুলো পাওয়া যাচ্ছে না, বাকিগুলো দিই?" — never silent drop.
- On confirmation, survivors populate the conversation cart. Same summary + `create_order` flow as a fresh order.

### 2.3 Modify / cancel

- Customer can modify an order's items as long as the order is `pending` or `confirmed`. After the kitchen starts cooking (`preparing`), modifications are rejected with a clear Bangla message.
- Two-step tool: `modify_order(order_id)` (no args) returns the current items as a structured list; the agent shows them; the customer edits; agent calls `modify_order(order_id, { items, confirm: true })`. Server revalidates, audits, updates totals.
- `cancel_order` already exists. We tighten "most recent" on `get_order_status` so cancelled/delivered orders don't shadow an in-flight order.

### 2.4 Address + ETA + scheduling

- Customer picks a delivery zone (Dhanmondi / Mohammadpur / Mirpur for v1). The agent calls `get_delivery_zones`, the customer picks one, then `set_delivery_address({zone_id, line1, ...})` saves a structured address.
- ETA is `now + zone.eta_minutes` for immediate orders, or `requested_for + zone.eta_minutes` for scheduled. Surfaced in the summary text and in `get_order_status`.
- `schedule_order(order_id, requested_for_iso)` sets a future pickup time (max 7 days out). The order sits at `confirmed` until the time is reached; kitchen transitions follow the normal flow.

## 3. Architecture

**Layers (no breaking changes to existing API or webhook contract):**

- **DB** — new migration `002_customer_order_features.sql`. Adds tables: `delivery_zones`, `customer_addresses`, `order_status_notifications`, `order_modifications`. Extends `orders` with `requested_for timestamptz` and `delivery_zone_id uuid`.
- **Domain services** — new modules under `src/`:
  - `src/delivery/` — `DeliveryZoneService`, `CustomerAddressService`
  - `src/order/notifications.ts` — `OrderNotificationService` (idempotent record + enqueue)
  - `src/order/modifications.ts` — `OrderModificationService` (validate, audit, apply)
  - `src/order/service.ts` — extract shared `MenuRevalidator`, add `listHistoryByCustomer`, `modifyItems`, hook notification enqueue into `transition`
- **State machines**:
  - `OrderState` — no new order states. Modify is gated in service (state ∈ {pending, confirmed}).
  - `ConversationState` — add `'awaiting_modify_confirmation'` for the two-step modify flow.
- **AI tools** (added to `toolDefinitions` and `handlers`):
  - `get_delivery_zones`
  - `set_delivery_address`
  - `get_order_history`
  - `reorder_from_history`
  - `modify_order` (two-phase)
  - `schedule_order`
- **Push notifications** — every `OrderService.transition` call now also calls `OrderNotificationService.recordAndEnqueue`. Idempotent on `(order_id, to_state)`. Worker delivers via existing `whatsapp.send` queue; Meta `message_status` callback updates `delivered_at`.
- **Webhook** — extend `src/webhook/router.ts` to handle `message_status` payloads (not just `messages`).
- **UI (`web/`)** — incremental additions to the test chat: "Recent orders" card, "Track latest" card, "Latest address" card, "Modify" modal. No layout redesign.

**Feature flag** — `FEATURE_CUSTOMER_ORDER_PHASE2=true` (default off in v1). Lets us ship the migration + seed first, then enable the code path in dev, then prod, then drop the flag.

## 4. Data model (migration `002`)

```sql
CREATE TABLE IF NOT EXISTS delivery_zones (
  id uuid PRIMARY KEY,
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name text NOT NULL,
  eta_minutes int NOT NULL CHECK (eta_minutes > 0),
  delivery_fee_paisa int NOT NULL CHECK (delivery_fee_paisa >= 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, name)
);

CREATE TABLE IF NOT EXISTS customer_addresses (
  id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  zone_id uuid NOT NULL REFERENCES delivery_zones(id) ON DELETE RESTRICT,
  line1 text NOT NULL,
  line2 text,
  note_for_rider text,
  is_default boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_customer_addresses_default
  ON customer_addresses(customer_id) WHERE is_default;

CREATE TABLE IF NOT EXISTS order_status_notifications (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  to_state order_state NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  failed_reason text,
  UNIQUE (order_id, to_state)
);

CREATE TABLE IF NOT EXISTS order_modifications (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  old_items jsonb NOT NULL,
  new_items jsonb NOT NULL,
  old_total_paisa int NOT NULL,
  new_total_paisa int NOT NULL,
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS requested_for timestamptz,
  ADD COLUMN IF NOT EXISTS delivery_zone_id uuid REFERENCES delivery_zones(id) ON DELETE SET NULL;
```

**Seed additions:**

- 3 zones: Dhanmondi (30 min, 40 BDT), Mohammadpur (35 min, 50 BDT), Mirpur (45 min, 60 BDT).
- Backfill: for each customer with a non-null `default_address` and no `customer_addresses` row, create a structured address with `zone_id = NULL` flagged as legacy (no zone = falls back to `RESTAURANT_DEFAULT_DELIVERY_FEE_PAISA`).

## 5. New + modified tools

### New tools

| Tool | Args | Returns | Errors |
|---|---|---|---|
| `get_delivery_zones` | `{restaurant_id?}` (defaults to ctx) | `{zones: [{id, name, eta_minutes, delivery_fee_paisa}]}` | — |
| `set_delivery_address` | `{zone_id, line1, line2?, note_for_rider?}` | `{address, eta_minutes, delivery_fee_paisa}` | `address_missing_zone`, `zone_not_found` |
| `get_order_history` | `{limit?: number (default 5, max 20), before_iso?: string}` | `{orders: [{id, items_summary, total_display, state, created_at, delivered_at}]}` | `no_history` |
| `reorder_from_history` | `{order_id, proceed_with?: 'all' \| 'available_only'}` | `{available: [...], unavailable: [{name, reason}], cart_populated: boolean}` | `no_history`, `nothing_available`, `items_unavailable`. Allowed for any past order owned by the customer (delivered, cancelled, or completed); unavailable items come back in the report. |
| `modify_order` (phase 1: read) | `{order_id}` | `{current_items: [...]}` | `order_not_found`, `order_not_modifiable` |
| `modify_order` (phase 2: apply) | `{order_id, items, confirm: true}` | `{order_id, items, total_paisa, total_display, modified_at}` | `order_not_found`, `order_not_modifiable` |
| `schedule_order` | `{order_id, requested_for_iso}` | `{order_id, requested_for, eta_minutes, eta_iso}` | `bad_schedule_window`, `order_not_found` |

### Modified tools

- `get_order_status` — narrow "most recent" default to active states only; add `include_history?: bool` flag to include cancelled/delivered; always include `notifications: [{to_state, sent_at, delivered_at}]`.
- `summarize_cart_for_confirmation` — if customer has a default `customer_addresses` row, use its zone's fee; otherwise fall back to `RESTAURANT_DEFAULT_DELIVERY_FEE_PAISA`.
- `create_order` — also write `orders.delivery_zone_id` from the customer's default address (if any).
- `cancel_order` — no change; ownership check is already correct.

## 6. Data flow

### 6.1 Status tracking + push

1. `OrderService.transition(id, to, actor, note)` runs in a transaction (existing).
2. After COMMIT, call `OrderNotificationService.recordAndEnqueue(order, fromState, toState)`.
3. `recordAndEnqueue`: `INSERT INTO order_status_notifications (id, order_id, to_state, sent_at) ON CONFLICT (order_id, to_state) DO NOTHING RETURNING id`. If a row was inserted, enqueue a `whatsapp.send` job with a per-state Bangla template. If conflict, no-op.
4. The `whatsapp.send` worker renders the template, sends via Meta Cloud API, updates `sent_at` (set on insert) and on success/failure writes `failed_reason` if Meta returns an error.
5. Meta's `message_status` callback (`delivered` / `read` / `failed`) updates `order_status_notifications.delivered_at` by matching `whatsapp_message_id` on the message row → notification row.

### 6.2 Order history & reorder

1. `get_order_history(limit, before_iso)` → `OrderService.listHistoryByCustomer(customerId, {limit, before})`. Returns a summary view (no full items JSON) plus item names joined for display.
2. `reorder_from_history(order_id)`:
   - Load original `orders.items` snapshot.
   - Re-validate each line (same `MenuRevalidator` used by `confirm` and `modifyItems`).
   - Return `{available, unavailable}`. If `unavailable.length > 0` and `proceed_with` is not set, return as a partial-failure tool result; agent asks the customer.
   - If `proceed_with: 'available_only'`, copy survivors into `ConversationService.setCart`, transition to `ordering`, return `cart_populated: true`.
   - If everything unavailable, return `nothing_available` and leave the cart untouched.
3. Reorder never auto-creates the order. The same summary + `create_order` flow applies.

### 6.3 Modify order

1. `modify_order(order_id)` (no items arg) → load order, assert ownership, assert state ∈ {pending, confirmed}, return `current_items`.
2. Customer responds. Agent calls `modify_order(order_id, {items, confirm: true})`.
3. Server: `BEGIN`, `SELECT ... FOR UPDATE` on the order row to serialize concurrent modifies, revalidate items via shared `MenuRevalidator`, recompute totals, `UPDATE orders SET items, subtotal_paisa, delivery_fee_paisa, total_paisa, updated_at = now()`, `INSERT INTO order_modifications (...)`, `INSERT INTO order_events (..., 'items modified', 'customer')`, `COMMIT`.
4. No notification on modify — the order's state didn't change, so existing notifications remain valid. Agent tells the customer the new total in the next reply.

### 6.4 Address + ETA + scheduling

1. `get_delivery_zones` returns the active zones.
2. `set_delivery_address({zone_id, line1, line2?, note_for_rider?})` saves the address and returns `{address, eta_minutes, delivery_fee_paisa}`. The latest address per customer has `is_default = true`; previous defaults are flipped to `false` in the same transaction.
3. `schedule_order(order_id, requested_for_iso)`:
   - Validate `requested_for > now()` and `requested_for <= now() + 7 days`.
   - `UPDATE orders SET requested_for = $1 WHERE id = $2 AND state IN ('pending','confirmed','preparing')`.
   - Return `{order_id, requested_for, eta_minutes, eta_iso}`. ETA is `requested_for + zone.eta_minutes`.
4. The summary template uses the zone's fee (or the global default if no zone is set). `get_order_status` includes `eta_minutes` and `eta_iso` for the customer to query later.

### 6.5 Conversational state

- New `ConversationState` value: `'awaiting_modify_confirmation'`.
- `modify_order` (read phase) sets it. Customer says yes/no → apply or revert, then back to `'idle'`.

## 7. Error handling

**Tool error taxonomy** (matches existing `ToolError`):

- `order_not_found` — never leak existence; used for both not-found and not-owned.
- `order_not_modifiable` — wrong state for modify / schedule.
- `order_already_delivered` — terminal state.
- `items_unavailable` — partial reorder.
- `nothing_available` — full reorder failure.
- `no_history` — never ordered.
- `address_missing_zone` — zone not provided.
- `zone_not_found` — invalid zone id.
- `bad_schedule_window` — past or >7 days.

**Edge cases:**

- **Ownership.** Every order-loading tool throws `order_not_found` on ownership mismatch (no leak).
- **State guards.** Modify: {pending, confirmed}. Schedule: {pending, confirmed, preparing}. Reorder: none.
- **Stale menu.** Every modify/reorder/confirm path revalidates against the live menu via shared `MenuRevalidator`. Extracted from `OrderService.confirm`.
- **Idempotency.** Notifications: `UNIQUE (order_id, to_state)`. Modify: idempotent in audit-log sense (each call re-validates and writes an `order_modifications` row); intentional.
- **Concurrent modify.** `SELECT ... FOR UPDATE` inside the modify transaction.
- **Scheduled order past window.** `bad_schedule_window` returned with a Bangla prompt for a new time.
- **Reorder: nothing available.** Returns `nothing_available`, cart untouched, conversation goes to `idle`.
- **Reorder: no history.** Returns `no_history`, agent offers to start fresh.
- **Address: missing zone.** `address_missing_zone` — never silently fall back.
- **ETA staleness.** ETA is computed at query time, not delivery time. Recompute on every `get_order_status` call from `confirmed_at` / `requested_for` + zone minutes.

**Worker / webhook:**

- `whatsapp.send` failures on notifications: same DLQ as outbound replies. Notification row stays with `sent_at` set and `delivered_at = null`. No retry storm.
- Meta `message_status` callback updates `delivered_at` by joining on the outbound `messages.whatsapp_message_id`.

**Backwards compatibility:**

- `customers.default_address` (free text) is still written by `create_order` and continues to be the legacy source. `customer_addresses` is the structured source of truth going forward.
- No existing endpoints or webhook contracts change.

## 8. Testing strategy

**Tooling decisions:**

- ESLint + Prettier: keep (already configured).
- Unit tests: Vitest, keep. Add fixtures under `tests/fixtures/`.
- End-to-end: add a small Playwright test that drives the Next.js chat UI through a happy-path **status → modify → reorder** flow.
- Fuzz / mutation: not in scope for v1.

**Per-tool tests (happy + edge):**

- `get_delivery_zones`: lists active only; excludes inactive.
- `set_delivery_address`: happy path; missing zone id; invalid zone id; flips prior default.
- `get_order_history`: empty (`no_history`); respects `limit`; respects `before_iso`; only returns the customer's own orders.
- `reorder_from_history`: all available; partial unavailable; nothing available; no history; ownership leak check.
- `modify_order`: read phase; happy apply; ownership leak; wrong state (`preparing`); empty items; concurrent modify (two `pool.connect()` in vitest, second waits on first's lock).
- `schedule_order`: future 1 hour; future 7 days; past (`bad_schedule_window`); > 7 days (`bad_schedule_window`); state guard.

**Service tests:**

- `OrderNotificationService.recordAndEnqueue`: idempotency (call twice, one row, one enqueue).
- `OrderModificationService`: revalidation against a snapshot where one item is unavailable; audit row written; totals recomputed.
- `MenuRevalidator`: shared by `confirm`, `modifyItems`, `reorder_from_history`; one set of unit tests covers all three call sites.

**E2E (Playwright):**

- Open the chat UI, place an order, see the "Track latest" card show `confirmed`, modify the order, see totals update, click "Reorder" on a past order, see the cart populated.

## 9. File-level plan

**New files:**

- `db/migrations/002_customer_order_features.sql`
- `src/delivery/types.ts`
- `src/delivery/service.ts`
- `src/delivery/service.test.ts`
- `src/order/notifications.ts`
- `src/order/notifications.test.ts`
- `src/order/modifications.ts`
- `src/order/modifications.test.ts`
- `src/admin/notifications.ts`
- `web/src/components/RecentOrders.tsx`
- `web/src/components/TrackLatest.tsx`
- `web/src/components/LatestAddress.tsx`
- `web/src/components/ModifyModal.tsx`
- `tests/e2e/order-features.spec.ts` (Playwright)

**Modified files:**

- `src/db/seed.ts` — seed zones; backfill `customer_addresses`.
- `src/order/types.ts` — add `requested_for`, `delivery_zone_id`; add `OrderHistoryRow`, `OrderModification`, `OrderStatusNotification`.
- `src/order/service.ts` — extract `MenuRevalidator`; add `listHistoryByCustomer`, `modifyItems`, hook notification enqueue into `transition`; export `getByIdForUpdate` for modify's row lock.
- `src/conversation/state.ts` — add `'awaiting_modify_confirmation'`.
- `src/ai/tools.ts` — add new tool definitions and handlers; modify `get_order_status`, `summarize_cart_for_confirmation`, `create_order`.
- `src/ai/prompts.ts` — add Bangla usage hints for new tools.
- `src/webhook/router.ts` — handle `message_status` payloads; update `order_status_notifications.delivered_at`.
- `src/admin/dlq.ts` (or new admin module) — add `GET /admin/notifications/recent?order_id=…`.
- `web/src/app/page.tsx` — wire new components.
- `src/config.ts` — add `FEATURE_CUSTOMER_ORDER_PHASE2` (default off).

## 10. Rollout

1. **DB-only deploy.** Apply migration 002 in prod (idempotent). Add the seed zones. App code unchanged; nothing breaks.
2. **Code deploy with flag off.** Ship the new modules and new tools behind `FEATURE_CUSTOMER_ORDER_PHASE2=false`. Existing flow identical.
3. **Enable in dev.** Flip the flag in dev env. Run the full vitest suite + Playwright e2e. Manually walk the chat UI through each journey.
4. **Enable in prod.** Flip the flag. Monitor `GET /admin/notifications/recent` and `GET /admin/queues/dlq` for failures. Watch the new `order_modifications` and `order_status_notifications` rows.
5. **Remove the flag.** After one week of clean operation, delete the conditional in `src/config.ts` and `src/ai/tools.ts`; the code path becomes default.

## 11. Open questions / future work

- **Real geocoding.** Replace `delivery_zones` with a real address + Mapbox/Google lookup. Out of scope for v1.
- **Live tracking.** Webhook the rider's location, surface an "out for delivery" map in the chat. Out of scope.
- **Owner-side modify.** The staff/owner override path is gated by `actor: 'staff'` already, but the staff UI is not in scope. Add when the dashboard lands.
- **Push vs. agent-driven status.** If push notifications become flaky (Meta rate limits, customer opt-outs), fall back to "ask the agent" as the only channel. v1: push is the source of truth; agent's read is a fallback.
- **Multi-restaurant.** The schema is already restaurant-scoped. The flag is on the single-tenant assumption that there's one restaurant per `restaurant_id`. The flag itself is per-deployment, not per-row.

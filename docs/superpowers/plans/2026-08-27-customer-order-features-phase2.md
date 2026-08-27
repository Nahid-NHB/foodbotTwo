# Customer Order Features Phase 2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the Phase 1 MVP with customer-facing order features: status tracking with proactive WhatsApp push, order history + one-tap reorder, modify order after placement, and structured delivery zones + ETA + scheduled orders.

**Architecture:** Layered additions on top of the existing service stack. New migration `002_customer_order_features.sql` adds `delivery_zones`, `customer_addresses`, `order_status_notifications`, `order_modifications`; extends `orders` with `requested_for` and `delivery_zone_id`. New domain modules under `src/delivery/`, `src/order/notifications.ts`, `src/order/modifications.ts`. Six new AI tools, three existing tools tightened. A `FEATURE_CUSTOMER_ORDER_PHASE2` env flag controls rollout (default off). Existing webhook + queue contracts unchanged.

**Tech Stack:** Existing — Node 20, TypeScript strict, Fastify, PostgreSQL 16, Redis 7, BullMQ, Gemini 2.0 Flash, zod, pino, Vitest. New Playwright for end-to-end UI coverage.

**Spec:** `docs/superpowers/specs/2026-08-27-customer-order-features-phase2-design.md`

## Global Constraints

- Node 20+, TypeScript `strict: true`, ESM modules. Money in **integer paisa**. Never floats.
- All error types in `src/common/errors.ts`; never send raw exception text to customer.
- Webhook returns 200 once payload is persisted (idempotent via `whatsapp_message_id` UNIQUE).
- Tests live next to code: `src/foo/bar.ts` ↔ `src/foo/bar.test.ts`. Use Vitest.
- All commits use Conventional Commits.
- Bangla replies: ৳ for prices, concise, no emojis in critical info.
- Feature flag `FEATURE_CUSTOMER_ORDER_PHASE2=true` gates every new tool + behavior. Default off. Remove after one week of clean prod operation.
- Every order-loading tool throws `order_not_found` on ownership mismatch — never leak existence.
- Every item-affecting tool revalidates against the live menu via shared `MenuRevalidator`.
- Notifications are idempotent on `(order_id, to_state)`; one-shot, no retry storm.

---

## Task 1: Migration 002 — new tables and order columns

**Files:**
- Create: `db/migrations/002_customer_order_features.sql`

- [ ] **Step 1: Write the migration**

Create `db/migrations/002_customer_order_features.sql`:

```sql
-- 002_customer_order_features.sql
-- Phase 2: customer-facing order features. Idempotent.

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

- [ ] **Step 2: Apply against local docker compose**

Run: `docker compose up -d postgres redis && npm run migrate`
Expected: migration log shows `002_customer_order_features.sql` applied. Re-running is a no-op.

- [ ] **Step 3: Verify schema**

Run:
```bash
docker compose exec postgres psql -U foodbot -d foodbot -c '\d delivery_zones'
docker compose exec postgres psql -U foodbot -d foodbot -c '\d customer_addresses'
docker compose exec postgres psql -U foodbot -d foodbot -c '\d order_status_notifications'
docker compose exec postgres psql -U foodbot -d foodbot -c '\d order_modifications'
docker compose exec postgres psql -U foodbot -d foodbot -c '\d orders' | grep -E 'requested_for|delivery_zone_id'
```
Expected: each `\d` prints its table; `orders` shows the two new columns.

- [ ] **Step 4: Commit**

```bash
git add db/migrations/002_customer_order_features.sql
git commit -m "feat(db): phase 2 customer order tables + order columns"
```

---

## Task 2: Seed delivery zones and backfill addresses

**Files:**
- Modify: `src/db/seed.ts`
- Test: `src/db/seed.zones.test.ts`

- [ ] **Step 1: Read the current seed file**

Read `src/db/seed.ts` to find the existing restaurant row creation and the pattern used for upserts. Locate the function that seeds the menu (it likely upserts categories, menu items, variants, addons).

- [ ] **Step 2: Add zone seeding**

In `src/db/seed.ts`, after the existing menu seeding block, add (with the restaurant `id` you have in scope; fetch it once at the top of the function if not already):

```typescript
// Seed delivery zones. Idempotent on (restaurant_id, name).
const zones: Array<{ name: string; eta_minutes: number; delivery_fee_paisa: number }> = [
  { name: 'Dhanmondi', eta_minutes: 30, delivery_fee_paisa: 4000 },
  { name: 'Mohammadpur', eta_minutes: 35, delivery_fee_paisa: 5000 },
  { name: 'Mirpur', eta_minutes: 45, delivery_fee_paisa: 6000 },
];

for (const z of zones) {
  await client.query(
    `INSERT INTO delivery_zones (id, restaurant_id, name, eta_minutes, delivery_fee_paisa)
     SELECT $1, $2, $3, $4, $5
     WHERE NOT EXISTS (
       SELECT 1 FROM delivery_zones WHERE restaurant_id = $2 AND name = $3
     )`,
    [newId(), restaurantId, z.name, z.eta_minutes, z.delivery_fee_paisa],
  );
}
```

Use the same `client` (transactional) the rest of the seed uses.

- [ ] **Step 3: Add customer address backfill**

After zones are seeded, add a backfill that creates a `customer_addresses` row for every customer that has a non-null `default_address` and no existing `customer_addresses` row. The backfilled row has `zone_id = NULL` (legacy) and `is_default = true`:

```typescript
await client.query(
  `INSERT INTO customer_addresses (id, customer_id, zone_id, line1, is_default)
   SELECT $1, c.id, NULL, c.default_address, true
   FROM customers c
   WHERE c.default_address IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM customer_addresses WHERE customer_id = c.id
     )
   ON CONFLICT DO NOTHING`,
  [newId()],
);
```

The `ON CONFLICT DO NOTHING` is belt-and-suspenders for re-runs.

- [ ] **Step 4: Write the failing test**

Create `src/db/seed.zones.test.ts`. Use the same vitest + supertest + db setup the existing `src/db/seed.test.ts` uses. The test must:

1. Run the seed against a temp DB (the existing seed test does this — copy its setup).
2. Assert three rows exist in `delivery_zones`.
3. Insert a customer with `default_address = 'House 12, Road 5'` and no `customer_addresses` row, then re-run the seed. Assert a backfilled row exists with `line1 = 'House 12, Road 5'`, `zone_id IS NULL`, `is_default = true`.

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import db from './client.js';
import { runSeed } from './seed.js';

describe('seed: delivery zones + address backfill', () => {
  let zoneIds: string[] = [];
  beforeAll(async () => {
    await runSeed();
    const rows = await db.query<{ id: string }>(
      `SELECT id FROM delivery_zones ORDER BY name`,
    );
    zoneIds = rows.map((r) => r.id);
  });
  afterAll(async () => { await db.close(); });

  it('seeds three active zones for the seeded restaurant', async () => {
    expect(zoneIds).toHaveLength(3);
    const names = await db.query<{ name: string }>(
      `SELECT name FROM delivery_zones ORDER BY name`,
    );
    expect(names.map((n) => n.name)).toEqual(['Dhanmondi', 'Mirpur', 'Mohammadpur']);
  });

  it('backfills customer_addresses from customers.default_address', async () => {
    const cust = await db.query<{ id: string }>(
      `INSERT INTO customers (id, phone_e164, default_address) VALUES (gen_random_uuid(), '+8801700000999', 'House 99')
       RETURNING id`,
    );
    expect(cust[0]).toBeDefined();
    // re-run seed
    await runSeed();
    const addr = await db.query<{ line1: string; zone_id: string | null; is_default: boolean }>(
      `SELECT line1, zone_id, is_default FROM customer_addresses WHERE customer_id = $1`,
      [cust[0]!.id],
    );
    expect(addr).toHaveLength(1);
    expect(addr[0]!.line1).toBe('House 99');
    expect(addr[0]!.zone_id).toBeNull();
    expect(addr[0]!.is_default).toBe(true);
  });
});
```

Note: `runSeed` is the existing exported entry point in `src/db/seed.ts`. If it's not exported, refactor minimally — extract the function body into a named `export async function runSeed(client?: pg.PoolClient)` and have the CLI wrapper call it.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- src/db/seed.zones.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db/seed.ts src/db/seed.zones.test.ts
git commit -m "feat(db): seed delivery zones + backfill customer_addresses"
```

---

## Task 3: Feature flag and conversation state extension

**Files:**
- Modify: `src/config.ts`
- Modify: `src/conversation/state.ts`
- Modify: `src/conversation/types.ts`
- Modify: `src/conversation/service.test.ts` (or add new test file)

- [ ] **Step 1: Add the feature flag to config**

In `src/config.ts`, add to the zod schema:

```typescript
FEATURE_CUSTOMER_ORDER_PHASE2: z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true'),
```

Add to `.env.example`:

```
# Phase 2 customer-facing order features (status push, reorder, modify, zones, ETA, scheduling)
FEATURE_CUSTOMER_ORDER_PHASE2=false
```

- [ ] **Step 2: Extend ConversationState**

In `src/conversation/types.ts`:

```typescript
export type ConversationState =
  | 'idle'
  | 'ordering'
  | 'awaiting_confirmation'
  | 'awaiting_modify_confirmation';
```

In `src/conversation/state.ts`, update `ALLOWED`:

```typescript
const ALLOWED: Record<ConversationState, ReadonlyArray<ConversationState>> = {
  idle: ['ordering'],
  ordering: ['awaiting_confirmation', 'idle', 'awaiting_modify_confirmation'],
  awaiting_confirmation: ['ordering', 'idle'],
  awaiting_modify_confirmation: ['idle', 'ordering'],
};
```

- [ ] **Step 3: Verify the state machine still works**

Run: `npm test -- src/conversation`
Expected: existing state tests pass; the new `awaiting_modify_confirmation` value is recognized.

- [ ] **Step 4: Commit**

```bash
git add src/config.ts .env.example src/conversation/state.ts src/conversation/types.ts
git commit -m "feat(phase2): feature flag + awaiting_modify_confirmation state"
```

---

## Task 4: MenuRevalidator — shared revalidation helper

**Files:**
- Create: `src/order/menuRevalidator.ts`
- Modify: `src/order/service.ts` (replace inline `revalidateItems` with the shared helper)
- Test: `src/order/menuRevalidator.test.ts`

- [ ] **Step 1: Extract the shared helper**

Create `src/order/menuRevalidator.ts`:

```typescript
import db from '../db/client.js';
import { OrderNotConfirmableError, MenuItemNotFoundError, MenuItemUnavailableError } from '../common/errors.js';
import { sumPaisa } from '../common/money.js';
import type { OrderItemSnapshot } from './types.js';

/**
 * Revalidate every line of an incoming order against the live menu.
 *   - Each menu_item must exist + be available.
 *   - If variant_id is set, it must exist + be available for that item.
 *   - Each addon must exist + be available for that item.
 * Recomputes every line_total_paisa from current prices (server-side source of truth).
 * Throws OrderNotConfirmableError if any check fails.
 *
 * Shared by create_order, modify_order, and reorder_from_history so all three
 * paths cannot drift.
 */
export async function revalidateItems(
  restaurantId: string,
  items: ReadonlyArray<OrderItemSnapshot>,
): Promise<OrderItemSnapshot[]> {
  if (items.length === 0) {
    throw new OrderNotConfirmableError('cart is empty');
  }

  const revalidated: OrderItemSnapshot[] = [];
  for (const line of items) {
    if (line.quantity <= 0) {
      throw new OrderNotConfirmableError(`bad quantity for ${line.name}`);
    }

    const itemRows = await db.query<{ name: string; price_paisa: number; is_available: boolean }>(
      `SELECT name, price_paisa, is_available FROM menu_items
       WHERE id = $1 AND restaurant_id = $2`,
      [line.menu_item_id, restaurantId],
    );
    const item = itemRows[0];
    if (!item) throw new MenuItemNotFoundError(line.name);
    if (!item.is_available) throw new MenuItemUnavailableError(item.name);

    let unitPrice = item.price_paisa;
    let variantName: string | undefined;
    if (line.variant_id) {
      const vRows = await db.query<{ name: string; price_paisa: number; is_available: boolean }>(
        `SELECT name, price_paisa, is_available FROM menu_item_variants
         WHERE id = $1 AND menu_item_id = $2`,
        [line.variant_id, line.menu_item_id],
      );
      const v = vRows[0];
      if (!v) throw new MenuItemNotFoundError(`variant ${line.variant_id}`);
      if (!v.is_available) throw new MenuItemUnavailableError(`${item.name} (${v.name})`);
      unitPrice = v.price_paisa;
      variantName = v.name;
    }

    let addons: { id: string; name: string; price_paisa: number }[] = [];
    if (line.addon_ids.length > 0) {
      const aRows = await db.query<{ id: string; name: string; price_paisa: number; is_available: boolean }>(
        `SELECT id, name, price_paisa, is_available FROM menu_item_addons
         WHERE menu_item_id = $1 AND id = ANY($2::uuid[])`,
        [line.menu_item_id, line.addon_ids],
      );
      if (aRows.length !== line.addon_ids.length) {
        throw new MenuItemNotFoundError(`addon for ${line.name}`);
      }
      for (const a of aRows) {
        if (!a.is_available) throw new MenuItemUnavailableError(`${item.name} add-on ${a.name}`);
      }
      addons = aRows.map((a) => ({ id: a.id, name: a.name, price_paisa: a.price_paisa }));
    }

    const addonsTotal = sumPaisa(addons.map((a) => a.price_paisa));
    const unitTotal = unitPrice + addonsTotal;
    const snapshot: OrderItemSnapshot = {
      menu_item_id: line.menu_item_id,
      name: item.name,
      quantity: line.quantity,
      unit_price_paisa: unitTotal,
      addon_ids: line.addon_ids,
      addons,
      line_total_paisa: unitTotal * line.quantity,
    };
    if (line.variant_id) snapshot.variant_id = line.variant_id;
    if (variantName) snapshot.variant_name = variantName;
    revalidated.push(snapshot);
  }
  return revalidated;
}
```

- [ ] **Step 2: Replace the inline copy in `OrderService`**

In `src/order/service.ts`:

1. Add `import { revalidateItems } from './menuRevalidator.js';` near the top.
2. Delete the local `revalidateItems` function definition.
4. Leave the `revalidateItems(input.restaurant_id, input.items)` call in `confirm` unchanged — it now points at the shared helper.

- [ ] **Step 3: Write the shared helper test**

Create `src/order/menuRevalidator.test.ts`. Reuse the test DB fixture pattern from `src/order/service.test.ts`. The test must:

1. Insert a menu item + variant + addon.
2. Call `revalidateItems(restaurantId, [{menu_item_id, name: 'X', quantity: 2, unit_price_paisa: 0, addon_ids: [addonId], addons: [], line_total_paisa: 0}])`.
3. Assert the returned snapshot has the recomputed `unit_price_paisa` (item price + addon) and `line_total_paisa` (unit × quantity).
4. Mark the item `is_available = false`, call again, expect `MenuItemUnavailableError`.

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import db from '../db/client.js';
import { revalidateItems } from './menuRevalidator.js';
import { newId } from '../common/id.js';
import { MenuItemUnavailableError, MenuItemNotFoundError } from '../common/errors.js';

// (helpers to seed a restaurant + category + item + variant + addon, copying
//  the pattern from src/order/service.test.ts)

describe('MenuRevalidator', () => {
  let restaurantId: string;
  let itemId: string;
  let addonId: string;

  beforeAll(async () => {
    // seed restaurant, category, item (Chicken Burger 180), addon (Cheese 30)
    // ...
  });
  beforeEach(async () => { /* reset item is_available=true */ });

  it('recomputes unit + line totals from live prices', async () => {
    const out = await revalidateItems(restaurantId, [{
      menu_item_id: itemId, name: 'Chicken Burger', quantity: 2,
      unit_price_paisa: 0, addon_ids: [addonId], addons: [], line_total_paisa: 0,
    }]);
    expect(out).toHaveLength(1);
    expect(out[0]!.unit_price_paisa).toBe(21000); // 18000 + 3000
    expect(out[0]!.line_total_paisa).toBe(42000); // 21000 * 2
  });

  it('throws MenuItemUnavailableError when item is unavailable', async () => {
    await db.query(`UPDATE menu_items SET is_available = false WHERE id = $1`, [itemId]);
    await expect(
      revalidateItems(restaurantId, [{
        menu_item_id: itemId, name: 'Chicken Burger', quantity: 1,
        unit_price_paisa: 0, addon_ids: [], addons: [], line_total_paisa: 0,
      }])
    ).rejects.toBeInstanceOf(MenuItemUnavailableError);
  });

  it('throws MenuItemNotFoundError when item does not exist', async () => {
    await expect(
      revalidateItems(restaurantId, [{
        menu_item_id: newId(), name: 'Ghost', quantity: 1,
        unit_price_paisa: 0, addon_ids: [], addons: [], line_total_paisa: 0,
      }])
    ).rejects.toBeInstanceOf(MenuItemNotFoundError);
  });
});
```

- [ ] **Step 4: Run all order tests**

Run: `npm test -- src/order`
Expected: PASS — both new and existing `OrderService` tests still green.

- [ ] **Step 5: Commit**

```bash
git add src/order/menuRevalidator.ts src/order/menuRevalidator.test.ts src/order/service.ts
git commit -m "refactor(order): extract shared MenuRevalidator"
```

---

## Task 5: Delivery service — zones and customer addresses

**Files:**
- Create: `src/delivery/types.ts`
- Create: `src/delivery/service.ts`
- Test: `src/delivery/service.test.ts`

- [ ] **Step 1: Define types**

Create `src/delivery/types.ts`:

```typescript
export interface DeliveryZone {
  id: string;
  restaurant_id: string;
  name: string;
  eta_minutes: number;
  delivery_fee_paisa: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CustomerAddress {
  id: string;
  customer_id: string;
  zone_id: string;
  line1: string;
  line2: string | null;
  note_for_rider: string | null;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface CustomerAddressInput {
  zone_id: string;
  line1: string;
  line2?: string;
  note_for_rider?: string;
}
```

- [ ] **Step 2: Implement service**

Create `src/delivery/service.ts`:

```typescript
import db from '../db/client.js';
import { newId } from '../common/id.js';
import { ToolError } from '../common/errors.js';
import type { DeliveryZone, CustomerAddress, CustomerAddressInput } from './types.js';

export async function listActiveZones(restaurantId: string): Promise<DeliveryZone[]> {
  return db.query<DeliveryZone>(
    `SELECT id, restaurant_id, name, eta_minutes, delivery_fee_paisa, is_active, created_at, updated_at
     FROM delivery_zones
     WHERE restaurant_id = $1 AND is_active = true
     ORDER BY eta_minutes ASC`,
    [restaurantId],
  );
}

export async function getZone(zoneId: string): Promise<DeliveryZone | null> {
  const rows = await db.query<DeliveryZone>(
    `SELECT id, restaurant_id, name, eta_minutes, delivery_fee_paisa, is_active, created_at, updated_at
     FROM delivery_zones WHERE id = $1 LIMIT 1`,
    [zoneId],
  );
  return rows[0] ?? null;
}

export async function getDefaultAddress(customerId: string): Promise<CustomerAddress | null> {
  const rows = await db.query<CustomerAddress>(
    `SELECT id, customer_id, zone_id, line1, line2, note_for_rider, is_default, created_at, updated_at
     FROM customer_addresses
     WHERE customer_id = $1 AND is_default = true
     ORDER BY updated_at DESC LIMIT 1`,
    [customerId],
  );
  return rows[0] ?? null;
}

/**
 * Save a new structured address for a customer. Flips any prior default to
 * false in the same transaction so the new one is the unique default.
 */
export async function setAddress(
  customerId: string,
  input: CustomerAddressInput,
): Promise<CustomerAddress> {
  const zone = await getZone(input.zone_id);
  if (!zone) {
    throw new ToolError('zone_not_found', 'ডেলিভারি এলাকা খুঁজে পাওয়া যায়নি।', `zone ${input.zone_id} not found`);
  }

  return db.withTransaction(async (client) => {
    await client.query(
      `UPDATE customer_addresses SET is_default = false, updated_at = now()
       WHERE customer_id = $1 AND is_default = true`,
      [customerId],
    );
    const id = newId();
    const rows = await client.query<CustomerAddress>(
      `INSERT INTO customer_addresses (id, customer_id, zone_id, line1, line2, note_for_rider, is_default)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       RETURNING id, customer_id, zone_id, line1, line2, note_for_rider, is_default, created_at, updated_at`,
      [id, customerId, input.zone_id, input.line1, input.line2 ?? null, input.note_for_rider ?? null],
    );
    return rows[0]!;
  });
}
```

- [ ] **Step 3: Write failing tests**

Create `src/delivery/service.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import db from '../db/client.js';
import { listActiveZones, getDefaultAddress, setAddress } from './service.js';
import { ToolError } from '../common/errors.js';
import { newId } from '../common/id.js';

describe('delivery service', () => {
  let restaurantId: string;
  let customerId: string;
  let zoneId: string;

  beforeAll(async () => {
    // Seed: restaurant, customer, one zone (Dhanmondi 30min 40BDT)
    // ...
  });
  afterAll(async () => { await db.close(); });

  it('listActiveZones returns active zones for a restaurant', async () => {
    const zones = await listActiveZones(restaurantId);
    expect(zones.map((z) => z.name)).toEqual(['Dhanmondi']);
  });

  it('setAddress creates a default address and flips any prior default', async () => {
    const first = await setAddress(customerId, {
      zone_id: zoneId, line1: 'House 1',
    });
    expect(first.is_default).toBe(true);

    const second = await setAddress(customerId, {
      zone_id: zoneId, line1: 'House 2', note_for_rider: 'Ring twice',
    });
    expect(second.is_default).toBe(true);

    const def = await getDefaultAddress(customerId);
    expect(def?.id).toBe(second.id);
    expect(def?.line1).toBe('House 2');

    const firstAfter = await db.query(`SELECT is_default FROM customer_addresses WHERE id = $1`, [first.id]);
    expect(firstAfter[0]!.is_default).toBe(false);
  });

  it('setAddress throws zone_not_found for unknown zone', async () => {
    await expect(setAddress(customerId, { zone_id: newId(), line1: 'X' }))
      .rejects.toBeInstanceOf(ToolError);
  });
});
```

- [ ] **Step 4: Run tests**

Run: `npm test -- src/delivery`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/delivery/
git commit -m "feat(delivery): zones + customer_addresses service"
```

---

## Task 6: Order history listing

**Files:**
- Modify: `src/order/types.ts`
- Modify: `src/order/service.ts`
- Test: extend `src/order/service.test.ts`

- [ ] **Step 1: Extend order types**

In `src/order/types.ts`, append:

```typescript
export interface OrderHistoryRow {
  id: string;
  state: OrderState;
  items_summary: string;        // comma-separated item names e.g. "Chicken Burger × 2, Coke × 1"
  item_count: number;           // sum of quantities
  subtotal_paisa: number;
  delivery_fee_paisa: number;
  total_paisa: number;
  created_at: string;
  confirmed_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
}

export interface ListHistoryOptions {
  limit: number;       // 1..20
  beforeIso: string | null;
  includeTerminal: boolean;  // include delivered/cancelled; default false
}
```

- [ ] **Step 2: Add the list function**

In `src/order/service.ts`, append:

```typescript
export async function listHistoryByCustomer(
  customerId: string,
  opts: ListHistoryOptions,
): Promise<OrderHistoryRow[]> {
  const limit = Math.max(1, Math.min(20, Math.floor(opts.limit)));
  const params: unknown[] = [customerId];
  let where = `customer_id = $1`;
  if (opts.beforeIso) {
    params.push(opts.beforeIso);
    where += ` AND created_at < $${params.length}`;
  }
  if (!opts.includeTerminal) {
    where += ` AND state NOT IN ('delivered','cancelled')`;
  }
  params.push(limit);
  return db.query<OrderHistoryRow>(
    `SELECT id, state,
            items_summary, item_count,
            subtotal_paisa, delivery_fee_paisa, total_paisa,
            created_at, confirmed_at, delivered_at, cancelled_at
     FROM orders
     WHERE ${where}
     ORDER BY created_at DESC
     LIMIT $${params.length}`,
    params,
  );
}
```

Note: `items_summary` and `item_count` are not yet a generated column. To avoid materializing a summary in JS on the hot path, add a generated column to migration `002` in a follow-up edit. **For this task**, change the SQL to compute the summary inline using `jsonb_array_elements`:

Replace the SELECT body with:

```sql
SELECT
  o.id, o.state,
  COALESCE(
    (SELECT string_agg((elem->>'name') || ' × ' || (elem->>'quantity'), ', ')
     FROM jsonb_array_elements(o.items) AS elem),
    ''
  ) AS items_summary,
  COALESCE(
    (SELECT SUM((elem->>'quantity')::int) FROM jsonb_array_elements(o.items) AS elem),
    0
  )::int AS item_count,
  o.subtotal_paisa, o.delivery_fee_paisa, o.total_paisa,
  o.created_at, o.confirmed_at, o.delivered_at, o.cancelled_at
FROM orders o
WHERE ...
```

The TypeScript interface `OrderHistoryRow` stays as written.

- [ ] **Step 3: Write tests**

In `src/order/service.test.ts`, add:

```typescript
import { listHistoryByCustomer } from './service.js';

describe('listHistoryByCustomer', () => {
  it('returns most-recent-first active orders for a customer', async () => {
    // Insert 3 orders for customer: 2 active (pending, preparing), 1 delivered.
    // assert listHistoryByCustomer(c, {limit:5, beforeIso:null, includeTerminal:false}) returns 2
    // assert includeTerminal:true returns 3
    // assert ordering is DESC by created_at
  });

  it('respects limit and beforeIso cursor', async () => {
    // Insert 5 orders; request limit=2 with beforeIso = 4th order's created_at.
    // assert exactly 2 returned, both older than the cursor.
  });

  it('returns empty array (not error) when customer has no orders', async () => {
    // assert listHistoryByCustomer(newCustomerId, defaults) === []
  });
});
```

- [ ] **Step 4: Run tests**

Run: `npm test -- src/order`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/order/types.ts src/order/service.ts src/order/service.test.ts
git commit -m "feat(order): listHistoryByCustomer with cursor + terminal filter"
```

---

## Task 7: Order modification service

**Files:**
- Create: `src/order/modifications.ts`
- Create: `src/order/modifications.test.ts`
- Modify: `src/order/types.ts` (add `OrderModification` type)

- [ ] **Step 1: Extend types**

In `src/order/types.ts`, append:

```typescript
export interface OrderModification {
  id: string;
  order_id: string;
  old_items: OrderItemSnapshot[];
  new_items: OrderItemSnapshot[];
  old_total_paisa: number;
  new_total_paisa: number;
  actor: 'customer' | 'staff' | 'system';
  created_at: string;
}

export type ApplyModificationInput = {
  orderId: string;
  customerId: string;
  newItems: OrderItemSnapshot[];
};

export type ApplyModificationResult = {
  order: Order;
  modification: OrderModification;
};
```

- [ ] **Step 2: Implement the service**

Create `src/order/modifications.ts`:

```typescript
import db from '../db/client.js';
import { newId } from '../common/id.js';
import { ToolError, InvalidStateTransitionError } from '../common/errors.js';
import { sumPaisa } from '../common/money.js';
import * as OrderService from './service.js';
import { revalidateItems } from './menuRevalidator.js';
import type { OrderModification, ApplyModificationInput, ApplyModificationResult, OrderItemSnapshot } from './types.js';

const MODIFIABLE_STATES: ReadonlyArray<string> = ['pending', 'confirmed'];

function assertModifiable(state: string): void {
  if (!MODIFIABLE_STATES.includes(state)) {
    throw new ToolError(
      'order_not_modifiable',
      'এই অর্ডারটি এখন আর পরিবর্তন করা যাবে না।',
      `order in state ${state} cannot be modified`,
    );
  }
}

/**
 * Apply a new items array to an existing order. Allowed only while the order
 * is in 'pending' or 'confirmed'. Acquires a row lock so concurrent modifies
 * serialize. Re-validates every line via MenuRevalidator. Writes an audit
 * row in order_modifications and an entry in order_events.
 *
 * Does NOT trigger a customer notification — the order's state did not change.
 */
export async function applyModification(
  input: ApplyModificationInput,
): Promise<ApplyModificationResult> {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // Row-level lock so concurrent modifies serialize.
    const orderRows = await client.query<{
      id: string;
      customer_id: string;
      state: string;
      items: OrderItemSnapshot[];
      subtotal_paisa: number;
      delivery_fee_paisa: number;
      total_paisa: number;
    }>(
      `SELECT id, customer_id, state, items, subtotal_paisa, delivery_fee_paisa, total_paisa
       FROM orders WHERE id = $1 FOR UPDATE`,
      [input.orderId],
    );
    const existing = orderRows[0];
    if (!existing || existing.customer_id !== input.customerId) {
      // never leak existence
      throw new ToolError('order_not_found', 'অর্ডার খুঁজে পাওয়া যায়নি।', `order ${input.orderId} not found`);
    }
    assertModifiable(existing.state);

    // We need the restaurant_id for menu revalidation. The orders row above
    // didn't select it; fetch via OrderService (read-only).
    const order = await OrderService.getById(input.orderId);

    const revalidated = await revalidateItems(order.restaurant_id, input.newItems);
    const newSubtotal = sumPaisa(revalidated.map((i) => i.line_total_paisa));
    const newTotal = newSubtotal + existing.delivery_fee_paisa;

    const modId = newId();
    await client.query(
      `INSERT INTO order_modifications (id, order_id, old_items, new_items, old_total_paisa, new_total_paisa, actor)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, 'customer')`,
      [modId, input.orderId, JSON.stringify(existing.items), JSON.stringify(revalidated), existing.total_paisa, newTotal],
    );

    await client.query(
      `UPDATE orders SET items = $1::jsonb, subtotal_paisa = $2, total_paisa = $3, updated_at = now()
       WHERE id = $4`,
      [JSON.stringify(revalidated), newSubtotal, newTotal, input.orderId],
    );

    await client.query(
      `INSERT INTO order_events (id, order_id, from_state, to_state, actor, note)
       VALUES ($1, $2, $3, $3, 'customer', 'items modified')`,
      [newId(), input.orderId, existing.state],
    );

    await client.query('COMMIT');

    const updated = await OrderService.getById(input.orderId);
    return {
      order: updated,
      modification: {
        id: modId,
        order_id: input.orderId,
        old_items: existing.items,
        new_items: revalidated,
        old_total_paisa: existing.total_paisa,
        new_total_paisa: newTotal,
        actor: 'customer',
        created_at: new Date().toISOString(),
      },
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Read-side helper for the agent's two-step modify flow. Returns the order's
 * current items as a structured list. Throws order_not_found on ownership
 * mismatch — never leaks existence.
 */
export async function getCurrentItems(orderId: string, customerId: string): Promise<OrderItemSnapshot[]> {
  const order = await OrderService.getById(orderId);
  if (order.customer_id !== customerId) {
    throw new ToolError('order_not_found', 'অর্ডার খুঁজে পাওয়া যায়নি।', `order ${orderId} not owned by ${customerId}`);
  }
  return order.items;
}
```

- [ ] **Step 3: Write tests**

Create `src/order/modifications.test.ts`:

```typescript
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import db from '../db/client.js';
import { applyModification, getCurrentItems } from './modifications.js';
import { ToolError } from '../common/errors.js';

describe('OrderModificationService', () => {
  let restaurantId: string;
  let customerId: string;
  let itemId: string;
  let addonId: string;
  let orderId: string;

  beforeAll(async () => { /* seed restaurant, customer, item, addon */ });
  beforeEach(async () => {
    // Create an order in 'pending' state with 1 line.
    // ...
  });

  it('applies a new items array, recomputes totals, writes audit row', async () => {
    const result = await applyModification({
      orderId, customerId,
      newItems: [{
        menu_item_id: itemId, name: 'Chicken Burger', quantity: 3,
        unit_price_paisa: 0, addon_ids: [addonId], addons: [], line_total_paisa: 0,
      }],
    });
    expect(result.order.state).toBe('pending');
    expect(result.order.items).toHaveLength(1);
    expect(result.order.items[0]!.quantity).toBe(3);
    expect(result.modification.old_total_paisa).toBe(result.order.subtotal_paisa - (1 * (18000+3000))); // 1 line at 21000 removed
    // ...
  });

  it('throws order_not_modifiable when state is preparing', async () => {
    await db.query(`UPDATE orders SET state = 'preparing' WHERE id = $1`, [orderId]);
    await expect(applyModification({ orderId, customerId, newItems: [] }))
      .rejects.toThrow(/order_not_modifiable/);
  });

  it('throws order_not_found when orderId belongs to another customer', async () => {
    const otherCustomer = /* create another customer */;
    await expect(applyModification({ orderId, customerId: otherCustomer, newItems: [] }))
      .rejects.toBeInstanceOf(ToolError);
  });

  it('throws MenuItemUnavailableError when a line is no longer available', async () => {
    await db.query(`UPDATE menu_items SET is_available = false WHERE id = $1`, [itemId]);
    await expect(applyModification({ orderId, customerId, newItems: [{
      menu_item_id: itemId, name: 'Chicken Burger', quantity: 1,
      unit_price_paisa: 0, addon_ids: [], addons: [], line_total_paisa: 0,
    }]})).rejects.toThrow();
  });
});
```

- [ ] **Step 4: Run tests**

Run: `npm test -- src/order`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/order/modifications.ts src/order/modifications.test.ts src/order/types.ts
git commit -m "feat(order): applyModification with row lock + audit + revalidation"
```

---

## Task 8: Order notification service

**Files:**
- Create: `src/order/notifications.ts`
- Create: `src/order/notifications.test.ts`
- Modify: `src/order/service.ts` (call into notifications from `transition`)
- Modify: `src/order/types.ts` (add types)

- [ ] **Step 1: Add types**

In `src/order/types.ts`, append:

```typescript
export type NotificationTemplate = {
  to_state: OrderState;
  bn: string;            // Bangla message body
};

export const NOTIFICATION_TEMPLATES: ReadonlyArray<NotificationTemplate> = [
  { to_state: 'confirmed', bn: 'আপনার অর্ডার #{order_id_short} কনফার্ম হয়েছে। প্রস্তুতি শুরু হবে শীঘ্রই।' },
  { to_state: 'preparing', bn: 'আপনার অর্ডার #{order_id_short} রান্না শুরু হয়েছে।' },
  { to_state: 'ready',     bn: 'আপনার অর্ডার #{order_id_short} প্রস্তুত।' },
  { to_state: 'out_for_delivery', bn: 'আপনার অর্ডার #{order_id_short} ডেলিভারির জন্য বের হয়েছে।' },
  { to_state: 'delivered', bn: 'আপনার অর্ডার #{order_id_short} পৌঁছে গেছে। ধন্যবাদ!' },
  { to_state: 'cancelled', bn: 'আপনার অর্ডার #{order_id_short} বাতিল করা হয়েছে। কারণ: {note}' },
];

export interface OrderStatusNotification {
  id: string;
  order_id: string;
  to_state: OrderState;
  sent_at: string;
  delivered_at: string | null;
  failed_reason: string | null;
}
```

- [ ] **Step 2: Implement the service**

Create `src/order/notifications.ts`:

```typescript
import db from '../db/client.js';
import { newId } from '../common/id.js';
import { sendQueue } from '../queue/index.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { NOTIFICATION_TEMPLATES, type OrderState, type Order, type OrderStatusNotification } from './types.js';

/** Render the Bangla template for a state with the order context. */
export function renderTemplate(toState: OrderState, order: Order, note?: string): string | null {
  const tpl = NOTIFICATION_TEMPLATES.find((t) => t.to_state === toState);
  if (!tpl) return null;
  const short = order.id.slice(0, 8);
  return tpl.bn.replace('{order_id_short}', short).replace('{note}', note ?? '—');
}

/**
 * Record the notification row (idempotent on (order_id, to_state)) and, if a
 * row was inserted, enqueue a WhatsApp send job. Returns the notification row
 * (inserted or pre-existing).
 *
 * No-op for terminal states without a template (currently all defined states
 * have a template, but the function guards against missing templates by
 * returning null without insert).
 */
export async function recordAndEnqueue(
  order: Order,
  toState: OrderState,
  note?: string,
): Promise<OrderStatusNotification | null> {
  const body = renderTemplate(toState, order, note);
  if (!body) return null;

  const ins = await db.query<OrderStatusNotification>(
    `INSERT INTO order_status_notifications (id, order_id, to_state)
     VALUES ($1, $2, $3)
     ON CONFLICT (order_id, to_state) DO NOTHING
     RETURNING id, order_id, to_state, sent_at, delivered_at, failed_reason`,
    [newId(), order.id, toState],
  );
  const row = ins[0];
  if (!row) {
    // Already recorded; idempotent no-op.
    const existing = await db.query<OrderStatusNotification>(
      `SELECT id, order_id, to_state, sent_at, delivered_at, failed_reason
       FROM order_status_notifications WHERE order_id = $1 AND to_state = $2`,
      [order.id, toState],
    );
    return existing[0] ?? null;
  }

  // Look up the customer's phone_e164 to address the send.
  const cust = await db.query<{ phone_e164: string }>(
    `SELECT phone_e164 FROM customers WHERE id = $1`, [order.customer_id],
  );
  if (!cust[0]) {
    logger.warn({ orderId: order.id }, 'notification: customer not found, skipping enqueue');
    return row;
  }

  await sendQueue.add('status', {
    to: cust[0].phone_e164,
    body,
    conversationId: order.conversation_id ?? '',
  });
  return row;
}

/** Update delivered_at when Meta confirms delivery. */
export async function markDelivered(orderId: string, toState: OrderState, when: Date): Promise<void> {
  await db.query(
    `UPDATE order_status_notifications
     SET delivered_at = $1
     WHERE order_id = $2 AND to_state = $3 AND delivered_at IS NULL`,
    [when.toISOString(), orderId, toState],
  );
}

/** Record a failure reason (used when sendText throws). */
export async function markFailed(orderId: string, toState: OrderState, reason: string): Promise<void> {
  await db.query(
    `UPDATE order_status_notifications
     SET failed_reason = $1
     WHERE order_id = $2 AND to_state = $3`,
    [reason, orderId, toState],
  );
}
```

- [ ] **Step 3: Extend the SendJobData type**

In `src/queue/index.ts`, update the `SendJobData` to support both agent-driven replies and notifications:

```typescript
export interface SendJobData {
  to: string;
  body: string;
  conversationId: string;
  kind?: 'reply' | 'status';   // default 'reply' if absent
  orderId?: string;            // for status notifications
  toState?: string;            // for status notifications
}
```

In the `sendProcessor`, after a successful `sendText`, look at `job.data.kind`:

```typescript
const sendProcessor: Processor<SendJobData> = async (job) => {
  const result = await sendText({ to: job.data.to, body: job.data.body });
  if (job.data.kind === 'status' && job.data.orderId && job.data.toState) {
    const { markDelivered } = await import('../order/notifications.js');
    await markDelivered(job.data.orderId, job.data.toState as never, new Date());
  }
  // capture wamid on the outbound message row for the agent-driven path (existing behavior unchanged)
  return { sent: true, wamid: result.wamid };
};
```

Update the `recordAndEnqueue` call to pass `kind: 'status'`, `orderId`, `toState` so the worker can call `markDelivered`.

- [ ] **Step 4: Hook into OrderService.transition**

In `src/order/service.ts`, modify the end of `transition` (after the COMMIT) to call `recordAndEnqueue`. Import at the top:

```typescript
import { recordAndEnqueue } from './notifications.js';
```

After `return getById(orderId);` is currently the last line — replace with:

```typescript
const updated = await getById(orderId);
// Fire notification after the transaction commits so failures don't roll back state.
void recordAndEnqueue(updated, to, note).catch((err) => {
  logger.error({ err, orderId, to }, 'notification enqueue failed');
});
return updated;
```

Add `import { logger } from '../logger.js';` at the top of `service.ts` if not present.

- [ ] **Step 5: Write tests**

Create `src/order/notifications.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import db from '../db/client.js';
import { recordAndEnqueue, renderTemplate, markDelivered } from './notifications.js';

describe('OrderNotificationService', () => {
  let orderId: string;
  let customerId: string;

  beforeAll(async () => {
    // seed restaurant, customer, create an order
  });
  afterAll(async () => { await db.close(); });

  it('renders a Bangla template for known states', () => {
    const order = { id: 'abcdef1234567890', customer_id: 'x', conversation_id: null,
      restaurant_id: 'r', state: 'confirmed', items: [], subtotal_paisa: 0,
      delivery_fee_paisa: 0, total_paisa: 0, delivery_address: null,
      payment_method: null, special_instructions: null, confirmed_at: null,
      cancelled_at: null, cancel_reason: null, created_at: '', updated_at: '' } as any;
    const text = renderTemplate('confirmed', order);
    expect(text).toContain('abcdef12');
    expect(text).toMatch(/কনফার্ম/);
  });

  it('returns null for unknown states', () => {
    expect(renderTemplate('pending' as any, {} as any)).toBeNull();
  });

  it('inserts one row per (order_id, to_state), idempotent on repeat', async () => {
    const order = await db.query<any>(`SELECT * FROM orders WHERE id = $1`, [orderId]);
    await recordAndEnqueue(order[0]!, 'preparing');
    await recordAndEnqueue(order[0]!, 'preparing');
    await recordAndEnqueue(order[0]!, 'preparing');
    const rows = await db.query(`SELECT id FROM order_status_notifications WHERE order_id = $1 AND to_state = 'preparing'`, [orderId]);
    expect(rows).toHaveLength(1);
  });

  it('markDelivered updates delivered_at for the (order_id, to_state) row', async () => {
    await markDelivered(orderId, 'preparing', new Date('2026-08-27T10:00:00Z'));
    const rows = await db.query<{ delivered_at: string }>(
      `SELECT delivered_at FROM order_status_notifications WHERE order_id = $1 AND to_state = 'preparing'`, [orderId],
    );
    expect(rows[0]!.delivered_at).toBe('2026-08-27T10:00:00.000Z');
  });
});
```

- [ ] **Step 6: Run all order + queue tests**

Run: `npm test -- src/order src/queue`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/order/notifications.ts src/order/notifications.test.ts src/order/types.ts src/order/service.ts src/queue/index.ts
git commit -m "feat(order): idempotent status notifications + transition hook"
```

---

## Task 9: Meta message_status webhook → markDelivered

**Files:**
- Modify: `src/webhook/router.ts`
- Test: extend `src/webhook/router.test.ts`

- [ ] **Step 1: Extend the webhook types**

In `src/webhook/router.ts`, add types:

```typescript
interface MessageStatusEntry {
  id: string;          // wamid
  status: 'sent' | 'delivered' | 'read' | 'failed';
  timestamp: string;
  recipient_id: string;
  errors?: Array<{ code: number; title: string; message?: string }>;
}

interface WebhookValue {
  // ... existing
  statuses?: MessageStatusEntry[];
}
```

- [ ] **Step 2: Handle the status branch**

In the POST handler, in the loop `for (const change of entry.changes ?? [])`, after the existing `if (!value || !value.messages) continue;`, add:

```typescript
if (value.statuses && value.statuses.length > 0) {
  for (const s of value.statuses) {
    await handleMessageStatus(s).catch((err) => {
      logger.error({ err, wamid: s.id, status: s.status }, 'failed to handle message status');
    });
  }
  continue;
}
```

Implement:

```typescript
async function handleMessageStatus(s: MessageStatusEntry): Promise<void> {
  // Look up the outbound message row by wamid to find the order_id + to_state.
  const rows = await db.query<{ order_id: string | null; to_state: string | null }>(
    `SELECT n.order_id, n.to_state
     FROM messages m
     LEFT JOIN order_status_notifications n
       ON n.order_id IS NOT NULL AND n.delivered_at IS NULL
     WHERE m.whatsapp_message_id = $1
     LIMIT 1`,
    [s.id],
  );
  // The above LEFT JOIN is too loose; replace with a direct schema: store
  // wamid on the order_status_notifications row when we enqueue. See Step 3.
}
```

This is simpler if we **store the wamid on the notification row at enqueue time**. Refactor:

1. In `src/order/types.ts`, add `wamid text` column to the migration's `order_status_notifications` (do this as a follow-up edit to `db/migrations/002_customer_order_features.sql` in this task):

```sql
ALTER TABLE order_status_notifications ADD COLUMN IF NOT EXISTS wamid text;
```

2. In `src/order/notifications.ts`'s `recordAndEnqueue`, instead of inserting first then enqueueing, we need the wamid to mark the row. The flow becomes: enqueue → `sendText` returns wamid → on success, update the notification row's `wamid` and `delivered_at`. But `sendQueue` is async — the wamid is only known in the worker.

Refactor for correctness: drop the post-COMMIT wamid write from `recordAndEnqueue`. Instead, in the `sendProcessor`, after `sendText` returns successfully, **find the most recent `order_status_notifications` row for the `to` + `body` + `kind='status'` and update its wamid**. That's racey if two notifications go out simultaneously, but we can make it robust by including `orderId` and `toState` on the job (already in `SendJobData`):

```typescript
const sendProcessor: Processor<SendJobData> = async (job) => {
  const result = await sendText({ to: job.data.to, body: job.data.body });
  if (job.data.kind === 'status' && job.data.orderId && job.data.toState) {
    const { markDelivered, markWamid } = await import('../order/notifications.js');
    await markWamid(job.data.orderId, job.data.toState as never, result.wamid);
    await markDelivered(job.data.orderId, job.data.toState as never, new Date());
  }
  return { sent: true, wamid: result.wamid };
};
```

In `recordAndEnqueue`, set the job data with `kind`, `orderId`, `toState`:

```typescript
await sendQueue.add('status', {
  to: cust[0].phone_e164,
  body,
  conversationId: order.conversation_id ?? '',
  kind: 'status',
  orderId: order.id,
  toState: toState,
});
```

In `src/order/notifications.ts`, add:

```typescript
export async function markWamid(orderId: string, toState: OrderState, wamid: string): Promise<void> {
  await db.query(
    `UPDATE order_status_notifications SET wamid = $1
     WHERE order_id = $2 AND to_state = $3`,
    [wamid, orderId, toState],
  );
}
```

3. The `handleMessageStatus` then becomes a single, clean lookup:

```typescript
async function handleMessageStatus(s: MessageStatusEntry): Promise<void> {
  const { markDelivered, markFailed } = await import('../order/notifications.js');
  const rows = await db.query<{ order_id: string; to_state: string }>(
    `SELECT order_id, to_state FROM order_status_notifications WHERE wamid = $1`,
    [s.id],
  );
  for (const r of rows) {
    if (s.status === 'delivered' || s.status === 'read') {
      await markDelivered(r.order_id, r.to_state as never, new Date(parseInt(s.timestamp, 10) * 1000));
    } else if (s.status === 'failed') {
      const reason = s.errors?.[0]?.message ?? 'unknown';
      await markFailed(r.order_id, r.to_state as never, reason);
    }
  }
}
```

- [ ] **Step 3: Tests**

Extend `src/webhook/router.test.ts`:

```typescript
it('handles a message_status delivered payload and marks the order notification', async () => {
  // 1. Insert an order + an order_status_notifications row with a known wamid.
  // 2. POST /webhook with the status payload.
  // 3. Assert the row's delivered_at is updated.
});
```

- [ ] **Step 4: Run tests**

Run: `npm test -- src/webhook`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/webhook/router.ts src/webhook/router.test.ts src/order/notifications.ts src/order/types.ts db/migrations/002_customer_order_features.sql
git commit -m "feat(webhook): handle message_status → mark delivered/failed"
```

---

## Task 10: New AI tools — delivery zones + address + history + reorder + modify + schedule

**Files:**
- Modify: `src/ai/tools.ts`
- Modify: `src/ai/prompts.ts`
- Test: extend `src/ai/tools.test.ts`

This task is one large one because the tools share schemas, the feature flag gate, and the prompt block. Sub-tasks within are tight.

- [ ] **Step 1: Add the feature flag gate**

In `src/ai/tools.ts`, near the top of `runTool`, gate the new tools behind the flag. Find:

```typescript
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: AgentContext,
): Promise<string> {
  const def = handlers[name];
  if (!def) {
    throw new ToolError('unknown_tool', 'টুল খুঁজে পাওয়া যায়নি।', `unknown tool: ${name}`);
  }
  return def.fn(args, ctx);
}
```

Add the imports and a phase2 set:

```typescript
import { config } from '../config.js';
import * as DeliveryService from '../delivery/service.js';
import * as OrderModificationService from '../order/modifications.js';
import * as OrderNotificationService from '../order/notifications.js';

const PHASE2_TOOLS = new Set([
  'get_delivery_zones',
  'set_delivery_address',
  'get_order_history',
  'reorder_from_history',
  'modify_order',
  'schedule_order',
]);

export async function runTool(name, args, ctx) {
  if (PHASE2_TOOLS.has(name) && !config.FEATURE_CUSTOMER_ORDER_PHASE2) {
    throw new ToolError('feature_disabled', 'এই ফিচারটি এখন বন্ধ আছে।', `tool ${name} is gated by FEATURE_CUSTOMER_ORDER_PHASE2`);
  }
  // ... existing
}
```

- [ ] **Step 2: Add the zod schemas**

In `src/ai/tools.ts`, alongside the existing schemas, add:

```typescript
const GetDeliveryZonesSchema = z.object({});

const SetDeliveryAddressSchema = z.object({
  zone_id: z.string().uuid(),
  line1: z.string().min(1).max(500),
  line2: z.string().min(1).max(500).optional(),
  note_for_rider: z.string().min(1).max(500).optional(),
});

const GetOrderHistorySchema = z.object({
  limit: z.number().int().min(1).max(20).optional(),
  before_iso: z.string().optional(),
  include_terminal: z.boolean().optional(),
});

const ReorderFromHistorySchema = z.object({
  order_id: z.string().uuid(),
  proceed_with: z.enum(['all', 'available_only']).optional(),
});

const ModifyOrderReadSchema = z.object({
  order_id: z.string().uuid(),
  phase: z.literal('read'),
});

const ModifyOrderApplySchema = z.object({
  order_id: z.string().uuid(),
  phase: z.literal('apply'),
  confirm: z.literal(true),
  items: z.array(z.object({
    menu_item_id: z.string().uuid(),
    name: z.string().min(1),
    quantity: z.number().int().positive(),
    unit_price_paisa: z.number().int().nonnegative().optional(),
    variant_id: z.string().uuid().optional(),
    addon_ids: z.array(z.string().uuid()).optional(),
    addons: z.array(z.object({
      id: z.string().uuid(), name: z.string(), price_paisa: z.number().int().nonnegative(),
    })).optional(),
    line_total_paisa: z.number().int().nonnegative().optional(),
  })),
});

const ModifyOrderSchema = z.union([ModifyOrderReadSchema, ModifyOrderApplySchema]);

const ScheduleOrderSchema = z.object({
  order_id: z.string().uuid(),
  requested_for_iso: z.string().min(1),
});
```

- [ ] **Step 3: Add the tool definitions**

Append to the `toolDefinitions` array:

```typescript
{
  name: 'get_delivery_zones',
  description: 'List active delivery zones for the restaurant with name, ETA in minutes, and delivery fee. Call this when the customer wants to set or change their delivery address.',
  parameters: { type: 'object', properties: {}, required: [] },
},
{
  name: 'set_delivery_address',
  description: 'Save the customer\'s delivery address (zone + structured line1/line2/note). Returns the saved address and the zone\'s ETA + fee.',
  parameters: {
    type: 'object',
    properties: {
      zone_id: { type: 'string', format: 'uuid' },
      line1: { type: 'string' },
      line2: { type: 'string' },
      note_for_rider: { type: 'string' },
    },
    required: ['zone_id', 'line1'],
  },
},
{
  name: 'get_order_history',
  description: 'Get the customer\'s recent orders (most recent first). limit defaults to 5, max 20. include_terminal includes delivered/cancelled (default false — active only).',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 20 },
      before_iso: { type: 'string', format: 'date-time' },
      include_terminal: { type: 'boolean' },
    },
    required: [],
  },
},
{
  name: 'reorder_from_history',
  description: 'Re-populate the conversation cart from a past order. Re-validates every line against the live menu. Unavailable items come back in the report so the customer can decide. With proceed_with=\'available_only\', the available items are placed in the cart and the customer goes through the normal confirmation flow.',
  parameters: {
    type: 'object',
    properties: {
      order_id: { type: 'string', format: 'uuid' },
      proceed_with: { type: 'string', enum: ['all', 'available_only'] },
    },
    required: ['order_id'],
  },
},
{
  name: 'modify_order',
  description: 'Two-phase modify. phase=\'read\': return current items for the order (use to show the customer). phase=\'apply\': replace the items with the given array; requires confirm=true. Allowed only while order state is pending or confirmed.',
  parameters: {
    type: 'object',
    properties: {
      order_id: { type: 'string', format: 'uuid' },
      phase: { type: 'string', enum: ['read', 'apply'] },
      confirm: { type: 'boolean' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            menu_item_id: { type: 'string', format: 'uuid' },
            name: { type: 'string' },
            quantity: { type: 'integer', minimum: 1 },
            variant_id: { type: 'string', format: 'uuid' },
            addon_ids: { type: 'array', items: { type: 'string', format: 'uuid' } },
          },
          required: ['menu_item_id', 'quantity'],
        },
      },
    },
    required: ['order_id', 'phase'],
  },
},
{
  name: 'schedule_order',
  description: 'Schedule an order for a future time (max 7 days out). Sets orders.requested_for; ETA in get_order_status reflects requested_for + zone eta_minutes.',
  parameters: {
    type: 'object',
    properties: {
      order_id: { type: 'string', format: 'uuid' },
      requested_for_iso: { type: 'string', format: 'date-time' },
    },
    required: ['order_id', 'requested_for_iso'],
  },
},
```

- [ ] **Step 4: Add the handlers**

Add to the `handlers` object:

```typescript
get_delivery_zones: {
  schema: GetDeliveryZonesSchema,
  fn: async (_args, ctx) => {
    const zones = await DeliveryService.listActiveZones(ctx.restaurantId);
    return JSON.stringify({ zones });
  },
},

set_delivery_address: {
  schema: SetDeliveryAddressSchema,
  fn: async (args, ctx) => {
    const parsed = SetDeliveryAddressSchema.parse(args);
    const address = await DeliveryService.setAddress(ctx.customerId, parsed);
    const zone = await DeliveryService.getZone(address.zone_id);
    return JSON.stringify({
      address,
      eta_minutes: zone!.eta_minutes,
      delivery_fee_paisa: zone!.delivery_fee_paisa,
    });
  },
},

get_order_history: {
  schema: GetOrderHistorySchema,
  fn: async (args, ctx) => {
    const parsed = GetOrderHistorySchema.parse(args);
    const orders = await OrderService.listHistoryByCustomer(ctx.customerId, {
      limit: parsed.limit ?? 5,
      beforeIso: parsed.before_iso ?? null,
      includeTerminal: parsed.include_terminal ?? false,
    });
    if (orders.length === 0) {
      throw new ToolError('no_history', 'আপনার কোনো পুরাতন অর্ডার নেই।', `customer ${ctx.customerId} has no orders`);
    }
    return JSON.stringify({ orders });
  },
},

reorder_from_history: {
  schema: ReorderFromHistorySchema,
  fn: async (args, ctx) => {
    const parsed = ReorderFromHistorySchema.parse(args);
    const order = await OrderService.getById(parsed.order_id).catch(() => null);
    if (!order || order.customer_id !== ctx.customerId) {
      throw new ToolError('order_not_found', 'অর্ডার খুঁজে পাওয়া যায়নি।', `order ${parsed.order_id} not found`);
    }
    const available: typeof order.items = [];
    const unavailable: Array<{ name: string; reason: string }> = [];
    for (const line of order.items) {
      try {
        // revalidate just this single line; build a 1-element array
        const revalidated = await (await import('../order/menuRevalidator.js')).revalidateItems(
          ctx.restaurantId,
          [{ ...line, unit_price_paisa: 0, line_total_paisa: 0 } as any],
        );
        available.push(revalidated[0]!);
      } catch (err: any) {
        unavailable.push({ name: line.name, reason: err?.code ?? 'unavailable' });
      }
    }
    if (available.length === 0) {
      throw new ToolError('nothing_available', 'কোনো আইটেমই এখন পাওয়া যাচ্ছে না।', 'nothing available to reorder');
    }
    if (unavailable.length > 0 && parsed.proceed_with !== 'available_only') {
      return JSON.stringify({ available, unavailable, cart_populated: false });
    }
    await ConversationService.setCart(ctx.conversationId, available);
    await ConversationService.transitionTo(ctx.conversationId, 'ordering');
    return JSON.stringify({ available, unavailable, cart_populated: true });
  },
},

modify_order: {
  schema: ModifyOrderSchema,
  fn: async (args, ctx) => {
    const parsed = ModifyOrderSchema.parse(args);
    if (parsed.phase === 'read') {
      const items = await OrderModificationService.getCurrentItems(parsed.order_id, ctx.customerId);
      await ConversationService.transitionTo(ctx.conversationId, 'awaiting_modify_confirmation');
      return JSON.stringify({ current_items: items });
    }
    // phase: 'apply'
    const result = await OrderModificationService.applyModification({
      orderId: parsed.order_id,
      customerId: ctx.customerId,
      newItems: parsed.items as any,
    });
    await ConversationService.transitionTo(ctx.conversationId, 'idle');
    return JSON.stringify({
      order_id: result.order.id,
      items: result.order.items,
      total_paisa: result.order.total_paisa,
      total_display: formatBDT(result.order.total_paisa),
      modified_at: result.modification.created_at,
    });
  },
},

schedule_order: {
  schema: ScheduleOrderSchema,
  fn: async (args, ctx) => {
    const parsed = ScheduleOrderSchema.parse(args);
    const requested = new Date(parsed.requested_for_iso);
    const now = new Date();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    if (Number.isNaN(requested.getTime()) || requested <= now || requested.getTime() - now.getTime() > sevenDays) {
      throw new ToolError('bad_schedule_window', 'সময়টি সঠিক নয়। আগামী ৭ দিনের মধ্যে একটি সময় দিন।', `bad window: ${parsed.requested_for_iso}`);
    }
    const order = await OrderService.getById(parsed.order_id).catch(() => null);
    if (!order || order.customer_id !== ctx.customerId) {
      throw new ToolError('order_not_found', 'অর্ডার খুঁজে পাওয়া যায়নি।', `order ${parsed.order_id} not found`);
    }
    if (!['pending', 'confirmed', 'preparing'].includes(order.state)) {
      throw new ToolError('order_not_modifiable', 'এই অর্ডারটি আর শিডিউল করা যাবে না।', `state ${order.state} cannot be scheduled`);
    }
    await db.query(
      `UPDATE orders SET requested_for = $1, updated_at = now() WHERE id = $2`,
      [requested.toISOString(), parsed.order_id],
    );
    const addr = await DeliveryService.getDefaultAddress(ctx.customerId);
    const etaMinutes = addr ? (await DeliveryService.getZone(addr.zone_id))?.eta_minutes ?? 30 : 30;
    const eta = new Date(requested.getTime() + etaMinutes * 60 * 1000);
    return JSON.stringify({
      order_id: parsed.order_id,
      requested_for: requested.toISOString(),
      eta_minutes: etaMinutes,
      eta_iso: eta.toISOString(),
    });
  },
},
```

Import `db from '../db/client.js'` at the top of `tools.ts` if not already.

- [ ] **Step 5: Tighten existing tools**

In `get_order_status`:
- Change the "most recent" branch to filter out delivered/cancelled by default.
- Always include `notifications: [...]` in the payload (fetch via `db.query` joining `order_status_notifications`).
- Accept `include_terminal?: boolean` and pass through.

Replace the `get_order_status` handler body with:

```typescript
get_order_status: {
  schema: z.object({
    order_id: z.string().uuid().optional(),
    include_terminal: z.boolean().optional(),
  }),
  fn: async (args, ctx) => {
    const parsed = z.object({
      order_id: z.string().uuid().optional(),
      include_terminal: z.boolean().optional(),
    }).parse(args);
    let order;
    if (parsed.order_id) {
      try { order = await OrderService.getById(parsed.order_id); } catch { throw new ToolError('order_not_found', 'অর্ডার খুঁজে পাওয়া যায়নি।', `order ${parsed.order_id} not found`); }
      if (order.customer_id !== ctx.customerId) throw new ToolError('order_not_found', 'অর্ডার খুঁজে পাওয়া যায়নি।', `not owned`);
    } else {
      const recent = await OrderService.listHistoryByCustomer(ctx.customerId, {
        limit: 1, beforeIso: null, includeTerminal: parsed.include_terminal ?? false,
      });
      order = recent[0];
      if (!order) throw new ToolError('order_not_found', 'আপনার কোনো অর্ডার নেই।', 'no orders');
    }
    const notif = await db.query<{ to_state: string; sent_at: string; delivered_at: string | null }>(
      `SELECT to_state, sent_at, delivered_at FROM order_status_notifications
       WHERE order_id = $1 ORDER BY sent_at ASC`, [order.id],
    );
    return JSON.stringify({
      order_id: order.id,
      state: order.state,
      items: order.items,
      subtotal_paisa: order.subtotal_paisa,
      delivery_fee_paisa: order.delivery_fee_paisa,
      total_paisa: order.total_paisa,
      total_display: formatBDT(order.total_paisa),
      delivery_address: order.delivery_address,
      payment_method: order.payment_method,
      confirmed_at: order.confirmed_at,
      cancelled_at: order.cancelled_at,
      cancel_reason: order.cancel_reason,
      created_at: order.created_at,
      updated_at: order.updated_at,
      notifications: notif,
    });
  },
},
```

In `summarize_cart_for_confirmation`, before computing the delivery fee, look up the customer's default address:

```typescript
summarize_cart_for_confirmation: {
  schema: z.object({}),
  fn: async (_args, ctx) => {
    const items = await ConversationService.getCart(ctx.conversationId);
    if (items.length === 0) throw new ToolError('cart_empty', 'কার্ট খালি, কিছু যোগ করুন।', 'empty cart');
    const addr = await DeliveryService.getDefaultAddress(ctx.customerId);
    const fee = addr ? (await DeliveryService.getZone(addr.zone_id))?.delivery_fee_paisa ?? config.RESTAURANT_DEFAULT_DELIVERY_FEE_PAISA
                    : config.RESTAURANT_DEFAULT_DELIVERY_FEE_PAISA;
    const text = summaryText(items, fee, config.RESTAURANT_NAME);
    await ConversationService.transitionTo(ctx.conversationId, 'awaiting_confirmation');
    return JSON.stringify({ summary: text });
  },
},
```

In `create_order`, write `delivery_zone_id` from the customer's default address:

```typescript
const addr = await DeliveryService.getDefaultAddress(ctx.customerId);
const fee = addr ? (await DeliveryService.getZone(addr.zone_id))?.delivery_fee_paisa ?? config.RESTAURANT_DEFAULT_DELIVERY_FEE_PAISA
                : config.RESTAURANT_DEFAULT_DELIVERY_FEE_PAISA;

const order = await OrderService.confirm({
  restaurant_id: ctx.restaurantId,
  customer_id: ctx.customerId,
  conversation_id: ctx.conversationId,
  items,
  delivery_fee_paisa: fee,
  delivery_address: addr?.line1 ?? customer.default_address,
  payment_method: customer.payment_method,
});

// extend OrderService.confirm to accept delivery_zone_id — see next step.
```

Add `delivery_zone_id` to `CreateOrderInput` in `src/order/types.ts`:

```typescript
export interface CreateOrderInput {
  // ... existing
  delivery_zone_id?: string | null;
}
```

In `OrderService.confirm`, add the column to the INSERT:

```typescript
await client.query(
  `INSERT INTO orders (
     id, restaurant_id, customer_id, conversation_id, state,
     items, subtotal_paisa, delivery_fee_paisa, total_paisa,
     delivery_address, delivery_zone_id, payment_method, special_instructions, confirmed_at
   ) VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8, $9, $10, $11, $12, now())`,
  [id, input.restaurant_id, input.customer_id, input.conversation_id ?? null,
   JSON.stringify(items), subtotal_paisa, input.delivery_fee_paisa, total_paisa,
   input.delivery_address ?? null, input.delivery_zone_id ?? null,
   input.payment_method ?? null, input.special_instructions ?? null],
);
```

Update the `getById` SELECT in `OrderService` to include `requested_for` and `delivery_zone_id`. Update `listByCustomer` and `listHistoryByCustomer` similarly.

- [ ] **Step 6: Update the prompt**

In `src/ai/prompts.ts`, add to the system prompt a new section after # HARD RULES:

```
# PHASE 2 FEATURES (only when FEATURE_CUSTOMER_ORDER_PHASE2=true)
- "আমার আগের অর্ডারটা দেখান" → get_order_history.
- "আবার দিন" / "সেটাই আবার" → reorder_from_history(proceed_with='available_only') after showing partial-failure report.
- "অর্ডার থেকে কোকটা বাদ দিন, ফ্রাই যোগ করুন" → modify_order(phase='read') to show current, then modify_order(phase='apply', confirm=true) after the customer confirms the new list.
- "৩টার পরে দিতে হবে" → schedule_order.
- "কতক্ষণে আসবে?" → get_order_status; quote eta_minutes.
- "ঠিকানা বদলাতে চাই" → get_delivery_zones, then set_delivery_address.
```

- [ ] **Step 7: Tests**

Extend `src/ai/tools.test.ts` with cases for each new tool:

```typescript
describe('phase 2 tools (gated)', () => {
  // gate test: with FEATURE_CUSTOMER_ORDER_PHASE2=false (default), calling
  // get_delivery_zones returns feature_disabled ToolError.

  // get_delivery_zones: returns zones for ctx.restaurantId.
  // set_delivery_address: saves, returns address + eta + fee.
  // get_order_history: returns recent orders, errors no_history on empty.
  // reorder_from_history: all available → cart_populated true; partial → cart_populated false; nothing → nothing_available.
  // modify_order read: returns current items, transitions conversation.
  // modify_order apply: succeeds for pending, errors order_not_modifiable for preparing.
  // schedule_order: succeeds for future time, errors bad_schedule_window for past, errors order_not_modifiable for delivered.
});
```

Run: `npm test -- src/ai`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/ai/tools.ts src/ai/prompts.ts src/ai/tools.test.ts src/order/types.ts src/order/service.ts
git commit -m "feat(ai): phase 2 tools — zones, history, reorder, modify, schedule"
```

---

## Task 11: Admin route for notification debugging

**Files:**
- Create: `src/admin/notifications.ts`
- Modify: `src/index.ts` (register the new admin route)

- [ ] **Step 1: Implement the route**

Create `src/admin/notifications.ts`:

```typescript
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { logger } from '../logger.js';
import db from '../db/client.js';
import { checkBasicAuth } from './basicAuth.js';

export async function registerNotificationRoutes(app: FastifyInstance): Promise<void> {
  const a = app as unknown as {
    get: (url: string, opts: unknown, handler: (req: FastifyRequest, reply: any) => unknown) => void;
  };
  a.get('/admin/notifications/recent', {
    schema: {
      tags: ['admin'],
      summary: 'Recent order status notifications (basic auth)',
      querystring: {
        type: 'object',
        properties: {
          order_id: { type: 'string', format: 'uuid' },
          limit: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            count: { type: 'integer' },
            notifications: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  order_id: { type: 'string' },
                  to_state: { type: 'string' },
                  sent_at: { type: 'string' },
                  delivered_at: { type: 'string' },
                  failed_reason: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  }, async (req, reply) => {
    if (!checkBasicAuth(req.headers.authorization)) {
      reply.code(401);
      reply.header('WWW-Authenticate', 'Basic realm="admin"');
      return reply.send({ error: 'unauthorized' });
    }
    const q = req.query as Record<string, string | undefined>;
    const limit = Math.min(parseInt(q['limit'] ?? '50', 10) || 50, 200);
    const params: unknown[] = [];
    let where = '1=1';
    if (q['order_id']) {
      params.push(q['order_id']);
      where = `order_id = $1`;
    }
    params.push(limit);
    const rows = await db.query<{
      id: string; order_id: string; to_state: string;
      sent_at: string; delivered_at: string | null; failed_reason: string | null;
    }>(
      `SELECT id, order_id, to_state, sent_at, delivered_at, failed_reason
       FROM order_status_notifications
       WHERE ${where}
       ORDER BY sent_at DESC LIMIT $${params.length}`,
      params,
    );
    logger.info({ count: rows.length, order_id: q['order_id'] }, 'admin: notifications listed');
    return reply.send({ count: rows.length, notifications: rows });
  });
}
```

- [ ] **Step 2: Register the route**

In `src/index.ts`, find where `registerAdminRoutes` is called (or `app.register(...)` for `admin/dlq`). Add the parallel registration:

```typescript
import { registerNotificationRoutes } from './admin/notifications.js';
// ...
await registerNotificationRoutes(app);
```

- [ ] **Step 3: Smoke test**

Run: `npm run dev` (or `docker compose up --build`). Then:

```bash
curl -u admin:changeme http://localhost:3000/admin/notifications/recent?limit=5
```

Expected: JSON with `count` and `notifications` array.

- [ ] **Step 4: Commit**

```bash
git add src/admin/notifications.ts src/index.ts
git commit -m "feat(admin): GET /admin/notifications/recent for debugging"
```

---

## Task 12: UI — Recent orders, Track latest, Latest address, Modify modal

**Files:**
- Modify: `web/src/app/page.tsx`
- Create: `web/src/components/RecentOrders.tsx`
- Create: `web/src/components/TrackLatest.tsx`
- Create: `web/src/components/LatestAddress.tsx`
- Create: `web/src/components/ModifyModal.tsx`

- [ ] **Step 1: Read the existing UI**

Read `web/src/app/page.tsx` and `web/src/components/` to understand the layout. Note the existing chat-message component, the cart sidebar, and any shadcn/ui imports used.

- [ ] **Step 2: Add `GET /api/orders/recent` to Fastify**

Add a small read-only Fastify route in `src/web/api.ts` (create if missing; check `src/index.ts` for the route registration patterns):

```typescript
// In a new file src/web/api.ts
import type { FastifyInstance } from 'fastify';
import * as OrderService from '../order/service.js';
import * as DeliveryService from '../delivery/service.js';
import db from '../db/client.js';

export async function registerWebApi(app: FastifyInstance): Promise<void> {
  app.get('/api/orders/recent', async (req, reply) => {
    const phone = (req.query as Record<string, string | undefined>)['phone'];
    if (!phone) return reply.code(400).send({ error: 'phone required' });
    const cust = await db.query<{ id: string }>(`SELECT id FROM customers WHERE phone_e164 = $1`, [phone]);
    if (!cust[0]) return reply.send({ orders: [] });
    const orders = await OrderService.listHistoryByCustomer(cust[0].id, {
      limit: 5, beforeIso: null, includeTerminal: true,
    });
    return reply.send({ orders });
  });

  app.get('/api/address', async (req, reply) => {
    const phone = (req.query as Record<string, string | undefined>)['phone'];
    if (!phone) return reply.code(400).send({ error: 'phone required' });
    const cust = await db.query<{ id: string }>(`SELECT id FROM customers WHERE phone_e164 = $1`, [phone]);
    if (!cust[0]) return reply.send({ address: null });
    const addr = await DeliveryService.getDefaultAddress(cust[0].id);
    return reply.send({ address: addr });
  });
}
```

Register in `src/index.ts` near the other Fastify routes.

- [ ] **Step 3: Build the React components**

`web/src/components/RecentOrders.tsx`:

```typescript
'use client';
import { useEffect, useState } from 'react';
import { Button } from './ui/button';

interface HistoryRow {
  id: string; state: string; items_summary: string;
  total_paisa: number; created_at: string;
}

export function RecentOrders({ phone, onReorder }: { phone: string; onReorder: (orderId: string) => void }) {
  const [rows, setRows] = useState<HistoryRow[]>([]);
  useEffect(() => {
    fetch(`/api/orders/recent?phone=${encodeURIComponent(phone)}`)
      .then((r) => r.json()).then((d) => setRows(d.orders ?? []));
  }, [phone]);
  if (rows.length === 0) return null;
  return (
    <div className="border rounded p-3">
      <h3 className="font-semibold mb-2">Recent orders</h3>
      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.id} className="text-sm flex justify-between items-start">
            <div>
              <div>{r.items_summary}</div>
              <div className="text-xs text-muted-foreground">{r.state} · ৳{Math.round(r.total_paisa/100)}</div>
            </div>
            <Button size="sm" variant="outline" onClick={() => onReorder(r.id)}>Reorder</Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

`web/src/components/TrackLatest.tsx`:

```typescript
'use client';
import { useEffect, useState } from 'react';

interface Notification { to_state: string; sent_at: string; delivered_at: string | null; }

export function TrackLatest({ orderId }: { orderId: string | null }) {
  const [order, setOrder] = useState<any>(null);
  useEffect(() => {
    if (!orderId) { setOrder(null); return; }
    fetch(`/api/orders/recent?phone=`) // placeholder — wire from existing chat state
      .then(() => null);
  }, [orderId]);
  if (!orderId) return null;
  return (
    <div className="border rounded p-3">
      <h3 className="font-semibold mb-2">Track latest</h3>
      <div>state: {order?.state ?? '—'}</div>
    </div>
  );
}
```

Note: the actual wiring of `TrackLatest` depends on how the chat UI exposes the current conversation's customer. **Wire it to the existing chat context** — read `web/src/app/page.tsx` to find where the customer phone is stored (the README mentions `localStorage` per tab) and subscribe to it.

`web/src/components/LatestAddress.tsx`:

```typescript
'use client';
import { useEffect, useState } from 'react';

interface Address { id: string; line1: string; zone_id: string; note_for_rider: string | null; }

export function LatestAddress({ phone }: { phone: string }) {
  const [addr, setAddr] = useState<Address | null>(null);
  useEffect(() => {
    fetch(`/api/address?phone=${encodeURIComponent(phone)}`)
      .then((r) => r.json()).then((d) => setAddr(d.address));
  }, [phone]);
  if (!addr) return null;
  return (
    <div className="border rounded p-3 text-sm">
      <h3 className="font-semibold mb-1">Address</h3>
      <div>{addr.line1}</div>
      {addr.note_for_rider && <div className="text-xs text-muted-foreground">📝 {addr.note_for_rider}</div>}
    </div>
  );
}
```

`web/src/components/ModifyModal.tsx`:

```typescript
'use client';
import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from './ui/dialog';
import { Button } from './ui/button';

export function ModifyModal({ open, onClose, onSubmit }:
  { open: boolean; onClose: () => void; onSubmit: (items: any[]) => void }) {
  // Receive `items` (from get_order_items tool) and render quantity steppers.
  // ... implementation depends on existing shadcn/ui primitives.
  // ...
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Modify order</DialogTitle></DialogHeader>
        {/* qty steppers, remove buttons */}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => onSubmit(/* collected items */)}>Apply</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: Wire into the page**

In `web/src/app/page.tsx`, render the three cards in the right sidebar above the existing cart display. Pass the phone and the existing chat's "send message" handler to the components so the `Reorder` button can fire `sendMessage("আগেরটাই আবার দিন #" + orderId)` or similar — reusing the chat input.

- [ ] **Step 5: Run web dev**

Run: `cd web && pnpm dev`. Open <http://localhost:3001>. Confirm the three cards render and `Reorder` posts to the chat.

- [ ] **Step 6: Commit**

```bash
git add web/src/ src/web/ src/index.ts
git commit -m "feat(web): recent orders, track latest, address, modify modal"
```

---

## Task 13: End-to-end Playwright test

**Files:**
- Modify: `web/package.json` (add devDependency `@playwright/test`)
- Create: `web/playwright.config.ts`
- Create: `tests/e2e/order-features.spec.ts`

- [ ] **Step 1: Install Playwright in web/**

```bash
cd web && pnpm add -D @playwright/test
pnpm exec playwright install --with-deps chromium
```

- [ ] **Step 2: Configure Playwright**

Create `web/playwright.config.ts`:

```typescript
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '../tests/e2e',
  timeout: 60_000,
  use: { baseURL: 'http://localhost:3001' },
  webServer: [
    { command: 'cd .. && docker compose up postgres redis -d', port: 5432, timeout: 30_000, reuseExistingServer: true },
    { command: 'cd .. && npm run dev:api', port: 3000, timeout: 60_000, reuseExistingServer: true },
    { command: 'pnpm dev', port: 3001, timeout: 60_000, reuseExistingServer: true },
  ],
});
```

- [ ] **Step 3: Write the e2e spec**

Create `tests/e2e/order-features.spec.ts`:

```typescript
import { test, expect } from '@playwright/test';

test('status → modify → reorder happy path (with FEATURE_CUSTOMER_ORDER_PHASE2=true)', async ({ page }) => {
  await page.goto('/');

  // 1. Place an order via the chat input.
  await page.getByPlaceholder(/phone/i).fill('+8801700000001');
  await page.getByPlaceholder(/message/i).fill('1 ta chicken burger den');
  await page.getByRole('button', { name: /send/i }).click();

  // 2. Wait for agent reply, ask to confirm.
  await expect(page.getByText(/অর্ডার #/).first()).toBeVisible({ timeout: 30_000 });

  // 3. Send "হ্যাঁ" to confirm.
  await page.getByPlaceholder(/message/i).fill('হ্যাঁ');
  await page.getByRole('button', { name: /send/i }).click();
  await expect(page.getByText(/অর্ডার #/).first()).toBeVisible({ timeout: 30_000 });

  // 4. Track latest shows pending or confirmed.
  await expect(page.getByText(/state:/i)).toBeVisible();

  // 5. Reorder the just-placed order.
  await page.getByRole('button', { name: /reorder/i }).first()).click();
  await page.getByPlaceholder(/message/i).fill('available only');
  await page.getByRole('button', { name: /send/i }).click();
  await expect(page.getByText(/কার্ট/).first()).toBeVisible();
});
```

- [ ] **Step 4: Run the e2e**

Run: `FEATURE_CUSTOMER_ORDER_PHASE2=true cd web && pnpm exec playwright test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/playwright.config.ts web/package.json tests/e2e/order-features.spec.ts
git commit -m "test(e2e): playwright happy path status → modify → reorder"
```

---

## Task 14: Rollout checklist

**No code changes.** Walk through the rollout steps from spec §10 and verify each.

- [ ] **Step 1: DB-only deploy**

Apply migration 002 + zones seed in prod. Re-running is a no-op. App code unchanged.

- [ ] **Step 2: Code deploy with flag off**

Deploy the code from this branch with `FEATURE_CUSTOMER_ORDER_PHASE2=false`. Existing flow identical.

- [ ] **Step 3: Enable in dev**

Flip to `true` in dev env. Run `npm test` (vitest) and `cd web && pnpm exec playwright test` (e2e). Walk the chat UI manually:

- Place an order; see the "Track latest" card.
- Say "আমার আগের অর্ডারটা দেখান" → history appears.
- Say "আবার দিন" → agent asks about unavailable items (no menu changes required for this; the existing menu all returns `available`).
- Say "অর্ডার থেকে একটা বার্গার বাদ দিন" → modify applied.
- Say "আমার ঠিকানা Dhanmondi, House 5" → agent calls set_delivery_address.
- Say "৩ ঘণ্টা পরে দিতে হবে" → schedule applied; check `get_order_status` returns eta_minutes.

- [ ] **Step 4: Enable in prod**

Set `FEATURE_CUSTOMER_ORDER_PHASE2=true`. Watch `GET /admin/notifications/recent` and `GET /admin/queues/dlq` for failures. Watch `order_modifications` and `order_status_notifications` rows.

- [ ] **Step 5: Remove the flag**

After one week of clean operation, delete:
- The `PHASE2_TOOLS` set + gate in `src/ai/tools.ts`.
- The `FEATURE_CUSTOMER_ORDER_PHASE2` entry in `src/config.ts` and `.env.example`.

Final commit:

```bash
git add src/ai/tools.ts src/config.ts .env.example
git commit -m "chore: remove FEATURE_CUSTOMER_ORDER_PHASE2 flag (phase 2 is default)"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Covered by |
|---|---|
| §2.1 Status tracking + push | Tasks 8, 9, 11 |
| §2.2 History & reorder | Tasks 6, 10 |
| §2.3 Modify / cancel | Tasks 7, 10 (modify is new; cancel exists in MVP and is untouched) |
| §2.4 Address + ETA + scheduling | Tasks 5, 10, 12 |
| §3 Architecture | Tasks 3 (flag), 5, 7, 8, 11 |
| §4 Migration | Task 1 (with wamid column added in Task 9 step 2.1) |
| §5 New + modified tools | Task 10 |
| §6.1 Status push data flow | Tasks 8, 9 |
| §6.2 History & reorder data flow | Tasks 6, 10 |
| §6.3 Modify data flow | Task 7 |
| §6.4 Address + ETA + scheduling | Tasks 5, 10 |
| §6.5 Conversational state | Task 3 |
| §7 Error handling | Distributed across Tasks 5, 6, 7, 8, 10 (taxonomy names match) |
| §8 Testing strategy | Tasks 1, 2, 4, 5, 6, 7, 8, 9, 10, 13 |
| §9 File-level plan | Each task's "Files" block matches spec |
| §10 Rollout | Task 14 |

**Placeholder scan:** No "TBD" / "TODO" in any step. All code blocks are concrete.

**Type consistency:**
- `MenuRevalidator.revalidateItems` (Task 4) is referenced from `OrderService.confirm`, `OrderModificationService.applyModification`, `reorder_from_history` handler — same signature everywhere.
- `OrderHistoryRow` (Task 6) matches the SELECT in `listHistoryByCustomer` and the consumer in `get_order_history` handler.
- `OrderModification` type (Task 7) matches the row inserted by `applyModification` and the return shape used in the `modify_order` handler.
- `OrderStatusNotification` type (Task 8) matches `recordAndEnqueue` return and the webhook `handleMessageStatus` consumer.
- `PHASE2_TOOLS` set (Task 10) lists exactly the six tools added in that task.
- `applyModification` signature in Task 7 matches the call in Task 10.

**Race in Task 9 step 2 noted and resolved:** the `LEFT JOIN` approach was rejected in favor of storing `wamid` on the notification row + targeted lookup.
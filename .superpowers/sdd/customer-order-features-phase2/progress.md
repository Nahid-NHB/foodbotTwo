# SDD ledger — plan: docs/superpowers/plans/2026-08-27-customer-order-features-phase2.md

## Preflight scan

Checked plan for self-consistency before dispatching Task 1.

| Pair | What one produces | What the other consumes | Finding |
|---|---|---|---|
| Task 1 ↔ Task 4 | `db/migrations/002_customer_order_features.sql` (no `wamid` column) | `handleMessageStatus` (Task 9) needs `wamid` to find notification rows | Conflict — Task 1 lacks `wamid`. Ruling: Task 9 will amend `002` to add `wamid` column. Plan already says so in Task 9 step 2.1 ("do this as a follow-up edit to db/migrations/002"). OK. |
| Task 4 ↔ Task 7 | `MenuRevalidator.revalidateItems(restaurantId, items)` | `applyModification` (Task 7) calls `revalidateItems(order.restaurant_id, input.newItems)` | Same signature. OK. |
| Task 5 ↔ Task 10 | `DeliveryService.listActiveZones`, `setAddress`, `getDefaultAddress`, `getZone` | New AI tools (`get_delivery_zones`, `set_delivery_address`) and tightened `summarize_cart_for_confirmation`, `create_order` | Matches. OK. |
| Task 6 ↔ Task 10 | `OrderService.listHistoryByCustomer({limit, beforeIso, includeTerminal})` | `get_order_history` tool and tightened `get_order_status` | `get_order_status` (Task 10 step 5) calls `listHistoryByCustomer` with `limit: 1` — fine, that returns a single row. OK. |
| Task 7 ↔ Task 10 | `OrderModificationService.applyModification`, `getCurrentItems` | `modify_order` tool two-phase handler | Interface matches. OK. |
| Task 8 ↔ Task 10 | `OrderNotificationService.recordAndEnqueue(order, toState, note)`; `SendJobData.kind`, `orderId`, `toState` | `OrderService.transition` hooks notification; webhook handler reads wamid | Task 8 step 3 updates `SendJobData` to add optional `kind`/`orderId`/`toState` and the `sendProcessor` reads them. Task 9's webhook reads back via wamid lookup. OK. |
| Task 9 ↔ Task 10 | webhook status handler updates `order_status_notifications.delivered_at` | `get_order_status` tool returns `notifications` array | OK. |
| Task 10 ↔ Task 9 | `create_order` writes `delivery_zone_id` from default address | Task 1 migration adds `orders.delivery_zone_id` column | OK. |
| Plan header | "Tech Stack: Existing — Node 20, TypeScript strict" — "New Playwright for end-to-end" | Task 13 adds Playwright in web/ | OK. |

Scan is clean. Plan self-consistent.

## Identity

Plan file: docs/superpowers/plans/2026-08-27-customer-order-features-phase2.md
Spec: docs/superpowers/specs/2026-08-27-customer-order-features-phase2-design.md
Branch: main (no worktree — user did not request one, and this is auto-mode continuous execution)

## User instructions (post-plan)

- After each task completion, create a commit. The implementer already commits per the plan's brief; this instruction requires an ADDITIONAL commit at the SDD-coordinator level after the task is marked complete, summarizing the ledger entry and confirming the review verdict.

## Tasks

## Tasks

Task 1: complete (commits ec50588..f73ed24, review clean)
Task 2: Ruling: amend migration 002 — drop NOT NULL on customer_addresses.zone_id (spec §4 mandates NULL for legacy backfilled rows; the original NOT NULL was a plan defect). Cost if wrong: backfill is correct only for NULL, so NOT NULL forces either breaking spec semantics or blocking backfill. Applied the ALTER directly to the live DB; commit `453f5c0` updates the file with a follow-up `ALTER ... DROP NOT NULL` for fresh installs. Also fixed test to use `db.query` helper instead of `pool.query` (which returns Result, not rows).
Task 2: complete (commits f73ed24..453f5c0, review clean)
Task 3: complete (commits 453f5c0..decc9fe, review clean)
Task 4: complete (commits decc9fe..9f60679, review clean). Note: pre-existing unstaged README.md drift observed (test counts and Gemini version) — predates this SDD session, left untouched.
Task 5: complete (commits 9f60679..6b8b127, review clean). Implementer caught brief defect on `rows[0]!` — `pg.PoolClient.query` returns `QueryResult`, not `R[]`; fixed with `result.rows[0]!`. Behavior preserved.
Task 6: Ruling: amend migration 002 — add `delivered_at timestamptz` to `orders` (spec §5 / Task 10's `get_order_status` both reference it; without it `listHistoryByCustomer` SELECT errors on every call). The original migration omitted this column despite the new function selecting it. Applied the ALTER to the live DB; migration file updated with `ADD COLUMN IF NOT EXISTS` for fresh installs. Second plan defect caught and fixed (same shape as Task 2's `zone_id NOT NULL` oversight).
Task 6: complete (commits 6b8b127..34cb8fd, plus pending controller-pass commit). Controller pass fixed test isolation issues — hardcoded UUIDs → `newId()`, `pool.query` → `db.query` for read, phone collisions resolved with lookup-or-insert + `DELETE FROM orders` cleanup at test start. Tests now 188 passed / 3 skipped / 191 total. Pre-existing `src/delivery/service.test.ts` failure confirmed unrelated (reproduces on clean tree) — flagged for Task 7 follow-up.
Task 7: complete (commit 7b60e05, review clean). `applyModification` + `getCurrentItems` implemented with row lock (FOR UPDATE), server-side revalidation, audit row, and event log. Ownership mismatch → `ToolError('order_not_found', ...)` to never leak existence. Test isolation uses distinct phones + per-customer wipe + `is_available` restore so the unavailable-item test doesn't leak across suites. 6/6 new tests pass; full suite 194 passed / 3 skipped / 197 total. Implementer diverged from plan's literal `existing[0]` (QueryResult bug — used `.rows[0]`) and that matches the brief's correctness note, so OK. Pre-existing `delivery/service.test.ts` setup failure persists — not introduced here.
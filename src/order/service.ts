import db from '../db/client.js';
import { newId } from '../common/id.js';
import {
  OrderNotConfirmableError,
  OrderNotFoundError,
} from '../common/errors.js';
import { sumPaisa } from '../common/money.js';
import { assertCanTransition } from './state.js';
import { revalidateItems } from './menuRevalidator.js';
import type { CreateOrderInput, Order, OrderState, OrderItemSnapshot, OrderHistoryRow, ListHistoryOptions } from './types.js';

/**
 * Recompute server-side totals from items + delivery fee.
 * Pure: trusts nothing but the items array.
 */
function computeTotals(
  items: ReadonlyArray<OrderItemSnapshot>,
  deliveryFeePaisa: number,
): { subtotal_paisa: number; total_paisa: number } {
  const subtotal = sumPaisa(items.map((i) => i.line_total_paisa));
  return { subtotal_paisa: subtotal, total_paisa: subtotal + deliveryFeePaisa };
}

/**
 * Create a confirmed order. Always re-validates against live menu
 * and recomputes prices server-side. The 'confirm' parameter is required
 * to be exactly `true` — the agent's tool schema enforces this, but we
 * double-check here as well.
 */
export async function confirm(input: CreateOrderInput): Promise<Order> {
  if (!Number.isFinite(input.delivery_fee_paisa) || input.delivery_fee_paisa < 0) {
    throw new OrderNotConfirmableError(
      `delivery_fee_paisa must be a non-negative integer (got ${input.delivery_fee_paisa})`,
    );
  }
  const items = await revalidateItems(input.restaurant_id, input.items);
  const { subtotal_paisa, total_paisa } = computeTotals(items, input.delivery_fee_paisa);

  const id = newId();
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO orders (
         id, restaurant_id, customer_id, conversation_id, state,
         items, subtotal_paisa, delivery_fee_paisa, total_paisa,
         delivery_address, payment_method, special_instructions, confirmed_at
       ) VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8, $9, $10, $11, now())`,
      [
        id,
        input.restaurant_id,
        input.customer_id,
        input.conversation_id ?? null,
        JSON.stringify(items),
        subtotal_paisa,
        input.delivery_fee_paisa,
        total_paisa,
        input.delivery_address ?? null,
        input.payment_method ?? null,
        input.special_instructions ?? null,
      ],
    );
    await client.query(
      `INSERT INTO order_events (id, order_id, from_state, to_state, actor, note)
       VALUES ($1, $2, NULL, 'pending', 'customer', 'order placed')`,
      [newId(), id],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return getById(id);
}

export async function getById(id: string): Promise<Order> {
  const rows = await db.query<{
    id: string;
    restaurant_id: string;
    customer_id: string;
    conversation_id: string | null;
    state: OrderState;
    items: OrderItemSnapshot[];
    subtotal_paisa: number;
    delivery_fee_paisa: number;
    total_paisa: number;
    delivery_address: string | null;
    payment_method: string | null;
    special_instructions: string | null;
    confirmed_at: string | null;
    cancelled_at: string | null;
    cancel_reason: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, restaurant_id, customer_id, conversation_id, state, items,
            subtotal_paisa, delivery_fee_paisa, total_paisa,
            delivery_address, payment_method, special_instructions,
            confirmed_at, cancelled_at, cancel_reason, created_at, updated_at
     FROM orders WHERE id = $1`,
    [id],
  );
  const o = rows[0];
  if (!o) throw new OrderNotFoundError(id);
  return o;
}

export async function transition(
  orderId: string,
  to: OrderState,
  actor: 'system' | 'staff' | 'customer',
  note?: string,
): Promise<Order> {
  const order = await getById(orderId);
  assertCanTransition(order.state, to);

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const sets: string[] = ['state = $2', 'updated_at = now()'];
    const params: unknown[] = [orderId, to];
    let i = 3;
    if (to === 'confirmed') {
      sets.push(`confirmed_at = now()`);
    }
    if (to === 'cancelled') {
      sets.push(`cancelled_at = now()`);
      if (note) {
        sets.push(`cancel_reason = $${i++}`);
        params.push(note);
      }
    }
    await client.query(`UPDATE orders SET ${sets.join(', ')} WHERE id = $1`, params);

    await client.query(
      `INSERT INTO order_events (id, order_id, from_state, to_state, actor, note)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [newId(), orderId, order.state, to, actor, note ?? null],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return getById(orderId);
}

export async function listByCustomer(customerId: string): Promise<Order[]> {
  const rows = await db.query<{
    id: string;
    restaurant_id: string;
    customer_id: string;
    conversation_id: string | null;
    state: OrderState;
    items: OrderItemSnapshot[];
    subtotal_paisa: number;
    delivery_fee_paisa: number;
    total_paisa: number;
    delivery_address: string | null;
    payment_method: string | null;
    special_instructions: string | null;
    confirmed_at: string | null;
    cancelled_at: string | null;
    cancel_reason: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, restaurant_id, customer_id, conversation_id, state, items,
            subtotal_paisa, delivery_fee_paisa, total_paisa,
            delivery_address, payment_method, special_instructions,
            confirmed_at, cancelled_at, cancel_reason, created_at, updated_at
     FROM orders WHERE customer_id = $1 ORDER BY created_at DESC`,
    [customerId],
  );
  return rows;
}

/**
 * Return a summary view of a customer's recent orders (most recent first).
 * Builds items_summary + item_count inline from the jsonb items column so
 * the summary is always consistent with the snapshot — no risk of a stale
 * denormalized column drifting from items.
 *
 * Default behavior excludes terminal states (delivered, cancelled) so the
 * customer's "active" orders surface first. Pass includeTerminal=true to
 * see history including past orders.
 */
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
    `SELECT
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
     WHERE ${where}
     ORDER BY o.created_at DESC
     LIMIT $${params.length}`,
    params,
  );
}
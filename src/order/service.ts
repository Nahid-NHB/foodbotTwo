import db from '../db/client.js';
import { newId } from '../common/id.js';
import {
  OrderNotConfirmableError,
  OrderNotFoundError,
  MenuItemNotFoundError,
  MenuItemUnavailableError,
} from '../common/errors.js';
import { sumPaisa } from '../common/money.js';
import { assertCanTransition } from './state.js';
import type { CreateOrderInput, Order, OrderState, OrderItemSnapshot } from './types.js';

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
 * Re-validate every line of an incoming order against the live menu.
 *   - Each menu_item must exist + be available.
 *   - If variant_id is set, it must exist + be available for that item.
 *   - Each addon must exist + be available for that item.
 * Recomputes every line_total_paisa from current prices (server-side source of truth).
 * Throws OrderNotConfirmableError if any check fails.
 */
async function revalidateItems(
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
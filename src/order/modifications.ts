import db from '../db/client.js';
import { newId } from '../common/id.js';
import { ToolError } from '../common/errors.js';
import { sumPaisa } from '../common/money.js';
import * as OrderService from './service.js';
import { revalidateItems } from './menuRevalidator.js';
import type {
  ApplyModificationInput,
  ApplyModificationResult,
  OrderItemSnapshot,
} from './types.js';

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
    const existing = orderRows.rows[0];
    if (!existing || existing.customer_id !== input.customerId) {
      // never leak existence
      throw new ToolError(
        'order_not_found',
        'অর্ডার খুঁজে পাওয়া যায়নি।',
        `order ${input.orderId} not found`,
      );
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
      [
        modId,
        input.orderId,
        JSON.stringify(existing.items),
        JSON.stringify(revalidated),
        existing.total_paisa,
        newTotal,
      ],
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
export async function getCurrentItems(
  orderId: string,
  customerId: string,
): Promise<OrderItemSnapshot[]> {
  const order = await OrderService.getById(orderId);
  if (order.customer_id !== customerId) {
    throw new ToolError(
      'order_not_found',
      'অর্ডার খুঁজে পাওয়া যায়নি।',
      `order ${orderId} not owned by ${customerId}`,
    );
  }
  return order.items;
}

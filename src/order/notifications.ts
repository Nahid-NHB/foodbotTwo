import db from '../db/client.js';
import { newId } from '../common/id.js';
import { sendQueue } from '../queue/index.js';
import { logger } from '../logger.js';
import {
  NOTIFICATION_TEMPLATES,
  type Order,
  type OrderState,
  type OrderStatusNotification,
} from './types.js';

/**
 * Render the Bangla template for a state with the order context.
 * Returns null if no template exists for the toState (e.g. 'pending' — we
 * don't notify the customer when the order is first placed; the agent's
 * reply is enough).
 */
export function renderTemplate(
  toState: OrderState,
  order: Pick<Order, 'id'>,
  note?: string,
): string | null {
  const tpl = NOTIFICATION_TEMPLATES.find((t) => t.to_state === toState);
  if (!tpl) return null;
  const short = order.id.slice(0, 8);
  return tpl.bn
    .replace('#{order_id_short}', short)
    .replace('{order_id_short}', short)
    .replace('{note}', note ?? '—');
}

/**
 * Record the notification row (idempotent on (order_id, to_state)) and, if a
 * new row was inserted, enqueue a WhatsApp send job via sendQueue.
 *
 * Returns the notification row (inserted or pre-existing), or null if no
 * template exists for toState.
 *
 * Caller is expected to invoke this fire-and-forget (see OrderService.transition)
 * so a queue/DB hiccup doesn't block or roll back the state change.
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
     RETURNING id, order_id, to_state, wamid, sent_at, delivered_at, failed_reason`,
    [newId(), order.id, toState],
  );
  const row = ins[0];
  if (!row) {
    // Already recorded; idempotent no-op. Fetch the existing row so the
    // caller (and return value) is consistent. Do NOT re-enqueue the send
    // job — that would risk duplicate WhatsApp messages.
    const existing = await db.query<OrderStatusNotification>(
      `SELECT id, order_id, to_state, wamid, sent_at, delivered_at, failed_reason
       FROM order_status_notifications WHERE order_id = $1 AND to_state = $2`,
      [order.id, toState],
    );
    return existing[0] ?? null;
  }

  // Look up the customer's phone_e164 to address the send.
  const cust = await db.query<{ phone_e164: string }>(
    `SELECT phone_e164 FROM customers WHERE id = $1`,
    [order.customer_id],
  );
  const phone = cust[0]?.phone_e164;
  if (!phone) {
    logger.warn({ orderId: order.id }, 'notification: customer not found, skipping enqueue');
    return row;
  }

  await sendQueue.add('status', {
    to: phone,
    body,
    conversationId: order.conversation_id ?? '',
    kind: 'status',
    orderId: order.id,
    toState,
  });
  return row;
}

/**
 * Record Meta's delivery confirmation on the notification row.
 * Guarded by `AND delivered_at IS NULL` so that re-delivery webhooks
 * from Meta do not overwrite the first (real) delivery time with a later
 * one. Called from Task 9's webhook handler, not from the send worker.
 */
export async function markDelivered(
  orderId: string,
  toState: OrderState,
  when: Date,
): Promise<void> {
  await db.query(
    `UPDATE order_status_notifications
     SET delivered_at = $1
     WHERE order_id = $2 AND to_state = $3 AND delivered_at IS NULL`,
    [when.toISOString(), orderId, toState],
  );
}

/** Record a failure reason (used when sendText throws). */
export async function markFailed(
  orderId: string,
  toState: OrderState,
  reason: string,
): Promise<void> {
  await db.query(
    `UPDATE order_status_notifications
     SET failed_reason = $1
     WHERE order_id = $2 AND to_state = $3`,
    [reason, orderId, toState],
  );
}

/**
 * Capture Meta's outbound message id (wamid) on the notification row so the
 * webhook (Task 9) can correlate a later status update back to the right
 * notification. Called from the whatsapp.send worker after sendText succeeds.
 */
export async function markWamid(
  orderId: string,
  toState: OrderState,
  wamid: string,
): Promise<void> {
  await db.query(
    `UPDATE order_status_notifications
     SET wamid = $1
     WHERE order_id = $2 AND to_state = $3`,
    [wamid, orderId, toState],
  );
}
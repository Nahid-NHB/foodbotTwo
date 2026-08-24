import db from '../db/client.js';
import { redis } from '../redis/client.js';
import { newId } from '../common/id.js';
import { config } from '../config.js';
import type { CartItem } from '../cart/types.js';
import { assertCanTransitionConversation } from './state.js';
import type { Conversation, ConversationState } from './types.js';

const CART_TTL_SECONDS = 2 * 60 * 60; // 2 hours
const cartKey = (conversationId: string): string => `cart:${conversationId}`;

/**
 * Get or create a conversation for a (customer, restaurant) pair.
 * Idempotent — only creates if no conversation row exists.
 */
export async function getOrCreate(
  customerId: string,
  restaurantId: string,
): Promise<Conversation> {
  const existing = await db.query<{
    id: string;
    customer_id: string;
    restaurant_id: string;
    state: ConversationState;
    cart_snapshot: CartItem[];
    last_message_at: string;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, customer_id, restaurant_id, state, cart_snapshot, last_message_at, created_at, updated_at
     FROM conversations WHERE customer_id = $1 AND restaurant_id = $2
     LIMIT 1`,
    [customerId, restaurantId],
  );

  if (existing[0]) {
    const c = existing[0];
    const cart = await getCart(c.id);
    return {
      id: c.id,
      customer_id: c.customer_id,
      restaurant_id: c.restaurant_id,
      state: c.state,
      cart,
      last_message_at: c.last_message_at,
      created_at: c.created_at,
      updated_at: c.updated_at,
    };
  }

  const id = newId();
  await db.query(
    `INSERT INTO conversations (id, customer_id, restaurant_id, state)
     VALUES ($1, $2, $3, 'idle')`,
    [id, customerId, restaurantId],
  );
  return {
    id,
    customer_id: customerId,
    restaurant_id: restaurantId,
    state: 'idle',
    cart: [],
    last_message_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

/** Read cart from Redis. */
export async function getCart(conversationId: string): Promise<CartItem[]> {
  const raw = await redis.get(cartKey(conversationId));
  if (!raw) return [];
  try {
    return JSON.parse(raw) as CartItem[];
  } catch {
    return [];
  }
}

/**
 * Persist the cart to Redis (with TTL) and write a snapshot to Postgres
 * so we can recover if Redis loses state.
 */
export async function setCart(conversationId: string, items: ReadonlyArray<CartItem>): Promise<void> {
  await redis.set(cartKey(conversationId), JSON.stringify(items), 'EX', CART_TTL_SECONDS);
  await db.query(
    `UPDATE conversations SET cart_snapshot = $1::jsonb, updated_at = now() WHERE id = $2`,
    [JSON.stringify(items), conversationId],
  );
}

export async function clearCart(conversationId: string): Promise<void> {
  await redis.del(cartKey(conversationId));
  await db.query(
    `UPDATE conversations SET cart_snapshot = '[]'::jsonb, updated_at = now() WHERE id = $1`,
    [conversationId],
  );
}

export async function transitionTo(
  conversationId: string,
  to: ConversationState,
): Promise<void> {
  const rows = await db.query<{ state: ConversationState }>(
    `SELECT state FROM conversations WHERE id = $1`,
    [conversationId],
  );
  const current = rows[0];
  if (!current) throw new Error(`conversation not found: ${conversationId}`);
  assertCanTransitionConversation(current.state, to);

  await db.query(
    `UPDATE conversations SET state = $1, last_message_at = now(), updated_at = now() WHERE id = $2`,
    [to, conversationId],
  );
}

export async function touchLastMessage(conversationId: string): Promise<void> {
  await db.query(
    `UPDATE conversations SET last_message_at = now() WHERE id = $1`,
    [conversationId],
  );
}

export async function getById(conversationId: string): Promise<Conversation | null> {
  const rows = await db.query<{
    id: string;
    customer_id: string;
    restaurant_id: string;
    state: ConversationState;
    cart_snapshot: CartItem[];
    last_message_at: string;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, customer_id, restaurant_id, state, cart_snapshot, last_message_at, created_at, updated_at
     FROM conversations WHERE id = $1`,
    [conversationId],
  );
  const c = rows[0];
  if (!c) return null;
  const cart = await getCart(c.id);
  if (cart.length === 0 && c.cart_snapshot.length > 0) {
    // Redis cache miss but DB snapshot exists — restore from snapshot.
    await setCart(c.id, c.cart_snapshot);
    return { ...c, cart: c.cart_snapshot };
  }
  return { ...c, cart };
}

export function _configForTest(): { ttlSeconds: number; restaurantName: string } {
  return { ttlSeconds: CART_TTL_SECONDS, restaurantName: config.RESTAURANT_NAME };
}
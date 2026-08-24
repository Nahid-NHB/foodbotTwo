import db from '../db/client.js';
import { MenuItemNotFoundError, MenuItemUnavailableError, CartEmptyError } from '../common/errors.js';
import { sumPaisa } from '../common/money.js';
import { checkAvailability } from '../menu/service.js';
import type { Cart, CartItem, AddToCartInput, UpdateCartItemInput } from './types.js';

/**
 * Compare two cart "lines" by their identity (item + variant). Used to merge
 * identical add_to_cart calls so two "2 ta chicken burger" don't end up as
 * two separate lines.
 */
function lineKey(item: { menu_item_id: string; variant_id?: string; addon_ids: string[] }): string {
  const variant = item.variant_id ?? '';
  const addons = [...(item.addon_ids ?? [])].sort().join(',');
  return `${item.menu_item_id}|${variant}|${addons}`;
}

/**
 * Compute cart totals from current items + delivery fee.
 * Pure: no I/O.
 */
export function calculateTotal(items: ReadonlyArray<CartItem>, deliveryFeePaisa: number): Cart {
  const subtotal = sumPaisa(items.map((i) => i.line_total_paisa));
  return {
    items: items.map((i) => ({ ...i })),
    subtotal_paisa: subtotal,
    delivery_fee_paisa: deliveryFeePaisa,
    total_paisa: subtotal + deliveryFeePaisa,
  };
}

/**
 * Re-fetch an item, its variant, and add-ons, then build a snapshot CartItem
 * with the current menu price. The snapshot is the source of truth in DB;
 * later menu price changes won't affect existing cart lines.
 */
async function buildSnapshotLine(
  restaurantId: string,
  input: AddToCartInput,
): Promise<CartItem> {
  if (input.quantity <= 0) {
    throw new RangeError(`quantity must be > 0, got ${input.quantity}`);
  }

  const avail = await checkAvailability(restaurantId, input.menu_item_id, {
    variantId: input.variant_id,
    addonIds: input.addon_ids,
  });
  if (!avail.available) {
    throw new MenuItemUnavailableError(input.menu_item_id);
  }

  const rows = await db.query<{
    name: string;
    price_paisa: number;
  }>(
    `SELECT name, price_paisa FROM menu_items WHERE id = $1 AND restaurant_id = $2`,
    [input.menu_item_id, restaurantId],
  );
  const item = rows[0];
  if (!item) throw new MenuItemNotFoundError(input.menu_item_id);

  let unitPrice = item.price_paisa;
  let variantName: string | undefined;
  let variantPrice: number | undefined;
  if (input.variant_id) {
    const vRows = await db.query<{ name: string; price_paisa: number }>(
      `SELECT name, price_paisa FROM menu_item_variants
       WHERE id = $1 AND menu_item_id = $2`,
      [input.variant_id, input.menu_item_id],
    );
    const variant = vRows[0];
    if (!variant) throw new MenuItemNotFoundError(`variant ${input.variant_id}`);
    unitPrice = variant.price_paisa;
    variantName = variant.name;
    variantPrice = variant.price_paisa;
  }

  let addons: { id: string; name: string; price_paisa: number }[] = [];
  if (input.addon_ids && input.addon_ids.length > 0) {
    const aRows = await db.query<{ id: string; name: string; price_paisa: number }>(
      `SELECT id, name, price_paisa FROM menu_item_addons
       WHERE menu_item_id = $1 AND id = ANY($2::uuid[])`,
      [input.menu_item_id, input.addon_ids],
    );
    addons = aRows;
  }
  const addonsTotal = sumPaisa(addons.map((a) => a.price_paisa));
  const unitTotal = unitPrice + addonsTotal;
  const lineTotal = unitTotal * input.quantity;

  const line: CartItem = {
    menu_item_id: input.menu_item_id,
    name: item.name,
    quantity: input.quantity,
    unit_price_paisa: unitTotal,
    addon_ids: input.addon_ids ?? [],
    addons,
    line_total_paisa: lineTotal,
  };
  if (variantName !== undefined) {
    line.variant_name = variantName;
  }
  if (variantPrice !== undefined) {
    line.variant_price_paisa = variantPrice;
  }
  if (input.variant_id) {
    line.variant_id = input.variant_id;
  }
  return line;
}

/**
 * Mutate a cart: add an item, merging with an existing line if identical.
 */
export function addItem(items: ReadonlyArray<CartItem>, newLine: CartItem): CartItem[] {
  const key = lineKey(newLine);
  const idx = items.findIndex((i) => lineKey(i) === key);
  if (idx === -1) {
    return [...items, newLine];
  }
  const existing = items[idx]!;
  const merged: CartItem = {
    ...existing,
    quantity: existing.quantity + newLine.quantity,
    line_total_paisa: existing.unit_price_paisa * (existing.quantity + newLine.quantity),
  };
  return [...items.slice(0, idx), merged, ...items.slice(idx + 1)];
}

/**
 * Mutate a cart: change quantity of an existing item by menu_item_id (+ optional variant).
 */
export function updateQuantity(
  items: ReadonlyArray<CartItem>,
  input: UpdateCartItemInput,
): CartItem[] {
  if (input.quantity <= 0) {
    return items.filter((i) => !(i.menu_item_id === input.menu_item_id && i.variant_id === input.variant_id));
  }
  return items.map((i) => {
    if (i.menu_item_id === input.menu_item_id && i.variant_id === input.variant_id) {
      return {
        ...i,
        quantity: input.quantity,
        line_total_paisa: i.unit_price_paisa * input.quantity,
      };
    }
    return i;
  });
}

/**
 * Mutate a cart: remove all lines for a given menu_item_id (and optional variant).
 */
export function removeItem(
  items: ReadonlyArray<CartItem>,
  menuItemId: string,
  variantId?: string,
): CartItem[] {
  return items.filter((i) => !(i.menu_item_id === menuItemId && i.variant_id === variantId));
}

export function clearCart(): CartItem[] {
  return [];
}

/** Helper: re-derive totals and produce a Cart snapshot. */
export function snapshot(items: ReadonlyArray<CartItem>, deliveryFeePaisa: number): Cart {
  return calculateTotal(items, deliveryFeePaisa);
}

/** Assert cart is non-empty. Throws CartEmptyError otherwise. */
export function assertNonEmpty(items: ReadonlyArray<CartItem>): void {
  if (items.length === 0) throw new CartEmptyError();
}

export const __test = {
  lineKey,
  buildSnapshotLine,
};
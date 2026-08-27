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

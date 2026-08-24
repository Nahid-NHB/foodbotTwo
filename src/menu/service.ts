import db from '../db/client.js';
import { MenuItemNotFoundError, MenuItemUnavailableError } from '../common/errors.js';
import type {
  MenuItem,
  MenuItemDetails,
  MenuSearchResult,
  AvailabilityResult,
} from './types.js';

const SELECT_ITEM = `
  SELECT id, restaurant_id, category_id, name, description, price_paisa, is_available, search_text
  FROM menu_items
`;

/**
 * Trigram search across search_text + name. Falls back to listing all available
 * items if query is empty/undefined.
 *
 * The % operator uses pg_trgm similarity; ORDER BY similarity puts best match first.
 */
export async function searchMenu(
  restaurantId: string,
  query?: string,
  limit = 10,
): Promise<MenuSearchResult[]> {
  const q = (query ?? '').trim();
  if (!q) {
    const rows = await db.query<{
      id: string;
      name: string;
      price_paisa: number;
      category_name: string | null;
      is_available: boolean;
    }>(
      `SELECT mi.id, mi.name, mi.price_paisa, c.name AS category_name, mi.is_available
       FROM menu_items mi
       LEFT JOIN categories c ON c.id = mi.category_id
       WHERE mi.restaurant_id = $1 AND mi.is_available = true
       ORDER BY c.sort_order, mi.name
       LIMIT $2`,
      [restaurantId, limit],
    );
    return rows.map((r) => ({ ...r, score: 1.0 }));
  }

  const pattern = `%${q.toLowerCase()}%`;
  const rows = await db.query<{
    id: string;
    name: string;
    price_paisa: number;
    category_name: string | null;
    is_available: boolean;
    score: number;
  }>(
    `SELECT mi.id, mi.name, mi.price_paisa, c.name AS category_name, mi.is_available,
            similarity(mi.search_text, $2) AS score
     FROM menu_items mi
     LEFT JOIN categories c ON c.id = mi.category_id
     WHERE mi.restaurant_id = $1
       AND (mi.search_text ILIKE $3 OR similarity(mi.search_text, $2) > 0.2)
     ORDER BY score DESC, mi.name
     LIMIT $4`,
    [restaurantId, q, pattern, limit],
  );
  return rows;
}

export async function getItemDetails(
  restaurantId: string,
  itemId: string,
): Promise<MenuItemDetails> {
  const rows = await db.query<MenuItem & { category_name: string | null }>(
    `${SELECT_ITEM}
     JOIN LATERAL (
       SELECT c.name AS category_name FROM categories c WHERE c.id = menu_items.category_id
     ) cat ON true
     WHERE menu_items.id = $1 AND menu_items.restaurant_id = $2`,
    [itemId, restaurantId],
  );
  const row = rows[0];
  if (!row) throw new MenuItemNotFoundError(itemId);

  const variants = await db.query<{
    id: string;
    menu_item_id: string;
    name: string;
    price_paisa: number;
    is_available: boolean;
  }>(
    `SELECT id, menu_item_id, name, price_paisa, is_available
     FROM menu_item_variants
     WHERE menu_item_id = $1
     ORDER BY sort_order, name`,
    [itemId],
  );
  const addons = await db.query<{
    id: string;
    menu_item_id: string;
    name: string;
    price_paisa: number;
    is_available: boolean;
  }>(
    `SELECT id, menu_item_id, name, price_paisa, is_available
     FROM menu_item_addons
     WHERE menu_item_id = $1
     ORDER BY name`,
    [itemId],
  );

  return { ...row, variants, addons };
}

export async function checkAvailability(
  restaurantId: string,
  itemId: string,
  opts: { variantId?: string; addonIds?: string[] } = {},
): Promise<AvailabilityResult> {
  const itemRows = await db.query<{ id: string; name: string; is_available: boolean }>(
    `SELECT id, name, is_available FROM menu_items WHERE id = $1 AND restaurant_id = $2`,
    [itemId, restaurantId],
  );
  const item = itemRows[0];
  if (!item) return { available: false, reason: 'item_not_found' };
  if (!item.is_available) return { available: false, reason: 'item_unavailable' };

  if (opts.variantId) {
    const vRows = await db.query<{ is_available: boolean }>(
      `SELECT is_available FROM menu_item_variants WHERE id = $1 AND menu_item_id = $2`,
      [opts.variantId, itemId],
    );
    const v = vRows[0];
    if (!v) return { available: false, reason: 'variant_not_found' };
    if (!v.is_available) return { available: false, reason: 'variant_unavailable' };
  }

  if (opts.addonIds && opts.addonIds.length > 0) {
    const aRows = await db.query<{ id: string; is_available: boolean }>(
      `SELECT id, is_available FROM menu_item_addons WHERE menu_item_id = $1 AND id = ANY($2::uuid[])`,
      [itemId, opts.addonIds],
    );
    if (aRows.length !== opts.addonIds.length) {
      return { available: false, reason: 'addon_not_found' };
    }
    for (const a of aRows) {
      if (!a.is_available) return { available: false, reason: 'addon_unavailable' };
    }
  }

  return { available: true };
}

/**
 * Convenience: read an item's current price (server-side source of truth).
 * Throws MenuItemNotFoundError if missing, MenuItemUnavailableError if disabled.
 */
export async function requireItemPrice(
  restaurantId: string,
  itemId: string,
): Promise<{ name: string; price_paisa: number }> {
  const rows = await db.query<{ name: string; price_paisa: number; is_available: boolean }>(
    `SELECT name, price_paisa, is_available FROM menu_items
     WHERE id = $1 AND restaurant_id = $2`,
    [itemId, restaurantId],
  );
  const row = rows[0];
  if (!row) throw new MenuItemNotFoundError(itemId);
  if (!row.is_available) throw new MenuItemUnavailableError(row.name);
  return { name: row.name, price_paisa: row.price_paisa };
}

export async function listRestaurantItems(restaurantId: string): Promise<MenuItem[]> {
  const rows = await db.query<MenuItem>(
    `${SELECT_ITEM} WHERE restaurant_id = $1 ORDER BY name`,
    [restaurantId],
  );
  return rows;
}
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { pool, closeDb } from './client.js';
import { logger } from '../logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MENU_FILE = join(__dirname, '..', '..', 'data', 'menu.json');
const IDS_FILE = join(__dirname, '..', '..', 'data', 'menu-ids.json');

// ---------- schemas ----------

const VariantSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  price_paisa: z.number().int().nonnegative(),
});

const AddonSchema = z.object({
  key: z.string().min(1),
  item_key: z.string().min(1),
  name: z.string().min(1),
  price_paisa: z.number().int().nonnegative(),
  aliases: z.array(z.string()).default([]),
});

const ItemSchema = z.object({
  key: z.string().min(1),
  category_key: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  price_paisa: z.number().int().nonnegative(),
  aliases: z.array(z.string()).default([]),
  variants: z.array(VariantSchema).default([]),
});

const CategorySchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  sort_order: z.number().int().default(0),
});

const RestaurantSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  whatsapp_phone_number_id: z.string().min(1),
  whatsapp_business_account_id: z.string().min(1),
});

const MenuSchema = z.object({
  restaurant: RestaurantSchema,
  categories: z.array(CategorySchema),
  items: z.array(ItemSchema),
  addons: z.array(AddonSchema).default([]),
});

export type Menu = z.infer<typeof MenuSchema>;

// ---------- id management ----------

type IdMap = {
  restaurant: Record<string, string>;
  category: Record<string, string>;
  item: Record<string, string>;
  variant: Record<string, string>;
  addon: Record<string, string>;
};

function emptyIdMap(): IdMap {
  return { restaurant: {}, category: {}, item: {}, variant: {}, addon: {} };
}

function loadOrCreateIdMap(): IdMap {
  if (!existsSync(IDS_FILE)) return emptyIdMap();
  try {
    return JSON.parse(readFileSync(IDS_FILE, 'utf8')) as IdMap;
  } catch {
    return emptyIdMap();
  }
}

function saveIdMap(ids: IdMap): void {
  writeFileSync(IDS_FILE, JSON.stringify(ids, null, 2));
}

function getOrCreateId(
  bucket: Record<string, string>,
  key: string,
  ids: IdMap,
  bucketName: keyof IdMap,
): string {
  if (bucket[key]) return bucket[key];
  const id = randomUUID();
  bucket[key] = id;
  ids[bucketName] = bucket;
  return id;
}

function buildSearchText(name: string, aliases: string[]): string {
  return [name, ...aliases].map((s) => s.toLowerCase()).join(' ');
}

// ---------- main ----------

export async function seed(): Promise<void> {
  const raw = readFileSync(MENU_FILE, 'utf8');
  const menu = MenuSchema.parse(JSON.parse(raw));

  const ids = loadOrCreateIdMap();

  const restaurantId = getOrCreateId(ids.restaurant, menu.restaurant.key, ids, 'restaurant');

  // Resolve category ids up front
  for (const c of menu.categories) {
    getOrCreateId(ids.category, c.key, ids, 'category');
  }
  for (const item of menu.items) {
    getOrCreateId(ids.item, item.key, ids, 'item');
    for (const v of item.variants) {
      getOrCreateId(ids.variant, `${item.key}:${v.key}`, ids, 'variant');
    }
  }
  for (const a of menu.addons) {
    getOrCreateId(ids.addon, a.key, ids, 'addon');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO restaurants (id, name, whatsapp_phone_number_id, whatsapp_business_account_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         whatsapp_phone_number_id = EXCLUDED.whatsapp_phone_number_id,
         whatsapp_business_account_id = EXCLUDED.whatsapp_business_account_id,
         updated_at = now()`,
      [
        restaurantId,
        menu.restaurant.name,
        menu.restaurant.whatsapp_phone_number_id,
        menu.restaurant.whatsapp_business_account_id,
      ],
    );

    for (const c of menu.categories) {
      const id = ids.category[c.key]!;
      await client.query(
        `INSERT INTO categories (id, restaurant_id, name, sort_order)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           sort_order = EXCLUDED.sort_order,
           updated_at = now()`,
        [id, restaurantId, c.name, c.sort_order],
      );
    }

    for (const item of menu.items) {
      const id = ids.item[item.key]!;
      const categoryId = ids.category[item.category_key]!;
      await client.query(
        `INSERT INTO menu_items (id, restaurant_id, category_id, name, description, price_paisa, search_text)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO UPDATE SET
           category_id = EXCLUDED.category_id,
           name = EXCLUDED.name,
           description = EXCLUDED.description,
           price_paisa = EXCLUDED.price_paisa,
           search_text = EXCLUDED.search_text,
           updated_at = now()`,
        [
          id,
          restaurantId,
          categoryId,
          item.name,
          item.description ?? null,
          item.price_paisa,
          buildSearchText(item.name, item.aliases),
        ],
      );

      for (let vi = 0; vi < item.variants.length; vi++) {
        const v = item.variants[vi]!;
        const variantId = ids.variant[`${item.key}:${v.key}`]!;
        await client.query(
          `INSERT INTO menu_item_variants (id, menu_item_id, name, price_paisa, sort_order)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (id) DO UPDATE SET
             name = EXCLUDED.name,
             price_paisa = EXCLUDED.price_paisa,
             updated_at = now()`,
          [variantId, id, v.name, v.price_paisa, vi],
        );
      }
    }

    for (const a of menu.addons) {
      const id = ids.addon[a.key]!;
      const itemId = ids.item[a.item_key]!;
      if (!itemId) throw new Error(`addon ${a.key} references unknown item ${a.item_key}`);
      await client.query(
        `INSERT INTO menu_item_addons (id, menu_item_id, name, price_paisa)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           price_paisa = EXCLUDED.price_paisa,
           updated_at = now()`,
        [id, itemId, a.name, a.price_paisa],
      );
    }

    await client.query('COMMIT');
    saveIdMap(ids);
    logger.info(
      {
        restaurant: menu.restaurant.name,
        categories: menu.categories.length,
        items: menu.items.length,
        addons: menu.addons.length,
      },
      'seed complete',
    );
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  seed()
    .then(() => closeDb())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.fatal({ err }, 'seed failed');
      process.exit(1);
    });
}

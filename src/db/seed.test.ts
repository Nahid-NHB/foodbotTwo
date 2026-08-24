import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(readFileSync(join(here, '..', '..', 'data', 'menu.json'), 'utf8'));

describe('seed loader (offline)', () => {
  it('menu.json has a restaurant with required fields', () => {
    expect(raw.restaurant.key).toBe('hungry_bird');
    expect(raw.restaurant.name).toBeTruthy();
    expect(raw.restaurant.whatsapp_phone_number_id).toBeTruthy();
    expect(raw.restaurant.whatsapp_business_account_id).toBeTruthy();
  });

  it('every item has a category_key that exists', () => {
    const catKeys = new Set(raw.categories.map((c: { key: string }) => c.key));
    for (const it of raw.items as Array<{ category_key: string }>) {
      expect(catKeys.has(it.category_key)).toBe(true);
    }
  });

  it('every addon references an existing item_key', () => {
    const itemKeys = new Set(raw.items.map((i: { key: string }) => i.key));
    for (const a of (raw.addons ?? []) as Array<{ item_key: string }>) {
      expect(itemKeys.has(a.item_key)).toBe(true);
    }
  });

  it('variant keys are unique within each item', () => {
    for (const it of raw.items as Array<{ variants?: Array<{ key: string }> }>) {
      const keys = (it.variants ?? []).map((v) => v.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('aliases are non-empty for items (so search_text has signal)', () => {
    for (const it of raw.items as Array<{ name: string; aliases: string[] }>) {
      // At least the name itself contributes via buildSearchText, but we want extras.
      expect(it.aliases.length).toBeGreaterThan(0);
    }
  });
});
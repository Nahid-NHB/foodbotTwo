import db from '../db/client.js';
import { newId } from '../common/id.js';
import { ToolError } from '../common/errors.js';
import type { DeliveryZone, CustomerAddress, CustomerAddressInput } from './types.js';

export async function listActiveZones(restaurantId: string): Promise<DeliveryZone[]> {
  return db.query<DeliveryZone>(
    `SELECT id, restaurant_id, name, eta_minutes, delivery_fee_paisa, is_active, created_at, updated_at
     FROM delivery_zones
     WHERE restaurant_id = $1 AND is_active = true
     ORDER BY eta_minutes ASC`,
    [restaurantId],
  );
}

export async function getZone(zoneId: string): Promise<DeliveryZone | null> {
  const rows = await db.query<DeliveryZone>(
    `SELECT id, restaurant_id, name, eta_minutes, delivery_fee_paisa, is_active, created_at, updated_at
     FROM delivery_zones WHERE id = $1 LIMIT 1`,
    [zoneId],
  );
  return rows[0] ?? null;
}

export async function getDefaultAddress(customerId: string): Promise<CustomerAddress | null> {
  // Only return structured (non-legacy) addresses. Legacy backfilled rows
  // (zone_id IS NULL) are intentionally skipped here; callers that need
  // the legacy free-text address should read customers.default_address.
  const rows = await db.query<CustomerAddress>(
    `SELECT id, customer_id, zone_id, line1, line2, note_for_rider, is_default, created_at, updated_at
     FROM customer_addresses
     WHERE customer_id = $1 AND is_default = true AND zone_id IS NOT NULL
     ORDER BY updated_at DESC LIMIT 1`,
    [customerId],
  );
  return rows[0] ?? null;
}

/**
 * Save a new structured address for a customer. Flips any prior default to
 * false in the same transaction so the new one is the unique default.
 */
export async function setAddress(
  customerId: string,
  input: CustomerAddressInput,
): Promise<CustomerAddress> {
  const zone = await getZone(input.zone_id);
  if (!zone) {
    throw new ToolError('zone_not_found', 'ডেলিভারি এলাকা খুঁজে পাওয়া যায়নি।', `zone ${input.zone_id} not found`);
  }

  return db.withTransaction(async (client) => {
    await client.query(
      `UPDATE customer_addresses SET is_default = false, updated_at = now()
       WHERE customer_id = $1 AND is_default = true`,
      [customerId],
    );
    const id = newId();
    const result = await client.query<CustomerAddress>(
      `INSERT INTO customer_addresses (id, customer_id, zone_id, line1, line2, note_for_rider, is_default)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       RETURNING id, customer_id, zone_id, line1, line2, note_for_rider, is_default, created_at, updated_at`,
      [id, customerId, input.zone_id, input.line1, input.line2 ?? null, input.note_for_rider ?? null],
    );
    return result.rows[0]!;
  });
}
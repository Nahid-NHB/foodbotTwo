import db from '../db/client.js';
import { newId } from '../common/id.js';
import { CustomerNotFoundError } from '../common/errors.js';
import type { Customer, CustomerUpdate } from './types.js';

export async function findOrCreateByPhone(phoneE164: string): Promise<Customer> {
  const existing = await db.query<Customer>(
    `SELECT id, phone_e164, name, default_address, payment_method, created_at, updated_at
     FROM customers WHERE phone_e164 = $1`,
    [phoneE164],
  );
  if (existing[0]) return existing[0];

  const id = newId();
  const rows = await db.query<Customer>(
    `INSERT INTO customers (id, phone_e164)
     VALUES ($1, $2)
     RETURNING id, phone_e164, name, default_address, payment_method, created_at, updated_at`,
    [id, phoneE164],
  );
  const created = rows[0];
  if (!created) throw new Error('customer insert failed');
  return created;
}

export async function getById(id: string): Promise<Customer> {
  const rows = await db.query<Customer>(
    `SELECT id, phone_e164, name, default_address, payment_method, created_at, updated_at
     FROM customers WHERE id = $1`,
    [id],
  );
  const c = rows[0];
  if (!c) throw new CustomerNotFoundError();
  return c;
}

export async function update(id: string, patch: CustomerUpdate): Promise<Customer> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    sets.push(`${k} = $${i++}`);
    params.push(v);
  }
  if (sets.length === 0) {
    return getById(id);
  }
  params.push(id);
  const rows = await db.query<Customer>(
    `UPDATE customers SET ${sets.join(', ')}, updated_at = now()
     WHERE id = $${i}
     RETURNING id, phone_e164, name, default_address, payment_method, created_at, updated_at`,
    params,
  );
  const c = rows[0];
  if (!c) throw new CustomerNotFoundError();
  return c;
}
import { randomUUID } from 'node:crypto';

/** Generate a new UUID v4. */
export function newId(): string {
  return randomUUID();
}

/** Normalize a Bangladeshi phone number to E.164 (+880XXXXXXXXXX). */
export function normalizePhone(raw: string): string {
  const trimmed = raw.trim().replace(/[\s-]/g, '');
  if (/^\+8801\d{9}$/.test(trimmed)) return trimmed;
  if (/^8801\d{9}$/.test(trimmed)) return `+${trimmed}`;
  if (/^01\d{9}$/.test(trimmed)) return `+880${trimmed.slice(1)}`;
  if (/^\+?\d{10,15}$/.test(trimmed)) return trimmed.startsWith('+') ? trimmed : `+${trimmed}`;
  throw new TypeError(`Cannot normalize phone: ${raw}`);
}
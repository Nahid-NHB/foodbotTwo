import { config } from '../config.js';
import { timingSafeEqual } from 'node:crypto';

/**
 * HTTP Basic auth check using timing-safe comparison.
 *
 * Returns true when the header matches ADMIN_BASIC_AUTH_USER:ADMIN_BASIC_AUTH_PASS.
 * Returns false when missing, malformed, or wrong — never throws.
 */
export function checkBasicAuth(header: string | string[] | undefined): boolean {
  if (!header || typeof header !== 'string') return false;
  if (!header.startsWith('Basic ')) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
  } catch {
    return false;
  }
  const colon = decoded.indexOf(':');
  if (colon === -1) return false;
  const user = decoded.slice(0, colon);
  const pass = decoded.slice(colon + 1);

  // timingSafeEqual requires equal-length buffers. We compare against the
  // expected length to avoid leaking length info; length-mismatch itself is
  // not sensitive.
  const expectedUser = config.ADMIN_BASIC_AUTH_USER;
  const expectedPass = config.ADMIN_BASIC_AUTH_PASS;
  const a = Buffer.from(`${user}:${pass}`);
  const b = Buffer.from(`${expectedUser}:${expectedPass}`);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
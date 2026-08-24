import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify a Meta webhook signature.
 *
 * Header format: `sha256=<hex-hmac-sha256>`
 * The HMAC is computed over the raw request body using the app secret.
 *
 * Uses a constant-time compare to avoid timing side-channels.
 */
export function verifySignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  if (!signatureHeader) return false;
  const expectedPrefix = 'sha256=';
  if (!signatureHeader.startsWith(expectedPrefix)) return false;
  const provided = signatureHeader.slice(expectedPrefix.length);
  const computed = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  if (provided.length !== computed.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(computed, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Generate the expected signature header for a given body. Useful for tests.
 */
export function sign(rawBody: Buffer, appSecret: string): string {
  const hex = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  return `sha256=${hex}`;
}
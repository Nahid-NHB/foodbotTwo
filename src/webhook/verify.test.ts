import { describe, it, expect } from 'vitest';
import { verifySignature, sign } from './verify.js';

describe('webhook signature', () => {
  const secret = 'shhh';
  const body = Buffer.from(JSON.stringify({ hello: 'world' }));

  it('verifies a valid signature', () => {
    expect(verifySignature(body, sign(body, secret), secret)).toBe(true);
  });

  it('rejects when body is mutated', () => {
    const sig = sign(body, secret);
    expect(verifySignature(Buffer.concat([body, Buffer.from('x')]), sig, secret)).toBe(false);
  });

  it('rejects wrong secret', () => {
    const sig = sign(body, secret);
    expect(verifySignature(body, sig, 'different')).toBe(false);
  });

  it('rejects missing header', () => {
    expect(verifySignature(body, undefined, secret)).toBe(false);
  });

  it('rejects header without sha256= prefix', () => {
    const sig = sign(body, secret).replace('sha256=', '');
    expect(verifySignature(body, sig, secret)).toBe(false);
  });

  it('rejects malformed hex', () => {
    expect(verifySignature(body, 'sha256=not-a-hex', secret)).toBe(false);
  });
});
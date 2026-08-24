import { describe, it, expect } from 'vitest';
import { newId, normalizePhone } from './id.js';

describe('id', () => {
  it('newId returns a UUID v4', () => {
    const id = newId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it('newIds are unique', () => {
    const a = new Set([newId(), newId(), newId(), newId()]);
    expect(a.size).toBe(4);
  });
});

describe('normalizePhone', () => {
  it('passes through valid E.164', () => {
    expect(normalizePhone('+8801712345678')).toBe('+8801712345678');
  });
  it('prepends +880 to local 01XXXXXXXXX', () => {
    expect(normalizePhone('01712345678')).toBe('+8801712345678');
  });
  it('adds + to 880XXXXXXXXX', () => {
    expect(normalizePhone('8801712345678')).toBe('+8801712345678');
  });
  it('strips spaces and dashes', () => {
    expect(normalizePhone('0171 234 5678')).toBe('+8801712345678');
    expect(normalizePhone('+880-1712-345678')).toBe('+8801712345678');
  });
  it('throws on garbage', () => {
    expect(() => normalizePhone('not a phone')).toThrow(TypeError);
    expect(() => normalizePhone('+123')).toThrow(TypeError);
  });
});
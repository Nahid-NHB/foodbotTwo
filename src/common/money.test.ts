import { describe, it, expect } from 'vitest';
import { toPaisa, fromPaisa, sumPaisa, formatBDT } from './money.js';

describe('money', () => {
  describe('toPaisa', () => {
    it('converts whole BDT', () => {
      expect(toPaisa(1)).toBe(100);
      expect(toPaisa(50)).toBe(5000);
    });
    it('rounds fractional BDT to nearest paisa', () => {
      expect(toPaisa(1.5)).toBe(150);
      expect(toPaisa(1.49)).toBe(149);
      expect(toPaisa(0.01)).toBe(1);
    });
    it('rejects non-finite', () => {
      expect(() => toPaisa(NaN)).toThrow(TypeError);
      expect(() => toPaisa(Infinity)).toThrow(TypeError);
    });
  });

  describe('fromPaisa', () => {
    it('converts paisa to BDT', () => {
      expect(fromPaisa(100)).toBe(1);
      expect(fromPaisa(0)).toBe(0);
    });
    it('rejects non-integer', () => {
      expect(() => fromPaisa(1.5)).toThrow(TypeError);
    });
  });

  describe('sumPaisa', () => {
    it('sums non-negative integers', () => {
      expect(sumPaisa([100, 200, 300])).toBe(600);
      expect(sumPaisa([])).toBe(0);
    });
    it('rejects negative or non-integer values', () => {
      expect(() => sumPaisa([100, -1])).toThrow(TypeError);
      expect(() => sumPaisa([100, 1.5])).toThrow(TypeError);
    });
  });

  describe('formatBDT', () => {
    it('formats small amounts', () => {
      expect(formatBDT(0)).toBe('৳0');
      expect(formatBDT(5000)).toBe('৳50');
    });
    it('formats with Bangladeshi lakh grouping', () => {
      expect(formatBDT(123400)).toBe('৳1,234');
      expect(formatBDT(12345600)).toBe('৳1,23,456');
    });
    it('formats with decimals when needed', () => {
      expect(formatBDT(150)).toBe('৳1.50');
      expect(formatBDT(100)).toBe('৳1');
    });
    it('rejects negative or non-integer', () => {
      expect(() => formatBDT(-1)).toThrow(TypeError);
      expect(() => formatBDT(1.5)).toThrow(TypeError);
    });
  });
});
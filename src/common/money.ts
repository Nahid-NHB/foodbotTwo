/**
 * Money helpers. All internal amounts are integer PAISA (1 BDT = 100 paisa).
 * Never use floats for money.
 */

/** Convert BDT (possibly fractional) to paisa. Rounds to nearest paisa. */
export function toPaisa(bdt: number): number {
  if (!Number.isFinite(bdt)) throw new TypeError(`toPaisa: not a number: ${bdt}`);
  return Math.round(bdt * 100);
}

/** Convert paisa to BDT. */
export function fromPaisa(paisa: number): number {
  if (!Number.isInteger(paisa)) throw new TypeError(`fromPaisa: not an integer: ${paisa}`);
  return paisa / 100;
}

/** Sum a list of paisa values. */
export function sumPaisa(values: ReadonlyArray<number>): number {
  let total = 0;
  for (const v of values) {
    if (!Number.isInteger(v) || v < 0) throw new TypeError(`sumPaisa: bad value: ${v}`);
    total += v;
  }
  return total;
}

/**
 * Format paisa as Bangladeshi Taka for customer-facing text.
 * Uses the ৳ symbol and thousand separators (en locale).
 *
 *   formatBDT(0)         -> "৳0"
 *   formatBDT(5000)      -> "৳50"
 *   formatBDT(123456)    -> "৳1,234"
 *   formatBDT(12345678)  -> "৳1,23,456"  (Bangladeshi lakh grouping)
 */
export function formatBDT(paisa: number): string {
  if (!Number.isInteger(paisa) || paisa < 0) {
    throw new TypeError(`formatBDT: bad paisa: ${paisa}`);
  }
  const bdt = paisa / 100;
  // Bangladeshi numbering: lakh (2-digit) groups after the first 3.
  const fixed = bdt.toFixed(2);
  const [whole, frac = ''] = fixed.split('.');
  const wholeNum = whole ?? '0';
  let grouped = '';
  if (wholeNum.length <= 3) {
    grouped = wholeNum;
  } else {
    const last3 = wholeNum.slice(-3);
    const rest = wholeNum.slice(0, -3);
    grouped = `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
  }
  const fracPart = frac && frac !== '00' ? `.${frac}` : '';
  return `৳${grouped}${fracPart}`;
}
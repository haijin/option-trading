/**
 * Exact decimal helpers for the CSV importers. Money never goes through floating point: prices are parsed to integer
 * micro-units (1e-6) as BigInt, row P&L is computed in micro-units and rounded half away from zero to whole cents.
 */

export const MICRO = 1_000_000n;
const MICROS_PER_CENT = 10_000n;

const DECIMAL_RE = /^([+-])?(?:(\d+)(?:\.(\d*))?|\.(\d+))$/;

export type MicroParse = { ok: true; micros: bigint } | { ok: false; reason: 'format' | 'precision'; text: string };

/**
 * Parse a plain decimal literal ('12', '12.5', '.5', '-1.25') to micro-units. Thousands separators, exponents,
 * currency symbols and anything else are rejected as 'format'; digits beyond the sixth decimal place are rejected as
 * 'precision' unless they are all zeros.
 */
export function parseMicros(text: string): MicroParse {
  const m = DECIMAL_RE.exec(text);
  if (!m) return { ok: false, reason: 'format', text };
  const sign = m[1] === '-' ? -1n : 1n;
  const whole = m[2] ?? '0';
  const frac = m[3] ?? m[4] ?? '';
  const kept = frac.slice(0, 6).padEnd(6, '0');
  if (/[1-9]/.test(frac.slice(6))) return { ok: false, reason: 'precision', text };
  return { ok: true, micros: sign * (BigInt(whole) * MICRO + BigInt(kept)) };
}

/** Integer division rounding half away from zero. `den` must be positive. */
export function divRound(num: bigint, den: bigint): bigint {
  if (den <= 0n) throw new RangeError('divRound: denominator must be positive');
  const neg = num < 0n;
  const a = neg ? -num : num;
  let q = a / den;
  if ((a % den) * 2n >= den) q += 1n;
  return neg ? -q : q;
}

/** Micro-units to whole cents, half away from zero. */
export function microsToCents(micros: bigint): bigint {
  return divRound(micros, MICROS_PER_CENT);
}

export function centsToMicros(cents: bigint | number): bigint {
  return BigInt(cents) * MICROS_PER_CENT;
}

/** Micro-units as a JS number (display / interface only, never used for money arithmetic). */
export function microsToNumber(micros: bigint): number {
  return Number(micros) / 1e6;
}

/** Canonical fixed 6-decimal text, used for hashing so '1.15' and '1.150' are the same value. */
export function formatMicros(micros: bigint): string {
  const neg = micros < 0n;
  const a = neg ? -micros : micros;
  const whole = a / MICRO;
  const frac = (a % MICRO).toString().padStart(6, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

/** Whole cents as '1234.50' (always two decimals, never '-0.00'). */
export function formatCents(cents: bigint | number): string {
  const c = BigInt(cents);
  const neg = c < 0n;
  const a = neg ? -c : c;
  const whole = a / 100n;
  const frac = (a % 100n).toString().padStart(2, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

/**
 * Number from a plain decimal literal with the decimal point shifted by `shift` places (shift -2 turns percent into a
 * fraction). Done on the digit string so that '28.7' -> 0.287 exactly as if '0.287' had been typed.
 * Returns null when the text is not a plain decimal literal.
 */
export function decimalToNumber(text: string, shift = 0): number | null {
  const m = DECIMAL_RE.exec(text);
  if (!m) return null;
  const whole = m[2] ?? '0';
  const frac = m[3] ?? m[4] ?? '';
  const n = Number(`${m[1] === '-' ? '-' : ''}${whole}${frac}e${shift - frac.length}`);
  return Number.isFinite(n) ? n : null;
}

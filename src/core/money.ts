/** Exact cent arithmetic for realised P&L: BigInt micro-units, round half away from zero to the cent. */
const MICRO = 1_000_000n;

export function toMicros(x: number): bigint {
  return BigInt(Math.round(x * 1_000_000));
}

/** micro-units -> whole cents, half away from zero. */
export function microsToCents(m: bigint): bigint {
  const unit = MICRO / 100n; // micro-units per cent
  const half = unit / 2n;
  return m >= 0n ? (m + half) / unit : -((-m + half) / unit);
}

/** (credit - close) x multiplier x contracts - fees, in whole cents. Prices are per share; fees are total cents. */
export function pnlCents(
  creditPerShare: number,
  closePerShare: number,
  multiplier: number,
  contracts: number,
  feesCents: number,
): number {
  const gross = (toMicros(creditPerShare) - toMicros(closePerShare)) * BigInt(multiplier) * BigInt(contracts);
  return Number(microsToCents(gross)) - feesCents;
}

export function centsToString(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  return `${neg ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

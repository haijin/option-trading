/** An indicator output aligned 1:1 with its input; `null` marks warm-up / undefined values. */
export type Series = (number | null)[];

/** Minimal OHLC bar accepted by the bar-based estimators (extra fields such as volume or date are ignored). */
export interface Ohlc {
  open: number;
  high: number;
  low: number;
  close: number;
}

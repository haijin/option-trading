/**
 * Alert rules for an open short put (docs/06 Phase 3, docs/01 section G). Pure: the caller supplies today's date,
 * the last close, the option mark (when there is one) and the next known earnings date.
 *
 * Rules that need an option mark (profit target, stop, assignment risk) are skipped when `mark` is null, so the same
 * function serves the app's stored-data view and the daily mark job.
 */
import { diffDays, type ISODate } from './dates';

export type AlertCode =
  | 'profit50'
  | 'dte21'
  | 'stop2x'
  | 'assignment_risk'
  | 'itm'
  | 'near_strike'
  | 'earnings_before_expiry'
  | 'new_earnings_date'
  /** Portfolio-wide (not one put): the drawdown entered a de-gear tier of the governor (trade-skills T3). */
  | 'drawdown_tier';

export interface Alert {
  level: 'info' | 'warn' | 'fail';
  code: AlertCode;
  text: string;
}

export interface AlertRules {
  /** Share of the credit captured that triggers "close for profit" (0.5). */
  takeProfitPct: number;
  /** Calendar days to expiry at or below which the time exit applies (21). */
  dteExit: number;
  /** Loss as a multiple of the credit that triggers the stop (2: close when the loss reaches 2x the credit). */
  stopMultiple: number;
  /** Percent distance to the strike that counts as "near" (5). */
  nearStrikePct: number;
  /** In the money with extrinsic value below this share of the strike means early assignment is likely (0.01). */
  assignmentExtrinsicPct: number;
}

export const DEFAULT_ALERT_RULES: AlertRules = {
  takeProfitPct: 0.5,
  dteExit: 21,
  stopMultiple: 2,
  nearStrikePct: 5,
  assignmentExtrinsicPct: 0.01,
};

export interface AlertInput {
  strike: number;
  expiry: ISODate;
  /** Premium per share received. */
  openPrice: number;
  openDate: ISODate;
  today: ISODate;
  /** Last close of the underlying, or null when there is no bar. */
  spot: number | null;
  /** Option mark per share (mid), or null when no quote or model price is available. */
  mark: number | null;
  nextEarnings: { date: ISODate; knownAt: string } | null;
  rules?: Partial<AlertRules>;
}

function money(x: number): string {
  return x.toFixed(2);
}

export function evaluateAlerts(input: AlertInput): Alert[] {
  const r: AlertRules = { ...DEFAULT_ALERT_RULES, ...input.rules };
  const { strike, expiry, openPrice, today, spot, mark } = input;
  const dte = diffDays(expiry, today);
  const out: Alert[] = [];

  if (dte < 0) out.push({ level: 'fail', code: 'dte21', text: `past expiry (${expiry}): record how it ended` });
  else if (dte <= r.dteExit)
    out.push({ level: 'warn', code: 'dte21', text: `${dte} DTE: close or roll (time-exit rule)` });

  if (mark !== null && openPrice > 0 && dte >= 0) {
    const captured = (openPrice - mark) / openPrice;
    if (captured >= r.takeProfitPct)
      out.push({
        level: 'info',
        code: 'profit50',
        text: `${Math.round(captured * 100)}% of the credit captured (mark ${money(mark)} vs ${money(openPrice)} received): take profit`,
      });
    const loss = mark - openPrice;
    if (loss >= r.stopMultiple * openPrice)
      out.push({
        level: 'fail',
        code: 'stop2x',
        text: `loss ${money(loss)} per share is ${(loss / openPrice).toFixed(1)}x the credit: stop rule reached (${r.stopMultiple}x)`,
      });
  }

  if (spot !== null) {
    const distancePct = spot > 0 ? ((spot - strike) / spot) * 100 : null;
    if (spot < strike) {
      out.push({
        level: 'fail',
        code: 'itm',
        text: `in the money: last close ${spot} is below the ${strike} strike`,
      });
      if (mark !== null && dte >= 0) {
        const extrinsic = mark - (strike - spot);
        if (extrinsic < r.assignmentExtrinsicPct * strike)
          out.push({
            level: 'fail',
            code: 'assignment_risk',
            text: `assignment risk: only ${money(Math.max(extrinsic, 0))} of time value left on an in-the-money put`,
          });
      }
    } else if (distancePct !== null && distancePct <= r.nearStrikePct) {
      out.push({ level: 'warn', code: 'near_strike', text: `within ${distancePct.toFixed(1)}% of the strike` });
    }
  }

  const er = input.nextEarnings;
  if (er && er.date >= today && er.date <= expiry) {
    out.push({ level: 'warn', code: 'earnings_before_expiry', text: `results on ${er.date} fall before expiry` });
    // A date announced after the put was sold is news: the entry rules did not see it.
    if (er.knownAt.slice(0, 10) > input.openDate)
      out.push({
        level: 'warn',
        code: 'new_earnings_date',
        text: `results date ${er.date} was announced after you sold this put (${er.knownAt.slice(0, 10)})`,
      });
  }
  return out;
}

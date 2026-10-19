/**
 * Event-driven daily backtest engine (docs/05 section 2). Pure: no database, no clock, no network. Entries come from an
 * injected `EntrySource` (the live pipeline replayed as of each day, or the naive benchmark), prices come from the bars
 * and the synthetic pricer, so the same loop serves the real run, the benchmarks and the sigma-sensitivity re-runs.
 *
 * Per trading day D, in this order:
 *   1. open puts that reached expiry settle at the D close (in the money: assigned, booked at intrinsic like the app's
 *      journal does; otherwise expired worthless);
 *   2. exits triggered on an earlier close are filled at the D close (no same-bar fills);
 *   3. the remaining puts are marked and tested against the rules in this order: stop loss, take profit, time exit;
 *      a triggered rule is filled at the NEXT close;
 *   4. on scan days, the source proposes entries; they are opened at the D close, cash-secured (full notional locked);
 *   5. equity, deployed share and the benchmark inputs are recorded.
 *
 * Cash earns `cashRate` every calendar day (collateral sits in T-bills, as in the Cboe PUT methodology). Shadow trades
 * (observe mode) are tracked like real ones but never touch cash, so attribution can compare rule-passing and
 * rule-failing entries without distorting the portfolio.
 */
import type { Market } from '../core/calendar';
import { diffDays, type ISODate } from '../core/dates';
import type { Currency, DailyBar, DataTier } from '../core/types';
import { realizedVol } from '../indicators/volatility';
import type { EquityPoint, TradeRecord } from './metrics';
import { americanPutPrice, entryCredit, exitDebit, type Haircuts } from './pricer';

export interface Underlying {
  instrumentId: number;
  symbol: string;
  market: Market;
  currency: Currency;
  sector: string | null;
  multiplier: number;
  /** Ascending by day. `close` is the raw close (strikes), `adjClose` carries returns and realised vol. */
  bars: Pick<DailyBar, 'day' | 'close' | 'adjClose' | 'low'>[];
  /** Continuous dividend yield used in pricing (0 when unknown). */
  divYield: number;
}

export interface OpenLeg {
  instrumentId: number;
  symbol: string;
  market: Market;
  sector: string | null;
  currency: Currency;
  strike: number;
  multiplier: number;
  quantity: number;
  expiry: ISODate;
}

/** What the source may know about the portfolio on the scan day. */
export interface EngineView {
  day: ISODate;
  equity: number;
  openPositions: OpenLeg[];
  fxToBase(ccy: Currency): number;
}

export interface EntryCandidate {
  instrumentId: number;
  strike: number;
  expiry: ISODate;
  /** Per-share credit the source expects (bid, or the haircut model price for synthetic). */
  fillPrice: number;
  delta: number | null;
  /** Skew-adjusted vol the price was computed with (synthetic tier). */
  iv: number | null;
  contracts: number;
  /** Ranking score (higher first); the source returns candidates best-first. */
  score: number;
  tier: DataTier;
  /** Observe mode: tracked for attribution, never funded. */
  shadow?: boolean;
  /** Rule id -> passed at entry (feeds the per-rule attribution). */
  rules?: Record<string, boolean>;
}

export interface EntrySource {
  candidates(day: ISODate, view: EngineView): Promise<EntryCandidate[]>;
}

export interface EngineConfig {
  from: ISODate;
  to: ISODate;
  /** Starting capital in the base currency. */
  initialCapital: number;
  fxToBase(ccy: Currency, day: ISODate): number;
  riskFree: Record<Market, number>;
  /** Annual rate earned by cash (decimal). */
  cashRate: number;
  takeProfitPct: number;
  dteExit: number;
  /** Close when the loss reaches this multiple of the credit. */
  stopMultiple: number;
  haircuts: Record<Market, Haircuts>;
  /** Fee per contract per side, in the instrument's currency. */
  feePerContract: Record<Market, number>;
  /** Trading days between scans (5 = weekly). */
  scanEveryDays: number;
  maxOpen: number;
  tierPolicy: 'real_only' | 'real_then_synthetic' | 'synthetic_only';
  /** Multiplies the model volatility of synthetic entries and all marks (1 = as modelled). */
  sigmaMultiplier: number;
  /** A stored real quote for a held contract on a day, per share, or null. */
  quoteMid?(instrumentId: number, strike: number, expiry: ISODate, day: ISODate): number | null;
  onDay?(day: ISODate, index: number, total: number): void;
}

export interface EngineTrade extends TradeRecord {
  symbol: string;
  currency: Currency;
  market: Market;
  expiry: ISODate;
  strike: number;
  multiplier: number;
  contracts: number;
  entryCredit: number;
  entryUnderlying: number;
  entryIv: number | null;
  exitDebit: number;
  exitUnderlying: number;
  shadow: boolean;
}

export type ExitReason = 'take_profit' | 'dte_exit' | 'stop_loss' | 'expired_otm' | 'assigned' | 'end_of_test';

export interface EngineResult {
  trades: EngineTrade[];
  equity: EquityPoint[];
  /** Entries a source proposed that were not taken, by reason (a diagnostic, not a result). */
  skipped: Record<string, number>;
  scanDays: number;
}

interface Held {
  u: Underlying;
  strike: number;
  expiry: ISODate;
  contracts: number;
  entryDate: ISODate;
  entryCredit: number;
  entryUnderlying: number;
  entryIv: number | null;
  entryDelta: number | null;
  /** sigma(D) = realised vol(D) x scale. */
  sigmaScale: number;
  fallbackSigma: number;
  tier: DataTier;
  shadow: boolean;
  rules?: Record<string, boolean>;
  collateralBase: number;
  feesEntry: number;
  fxEntry: number;
  lastMid: number;
  mae: number;
  pending: ExitReason | null;
}

const MIN_SIGMA = 0.05;
const MAX_SIGMA = 3;

function dayIndex(bars: Underlying['bars']): Map<string, number> {
  return new Map(bars.map((b, i) => [b.day, i]));
}

export async function runEngine(
  cfg: EngineConfig,
  underlyings: readonly Underlying[],
  source: EntrySource,
): Promise<EngineResult> {
  const byId = new Map(underlyings.map((u) => [u.instrumentId, u]));
  const idx = new Map(underlyings.map((u) => [u.instrumentId, dayIndex(u.bars)]));
  const rv = new Map(
    underlyings.map((u) => [
      u.instrumentId,
      realizedVol(
        u.bars.map((b) => b.adjClose),
        30,
      ),
    ]),
  );
  const days = [...new Set(underlyings.flatMap((u) => u.bars.map((b) => b.day)))]
    .filter((d) => d >= cfg.from && d <= cfg.to)
    .sort();

  const held: Held[] = [];
  const trades: EngineTrade[] = [];
  const equityCurve: EquityPoint[] = [];
  const skipped: Record<string, number> = {};
  const skip = (why: string): void => {
    skipped[why] = (skipped[why] ?? 0) + 1;
  };
  let cash = cfg.initialCapital;
  let lastDay: ISODate | null = null;
  let scanDays = 0;

  const spotOn = (u: Underlying, day: ISODate): { close: number; i: number } | null => {
    const i = idx.get(u.instrumentId)?.get(day);
    return i === undefined ? null : { close: (u.bars[i] as { close: number }).close, i };
  };

  const midOf = (h: Held, spot: number, i: number, day: ISODate): number => {
    const q = cfg.quoteMid?.(h.u.instrumentId, h.strike, h.expiry, day) ?? null;
    if (q !== null && q >= 0) return q;
    const dte = diffDays(h.expiry, day);
    const vol = rv.get(h.u.instrumentId)?.[i] ?? null;
    const sigma = Math.min(MAX_SIGMA, Math.max(MIN_SIGMA, vol !== null ? vol * h.sigmaScale : h.fallbackSigma));
    return americanPutPrice({ spot, strike: h.strike, dte, rate: cfg.riskFree[h.u.market], q: h.u.divYield }, sigma);
  };

  const close = (h: Held, day: ISODate, spot: number, debitPerShare: number, reason: ExitReason): void => {
    const fxExit = cfg.fxToBase(h.u.currency, day);
    const size = h.u.multiplier * h.contracts;
    const feesExit = cfg.feePerContract[h.u.market] * h.contracts;
    const pnlBase = (h.entryCredit * h.fxEntry - debitPerShare * fxExit) * size - (h.feesEntry + feesExit * fxExit);
    if (!h.shadow) cash -= debitPerShare * size * fxExit + feesExit * fxExit;
    const daysHeld = Math.max(1, diffDays(day, h.entryDate));
    const roc = h.collateralBase > 0 ? pnlBase / h.collateralBase : 0;
    trades.push({
      instrumentId: h.u.instrumentId,
      symbol: h.u.symbol,
      currency: h.u.currency,
      market: h.u.market,
      entryDate: h.entryDate,
      exitDate: day,
      expiry: h.expiry,
      strike: h.strike,
      multiplier: h.u.multiplier,
      contracts: h.contracts,
      entryCredit: h.entryCredit,
      entryUnderlying: h.entryUnderlying,
      entryIv: h.entryIv,
      entryDelta: h.entryDelta,
      exitDebit: debitPerShare,
      exitUnderlying: spot,
      pnl: pnlBase,
      roc,
      annualizedRoc: (roc * 365) / daysHeld,
      daysHeld,
      exitReason: reason,
      tier: h.tier,
      collateral: h.collateralBase,
      maxAdverseExcursion: h.mae,
      shadow: h.shadow,
      ...(h.rules ? { scores: { rules: h.rules, shadow: h.shadow } } : { scores: { shadow: h.shadow } }),
    });
  };

  const liabilityBase = (day: ISODate): number => {
    let total = 0;
    for (const h of held) {
      if (h.shadow) continue;
      total += h.lastMid * h.u.multiplier * h.contracts * cfg.fxToBase(h.u.currency, day);
    }
    return total;
  };
  const lockedBase = (): number => held.reduce((s, h) => s + (h.shadow ? 0 : h.collateralBase), 0);

  for (let di = 0; di < days.length; di++) {
    const day = days[di] as ISODate;
    cfg.onDay?.(day, di, days.length);
    if (lastDay) cash *= (1 + cfg.cashRate / 365) ** diffDays(day, lastDay);
    lastDay = day;

    // 1-3: settle, fill, mark and test
    for (const h of [...held]) {
      const s = spotOn(h.u, day);
      if (!s) continue;
      const remove = (): void => {
        held.splice(held.indexOf(h), 1);
      };
      if (day >= h.expiry) {
        if (s.close < h.strike) close(h, day, s.close, h.strike - s.close, 'assigned');
        else close(h, day, s.close, 0, 'expired_otm');
        remove();
        continue;
      }
      const mid = midOf(h, s.close, s.i, day);
      h.lastMid = mid;
      h.mae = Math.max(h.mae, (mid - h.entryCredit) * h.u.multiplier * h.contracts);
      if (h.pending) {
        close(h, day, s.close, exitDebit(mid, cfg.haircuts[h.u.market]), h.pending);
        remove();
        continue;
      }
      const dte = diffDays(h.expiry, day);
      if (mid - h.entryCredit >= cfg.stopMultiple * h.entryCredit) h.pending = 'stop_loss';
      else if ((h.entryCredit - mid) / h.entryCredit >= cfg.takeProfitPct) h.pending = 'take_profit';
      else if (dte <= cfg.dteExit) h.pending = 'dte_exit';
    }

    // 4: entries
    const scanDay = di % cfg.scanEveryDays === 0;
    if (scanDay && held.filter((h) => !h.shadow).length < cfg.maxOpen) {
      scanDays++;
      const equityNow = cash - liabilityBase(day);
      const view: EngineView = {
        day,
        equity: equityNow,
        openPositions: held
          .filter((h) => !h.shadow)
          .map((h) => ({
            instrumentId: h.u.instrumentId,
            symbol: h.u.symbol,
            market: h.u.market,
            sector: h.u.sector,
            currency: h.u.currency,
            strike: h.strike,
            multiplier: h.u.multiplier,
            quantity: h.contracts,
            expiry: h.expiry,
          })),
        fxToBase: (ccy) => cfg.fxToBase(ccy, day),
      };
      const cands = await source.candidates(day, view);
      for (const c of cands) {
        const u = byId.get(c.instrumentId);
        if (!u) {
          skip('unknown_instrument');
          continue;
        }
        const s = spotOn(u, day);
        if (!s) {
          skip('no_bar');
          continue;
        }
        const shadow = c.shadow === true;
        if (cfg.tierPolicy === 'real_only' && c.tier !== 'real') {
          skip('tier_policy');
          continue;
        }
        if (held.some((h) => h.u.instrumentId === c.instrumentId && h.shadow === shadow)) {
          skip('already_open');
          continue;
        }
        if (!shadow && held.filter((h) => !h.shadow).length >= cfg.maxOpen) {
          skip('max_open');
          continue;
        }
        const dte = diffDays(c.expiry, day);
        if (dte <= 0 || c.contracts <= 0) {
          skip('bad_candidate');
          continue;
        }
        const haircuts = cfg.haircuts[u.market];
        const vol = rv.get(u.instrumentId)?.[s.i] ?? null;
        let credit = c.fillPrice;
        let sigmaScale = 1;
        const sigmaEntry = c.iv !== null ? c.iv * cfg.sigmaMultiplier : null;
        if (c.tier !== 'real' && sigmaEntry !== null && cfg.sigmaMultiplier !== 1) {
          credit = entryCredit(
            americanPutPrice(
              { spot: s.close, strike: c.strike, dte, rate: cfg.riskFree[u.market], q: u.divYield },
              Math.min(MAX_SIGMA, Math.max(MIN_SIGMA, sigmaEntry)),
            ),
            haircuts,
          );
        }
        if (!(credit > 0)) {
          skip('no_premium');
          continue;
        }
        if (vol !== null && vol > 0 && sigmaEntry !== null) sigmaScale = sigmaEntry / vol;
        else if (vol !== null && vol > 0) sigmaScale = cfg.sigmaMultiplier;
        const fx = cfg.fxToBase(u.currency, day);
        const collateralPer = c.strike * u.multiplier * fx;
        let qty = c.contracts;
        if (!shadow) {
          const free = cash - lockedBase();
          qty = Math.min(qty, Math.floor(free / collateralPer));
          if (qty <= 0) {
            skip('no_cash');
            continue;
          }
        } else qty = 1;
        const fees = cfg.feePerContract[u.market] * qty * fx;
        if (!shadow) cash += credit * u.multiplier * qty * fx - fees;
        held.push({
          u,
          strike: c.strike,
          expiry: c.expiry,
          contracts: qty,
          entryDate: day,
          entryCredit: credit,
          entryUnderlying: s.close,
          entryIv: sigmaEntry,
          entryDelta: c.delta,
          sigmaScale,
          fallbackSigma: sigmaEntry ?? 0.3,
          tier: c.tier,
          shadow,
          ...(c.rules ? { rules: c.rules } : {}),
          collateralBase: collateralPer * qty,
          feesEntry: fees,
          fxEntry: fx,
          lastMid: credit,
          mae: 0,
          pending: null,
        });
      }
    }

    // 5: record
    const equity = cash - liabilityBase(day);
    equityCurve.push({ day, equity, deployedPct: equity > 0 ? lockedBase() / equity : 0 });
  }

  // end of test: close what is still open at the last mark
  const lastDayOfTest = days[days.length - 1];
  if (lastDayOfTest) {
    for (const h of [...held]) {
      const i = idx.get(h.u.instrumentId);
      let k = h.u.bars.length - 1;
      while (k >= 0 && (h.u.bars[k] as { day: string }).day > lastDayOfTest) k--;
      if (k < 0 || !i) continue;
      const bar = h.u.bars[k] as { day: string; close: number };
      const mid = midOf(h, bar.close, k, lastDayOfTest);
      close(h, lastDayOfTest, bar.close, exitDebit(mid, cfg.haircuts[h.u.market]), 'end_of_test');
    }
    held.length = 0;
    const last = equityCurve[equityCurve.length - 1];
    if (last) {
      last.equity = cash;
      last.deployedPct = 0;
    }
  }
  return { trades, equity: equityCurve, skipped, scanDays };
}

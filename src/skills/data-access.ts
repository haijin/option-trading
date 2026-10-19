/**
 * Pure, asOf-bounded DataAccess over an in-memory InstrumentHistory (docs/02 section 2).
 *
 * The history holds everything loaded once per (run, instrument); `createDataAccess(history, asOf, ...)` slices it at
 * `asOf` on every read, so the same code serves a live scan and a historical replay and cannot look ahead. The
 * future-perturbation test (tests/skills/lookahead.test.ts) changes every row after `asOf` and asserts no skill result moves.
 */
import { addDays, type ISODate } from '../core/dates';
import { type FxPair, fxRate } from '../core/fx';
import { isVisibleAsOf } from '../core/reported-at';
import type {
  CalibrationRow,
  CalibrationSummary,
  CorporateEvent,
  DailyBar,
  DataSources,
  FundamentalStatement,
  Instrument,
  IvPoint,
  JournalOutcome,
  OptionChainSnapshot,
  PnlLedger,
} from '../core/types';
import { median } from '../core/util';
import type { DataAccess, SkillResult } from './contract';

export interface IvHistoryPoint extends IvPoint {
  skew25d: number | null;
}

/** The whole portfolio's puts and marks, loaded once per run and attached to every instrument's history. */
export type PortfolioLedger = PnlLedger;

export interface InstrumentHistory {
  instrument: Instrument;
  /** Ascending by day. */
  bars: DailyBar[];
  indexSymbol: string;
  indexBars: DailyBar[];
  volIndexSymbol: string | null;
  volIndexBars: DailyBar[];
  statements: FundamentalStatement[];
  events: CorporateEvent[];
  ivPoints: IvHistoryPoint[];
  /** Latest chain snapshot with snapshotDate <= asOf (lazy: chains are large). */
  chainAsOf(asOf: ISODate): Promise<OptionChainSnapshot | null>;
  /** Ascending daily rates, HKD per 1 unit of the pair's first currency. */
  fx: Partial<Record<FxPair, { day: ISODate; rate: number }[]>>;
  calibration: CalibrationRow[];
  journal: JournalOutcome[];
  /** Recorded puts and marks of the whole portfolio (the governor's input); absent means none recorded. */
  ledger?: PortfolioLedger;
}

export interface DataAccessOptions {
  chainMaxAgeDays: number;
  /**
   * Knowledge cutoff for statements (reportedAt) and events (knownAt). Defaults to asOf, which makes a historical replay
   * point-in-time. A LIVE scan of the last completed session passes today's date: what ingest saw this morning is known now.
   */
  knownThrough?: ISODate;
  priors?: Map<string, SkillResult>;
  memo?: Map<string, unknown>;
}

/** Index of the first element with day > asOf (so slice(0, i) is everything on or before asOf). */
function upperBound<T>(xs: readonly T[], key: (x: T) => string, asOf: string): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (key(xs[mid] as T) <= asOf) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function daysBetween(a: ISODate, b: ISODate): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
}

export function createDataAccess(h: InstrumentHistory, asOf: ISODate, opts: DataAccessOptions): DataAccess {
  const priors = opts.priors ?? new Map<string, SkillResult>();
  const memo = opts.memo ?? new Map<string, unknown>();
  const knownThrough = opts.knownThrough && opts.knownThrough > asOf ? opts.knownThrough : asOf;
  let chainCache: { value: OptionChainSnapshot | null } | undefined;

  const rawChain = async (): Promise<OptionChainSnapshot | null> => {
    if (!chainCache) chainCache = { value: await h.chainAsOf(asOf) };
    return chainCache.value;
  };

  return {
    async bars(lookback) {
      const end = upperBound(h.bars, (b) => b.day, asOf);
      return h.bars.slice(Math.max(0, end - lookback), end);
    },

    async fundamentals() {
      const statements = h.statements
        .filter((s) => isVisibleAsOf(s.reportedAt, knownThrough))
        .sort((a, b) => a.periodEnd.localeCompare(b.periodEnd) || a.periodType.localeCompare(b.periodType));
      return { statements };
    },

    async chain() {
      const c = await rawChain();
      if (!c) return null;
      // A pasted CSV chain may be a few days old (two-pass HK workflow); beyond that it is as good as absent.
      if (c.source === 'csv' && daysBetween(asOf, c.snapshotDate) > opts.chainMaxAgeDays) return null;
      return c;
    },

    async ivHistory(days) {
      const from = addDays(asOf, -days);
      return h.ivPoints
        .filter((p) => p.day <= asOf && p.day >= from)
        .map((p) => ({ day: p.day, iv30: p.iv30, tier: p.tier, termRatio: p.termRatio ?? null }));
    },

    async skewHistory(days) {
      const from = addDays(asOf, -days);
      return h.ivPoints
        .filter((p) => p.day <= asOf && p.day >= from && p.skew25d !== null)
        .map((p) => p.skew25d as number);
    },

    async calendar() {
      return { events: h.events.filter((e) => isVisibleAsOf(e.knownAt, knownThrough)) };
    },

    async market() {
      const ie = upperBound(h.indexBars, (b) => b.day, asOf);
      const ve = upperBound(h.volIndexBars, (b) => b.day, asOf);
      return {
        market: h.instrument.market,
        indexSymbol: h.indexSymbol,
        indexBars: h.indexBars.slice(Math.max(0, ie - 400), ie),
        volIndexSymbol: h.volIndexSymbol,
        volIndexBars: h.volIndexBars.slice(Math.max(0, ve - 400), ve),
      };
    },

    async fx(from, to) {
      return fxRate(from, to, (pair) => {
        const series = h.fx[pair];
        if (!series || series.length === 0) return null;
        const i = upperBound(series, (p) => p.day, asOf);
        return i === 0 ? null : (series[i - 1] as { rate: number }).rate;
      });
    },

    async calibration(minSamples): Promise<CalibrationSummary> {
      const rows = h.calibration.filter((r) => r.day <= asOf);
      const summarise = (subset: CalibrationRow[]): Record<string, { n: number; median: number }> => {
        const out: Record<string, { n: number; median: number }> = {};
        const buckets = new Set(subset.map((r) => r.bucket));
        for (const b of buckets) {
          const ratios = subset.filter((r) => r.bucket === b).map((r) => r.ratio);
          const m = median(ratios);
          if (ratios.length >= minSamples && m !== null) out[b] = { n: ratios.length, median: m };
        }
        return out;
      };
      const chainRows = rows.filter((r) => r.source !== 'journal');
      const ivr = chainRows.map((r) => r.ivRvRatio).filter((x): x is number => x !== null);
      const ivm = median(ivr);
      return {
        priceRatio: summarise(chainRows),
        journalRatio: summarise(rows.filter((r) => r.source === 'journal')),
        ivRvRatio: ivr.length >= minSamples && ivm !== null ? { n: ivr.length, median: ivm } : null,
      };
    },

    async journal() {
      return h.journal.filter((j) => j.closeDate <= asOf && j.openDate <= asOf);
    },

    async ledger(): Promise<PnlLedger> {
      const l = h.ledger;
      if (!l) return { positions: [], marks: [] };
      return {
        positions: l.positions
          .filter((p) => p.openDate <= asOf)
          .map((p) => (p.closeDate !== null && p.closeDate > asOf ? { ...p, closeDate: null, realizedPnl: null } : p)),
        marks: l.marks.filter((m) => m.day <= asOf),
      };
    },

    async sources(): Promise<DataSources> {
      const last = (bars: DailyBar[]): ISODate | null => {
        const i = upperBound(bars, (b) => b.day, asOf);
        return i === 0 ? null : (bars[i - 1] as DailyBar).day;
      };
      const usd = h.fx.USDHKD;
      const fxIdx = usd ? upperBound(usd, (p) => p.day, asOf) : 0;
      const fxLast: ISODate | null = usd && fxIdx > 0 ? (usd[fxIdx - 1] as { day: ISODate }).day : null;
      const c = await rawChain();
      return {
        barsLast: last(h.bars),
        indexLast: last(h.indexBars),
        volIndexLast: h.volIndexBars.length ? last(h.volIndexBars) : null,
        fxLast,
        chain: c ? { snapshotDate: c.snapshotDate, source: c.source } : null,
      };
    },

    priorSkillResult<T>(skillId: string) {
      return priors.get(skillId) as SkillResult<T> | undefined;
    },

    memo<T>(key: string, compute: () => T): T {
      if (!memo.has(key)) memo.set(key, compute());
      return memo.get(key) as T;
    },
  };
}

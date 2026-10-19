import { defaultAsOf } from '../../cli/asof';
import type { Market } from '../../core/calendar';
import type { Instrument } from '../../core/types';
import { getValuationOverrides, latestFairValue, setValuationOverrides } from '../../db/app-repos';
import { createRunStore, type RunStore } from '../../db/history';
import { findInstrument, getInstrument, loadParams } from '../../db/repos';
import { createDataAccess } from '../../skills/data-access';
import type { NameResult, RunReport } from '../../skills/runner';
import type { FundamentalPayload } from '../../skills/s1-fundamental-gate';
import {
  buildFacts,
  type ValuationOverrides as DomainOverrides,
  intrinsicValue,
  kpiRows,
  priceBadge,
  qualityScreen,
  quarterRows,
} from '../../valuation';
import type { ScanView, ValuationOverrides, ValueBadge, ValueView } from '../api-types';
import type { ServerDeps } from '../deps';
import { badRequest, notFound } from '../errors';
import type { AppState } from './state';

export const DEFAULT_RATE_PCT = 8;

interface Computed {
  view: ValueView;
}

/** Assembles the valuation module's inputs from stored data (point-in-time, as-of bounded) and caches the results per data version. */
export class ValueService {
  private store: { version: number; store: RunStore } | null = null;
  private cache = new Map<string, { version: number; c: Computed }>();

  constructor(
    private readonly deps: ServerDeps,
    private readonly state: AppState,
    private readonly fundamentalPayload: (inst: Instrument) => Promise<FundamentalPayload | null>,
  ) {}

  private runStore(): RunStore {
    if (!this.store || this.store.version !== this.state.version)
      this.store = { version: this.state.version, store: createRunStore(this.deps.db) };
    return this.store.store;
  }

  private async compute(
    inst: Instrument,
    ratePct: number,
    proposedPut: { strike: number; premium: number } | null,
    useStoredRate: boolean,
  ): Promise<ValueView> {
    const asOf = defaultAsOf(this.deps.now());
    const today = this.deps.now().toISOString().slice(0, 10);
    const params = (await loadParams(this.deps.db)).params;
    const history = await this.runStore().loadHistory(inst.id);
    const da = createDataAccess(history, asOf, { chainMaxAgeDays: params.runner.chainMaxAgeDays, knownThrough: today });
    const { statements } = await da.fundamentals();
    const bars = await da.bars(3000);
    const last = bars[bars.length - 1] ?? null;

    const ccys = [...new Set(statements.map((s) => s.currency))];
    const rates = new Map<string, number | null>();
    for (const c of ccys) rates.set(c, c === inst.currency ? 1 : await da.fx(c, inst.currency));

    const raw = await getValuationOverrides(this.deps.db, inst.id);
    const overrides = (raw as DomainOverrides | null) ?? null;
    const rate = useStoredRate && overrides?.requiredReturnPct !== undefined ? overrides.requiredReturnPct : ratePct;
    const fv = await latestFairValue(this.deps.db, inst.id);
    const s1 = await this.fundamentalPayload(inst);

    const facts = buildFacts({
      symbol: inst.symbol,
      market: inst.market,
      currency: inst.currency,
      solvencyModel: inst.solvencyModel,
      asOf,
      price: last?.close ?? 0,
      bars,
      statements,
      fxToTrading: (c) => rates.get(c) ?? null,
      extras: s1 ? { altmanZ: s1.zScore, fScore: s1.fScore, netDebtEbitda: s1.netDebtEbitda } : {},
      fairValue: fv,
    });
    const annual = statements.filter((s) => s.periodType === 'annual').length;
    const quarterly = statements.filter((s) => s.periodType === 'quarterly' || s.periodType === 'semiannual').length;
    const lastPeriodEnd = statements.reduce<string | null>(
      (m, s) => (m === null || s.periodEnd > m ? s.periodEnd : m),
      null,
    );
    return {
      symbol: inst.symbol,
      market: inst.market,
      asOf,
      currency: inst.currency,
      hasFundamentals: statements.length > 0,
      fundamentals: { annual, quarterly, lastPeriodEnd },
      kpis: kpiRows(facts),
      quarters: quarterRows(facts),
      screen: qualityScreen(facts),
      intrinsic: last
        ? withDisagreementWarning(intrinsicValue(facts, { requiredReturnPct: rate, overrides, proposedPut }))
        : null,
      fairValue: fv
        ? { value: fv.value, asOf: fv.asOf, moat: fv.moat, uncertainty: fv.uncertainty, source: fv.source }
        : null,
      overrides: overrides as ValuationOverrides | null,
    };
  }

  async view(
    market: Market,
    symbol: string,
    ratePct?: number,
    proposedPut: { strike: number; premium: number } | null = null,
  ): Promise<ValueView> {
    const inst = await findInstrument(this.deps.db, market, symbol);
    if (!inst) throw notFound(`${market}:${symbol} is not in the database`);
    if (ratePct !== undefined && !(ratePct >= 3.5 && ratePct <= 25))
      throw badRequest('invalid_rate', 'required return must be between 3.5 and 25 percent');
    return this.cached(inst, ratePct ?? DEFAULT_RATE_PCT, proposedPut, ratePct === undefined);
  }

  private async cached(
    inst: Instrument,
    rate: number,
    put: { strike: number; premium: number } | null,
    useStored: boolean,
  ): Promise<ValueView> {
    const key = `${inst.id}|${rate}|${put ? `${put.strike}/${put.premium}` : ''}|${useStored}`;
    const hit = this.cache.get(key);
    if (hit && hit.version === this.state.version) return hit.c.view;
    const view = await this.compute(inst, rate, put, useStored);
    this.cache.set(key, { version: this.state.version, c: { view } });
    return view;
  }

  async setOverrides(
    market: Market,
    symbol: string,
    overrides: ValuationOverrides | null,
    ratePct?: number,
  ): Promise<ValueView> {
    const inst = await findInstrument(this.deps.db, market, symbol);
    if (!inst) throw notFound(`${market}:${symbol} is not in the database`);
    if (overrides) validateOverrides(overrides);
    await setValuationOverrides(this.deps.db, inst.id, overrides ? (overrides as Record<string, unknown>) : null);
    this.state.bump();
    return this.view(market, symbol, ratePct);
  }

  /** Price-vs-intrinsic chip for one stock, or null when there is nothing to value. */
  async badge(inst: Instrument, put: { strike: number; premium: number } | null = null): Promise<ValueBadge | null> {
    try {
      const v = await this.cached(inst, DEFAULT_RATE_PCT, put, true);
      return v.intrinsic ? priceBadge(v.intrinsic) : null;
    } catch {
      return null;
    }
  }

  async badgesForWatchlist(instrumentIds: number[]): Promise<Map<number, ValueBadge | null>> {
    const out = new Map<number, ValueBadge | null>();
    for (const id of instrumentIds) {
      const inst = await getInstrument(this.deps.db, id);
      out.set(id, inst ? await this.badge(inst) : null);
    }
    return out;
  }

  async attachBadges(view: ScanView, report: RunReport): Promise<void> {
    const byKey = new Map<string, NameResult>(
      report.names.map((n) => [`${n.instrument.market}|${n.instrument.symbol}`, n]),
    );
    for (const i of view.ideas) {
      const n = byKey.get(`${i.market}|${i.symbol}`);
      if (!n) continue;
      i.value = await this.badge(n.instrument, { strike: i.contract.strike, premium: i.contract.premium });
    }
    for (const r of view.rejected) {
      const n = byKey.get(`${r.market}|${r.symbol}`);
      if (n) r.value = await this.badge(n.instrument);
    }
  }
}

/** The median of methods that disagree wildly is a weak number: say so next to it. */
export function withDisagreementWarning<T extends { methods: { value: number }[]; warnings: string[] }>(iv: T): T {
  const v = iv.methods.map((m) => m.value).filter((x) => x > 0);
  if (v.length >= 2) {
    const lo = Math.min(...v);
    const hi = Math.max(...v);
    if (hi / lo > 2)
      iv.warnings.push(
        `The methods disagree strongly (${lo.toFixed(2)} to ${hi.toFixed(2)}): the median is a weak guide, check the assumptions below.`,
      );
  }
  return iv;
}

export function validateOverrides(o: ValuationOverrides): void {
  const triple = (a: unknown, name: string, lo: number, hi: number): void => {
    if (a === undefined) return;
    if (
      !Array.isArray(a) ||
      a.length !== 3 ||
      a.some((x) => typeof x !== 'number' || !Number.isFinite(x) || x < lo || x > hi)
    )
      throw badRequest('invalid_overrides', `${name} must be three numbers (bull, base, bear) between ${lo} and ${hi}`);
  };
  triple(o.growthPct, 'growthPct', -30, 60);
  triple(o.targetPe, 'targetPe', 1, 100);
  if (
    o.dcfGrowthPct !== undefined &&
    !(typeof o.dcfGrowthPct === 'number' && o.dcfGrowthPct >= -30 && o.dcfGrowthPct <= 40)
  )
    throw badRequest('invalid_overrides', 'dcfGrowthPct must be between -30 and 40');
  if (
    o.requiredReturnPct !== undefined &&
    !(typeof o.requiredReturnPct === 'number' && o.requiredReturnPct >= 3.5 && o.requiredReturnPct <= 25)
  )
    throw badRequest('invalid_overrides', 'requiredReturnPct must be between 3.5 and 25');
}

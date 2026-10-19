import { and, asc, eq, gte } from 'drizzle-orm';
import { defaultAsOf } from '../../cli/asof';
import { executeRun } from '../../cli/pipeline';
import type { Market } from '../../core/calendar';
import { addDays } from '../../core/dates';
import type { Instrument } from '../../core/types';
import { loadBars } from '../../db/history';
import { findInstrument } from '../../db/repos';
import { corporateEvents } from '../../db/schema';
import { sma } from '../../indicators';
import type { NameResult } from '../../skills/runner';
import type { FundamentalPayload } from '../../skills/s1-fundamental-gate';
import type { TechnicalPayload } from '../../skills/s2-technical-timing';
import type { OptionSelectPayload } from '../../skills/s4-option-select';
import type { ChartView, ExplainView } from '../api-types';
import { cliContextOf, type ServerDeps } from '../deps';
import { notFound } from '../errors';
import { contractView, narrativeView, reasonViews, skillRows } from '../views';
import type { AppState } from './state';

/** Per-stock reads: the full "explain" run, the price chart and the fundamental-gate payload the KPI table borrows. */
export class StockService {
  private runs = new Map<string, { version: number; n: NameResult }>();

  constructor(
    private readonly deps: ServerDeps,
    private readonly state: AppState,
  ) {}

  async instrument(market: Market, symbol: string): Promise<Instrument> {
    const inst = await findInstrument(this.deps.db, market, symbol);
    if (!inst) throw notFound(`${market}:${symbol} is not in the database: add it to the watchlist first`);
    return inst;
  }

  /** Every scanner skill for one name (full mode, stale inputs allowed, equity not required). Cached per data version. */
  async explainRun(inst: Instrument): Promise<NameResult> {
    const key = String(inst.id);
    const hit = this.runs.get(key);
    if (hit && hit.version === this.state.version) return hit.n;
    const version = this.state.version;
    const { report } = await executeRun(cliContextOf(this.deps), {
      asOf: defaultAsOf(this.deps.now()),
      mode: 'full',
      gate: 'report',
      allowStale: true,
      only: [inst],
      requireEquity: false,
    });
    const n = report.names[0] as NameResult;
    this.runs.set(key, { version, n });
    return n;
  }

  async fundamentalPayload(inst: Instrument): Promise<FundamentalPayload | null> {
    try {
      const n = await this.explainRun(inst);
      return (n.results['fundamental.gate']?.payload as FundamentalPayload | undefined) ?? null;
    } catch {
      return null;
    }
  }

  async explain(market: Market, symbol: string): Promise<ExplainView> {
    const inst = await this.instrument(market, symbol);
    const n = await this.explainRun(inst);
    const asOf = defaultAsOf(this.deps.now());
    const s4 = n.results['option.select']?.payload as OptionSelectPayload | undefined;
    const events = await this.deps.db
      .select()
      .from(corporateEvents)
      .where(and(eq(corporateEvents.instrumentId, inst.id), gte(corporateEvents.eventDate, addDays(asOf, -90))))
      .orderBy(asc(corporateEvents.eventDate));
    const b = n.binding;
    return {
      symbol: inst.symbol,
      market: inst.market,
      name: inst.name,
      sector: inst.sector,
      asOf,
      status: n.status as ExplainView['status'],
      binding: b
        ? { skillId: b.skillId, rule: b.reason.rule, detail: b.reason.note ?? String(b.reason.value ?? '') }
        : null,
      skills: skillRows(n.results),
      reasons: reasonViews(n.results),
      contract: s4?.chosen ? contractView(s4.chosen, s4, inst) : null,
      narrative: narrativeView(n),
      freshness: {
        stale: n.stale.map((s) => ({ source: s.input, last: s.actual, detail: `required ${s.required}` })),
        chainFresh: n.freshChain,
      },
      events: events.map((e) => ({ type: e.eventType, date: e.eventDate, confirmed: e.confirmed, source: e.source })),
    };
  }

  async chart(market: Market, symbol: string, barCount: number): Promise<ChartView> {
    const inst = await this.instrument(market, symbol);
    const asOf = defaultAsOf(this.deps.now());
    const all = (await loadBars(this.deps.db, inst.id)).filter((b) => b.day <= asOf);
    const closes = all.map((b) => b.close);
    const s50 = sma(closes, 50);
    const s200 = sma(closes, 200);
    const n = Math.max(20, Math.min(1500, Math.round(barCount)));
    const from = Math.max(0, all.length - n);
    let support: number | null = null;
    let supportSource: string | null = null;
    let strike: number | null = null;
    let breakeven: number | null = null;
    if (all.length > 0) {
      try {
        const run = await this.explainRun(inst);
        const s2 = run.results['technical.timing']?.payload as TechnicalPayload | undefined;
        const s4 = run.results['option.select']?.payload as OptionSelectPayload | undefined;
        support = s2?.support ?? null;
        supportSource = s2?.supportSource ?? null;
        strike = s4?.chosen?.strike ?? null;
        breakeven = s4?.chosen?.breakeven ?? null;
      } catch {
        // the chart is still useful without the overlays
      }
    }
    return {
      symbol: inst.symbol,
      market: inst.market,
      currency: inst.currency,
      asOf,
      last: all[all.length - 1]?.close ?? 0,
      bars: all.slice(from).map((b) => ({ day: b.day, close: b.close })),
      sma50: s50.slice(from),
      sma200: s200.slice(from),
      support,
      supportSource,
      strike,
      breakeven,
    };
  }
}

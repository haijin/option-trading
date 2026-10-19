import type {
  ChartView,
  ExplainView,
  HealthView,
  IdeaView,
  Market,
  OpenNameView,
  OverviewView,
  RejectView,
  ScanView,
} from '../../src/server/api-types';
import { type Evaluated, evaluate } from './engine';
import { lastDoneSummary } from './ingest';
import { leadersCard } from './leaders';
import type { WatchRow } from './model';
import { priceSeries, smaAt } from './series';
import { activeRows, deployView, openFor, regimeView, requireEquity, store } from './state';
import { marketCurrency } from './symbols';
import { ASOF, DISCLAIMER, FX_USD_HKD, HttpError, nowIso, round, weekdaysEndingAt } from './util';

export const PARAMS_LABEL = 'default v1 (6cacf9ab)';

export function buildHealth(): HealthView {
  return { ok: true, version: '0.1.0-mock', database: { connected: true, name: 'option_trading' }, now: nowIso() };
}

export function buildOverview(): OverviewView {
  const act = activeRows();
  const all = [...store.watch.values()];
  const withData = act.filter((r) => r.profile !== null);
  return {
    asOf: ASOF,
    generatedAt: nowIso(),
    baseCurrency: store.baseCurrency,
    equity: store.equity,
    fxUsdHkd: FX_USD_HKD,
    regime: { US: regimeView('US'), HK: regimeView('HK') },
    deployed: { US: deployView('US'), HK: deployView('HK') },
    watchlist: {
      watching: act.length,
      paused: all.length - act.length,
      us: act.filter((r) => r.market === 'US').length,
      hk: act.filter((r) => r.market === 'HK').length,
      pendingFirstIngest: act.filter((r) => r.ingest === 'pending').length,
    },
    data: {
      lastIngest: lastDoneSummary(),
      currentNames: withData.filter((r) => (r.profile?.lastBar ?? '') >= ASOF).length,
      staleNames: withData.filter((r) => (r.profile?.lastBar ?? ASOF) < ASOF).length,
    },
    lastScan: store.lastScan,
    leaders: leadersCard(),
    disclaimer: DISCLAIMER,
  };
}

// ------------------------------------------------------------------------------------------------ scan
function toIdea(e: Evaluated, rank: number): IdeaView {
  const p = e.profile;
  const c = e.contract;
  if (!p || !c) throw new Error('an idea always has a profile and a contract');
  return {
    symbol: e.row.symbol,
    market: e.row.market,
    name: e.row.name,
    sector: e.row.sector,
    currency: marketCurrency(e.row.market),
    rank,
    composite: e.composite,
    confidence: round(0.9 - (e.tier === 'synthetic' ? 0.25 : 0.1) - (p.vol.mode === 'rvOnly' ? 0.05 : 0), 2),
    tier: e.tier,
    staleTagged: e.staleTagged,
    spot: p.spot,
    support: p.tech.support,
    supportSource: p.tech.supportKind,
    trend: e.trend,
    contract: c,
    sizing: e.sizing,
    ruleWarns: e.ruleWarns,
    narrative: e.narrative,
    reasons: e.reasons,
    skills: e.skills,
    nextEarnings: e.er,
    value: e.value,
  };
}

function toReject(e: Evaluated): RejectView {
  const b = e.reject;
  if (!b) throw new Error('a reject always has a binding rule');
  const stale = b.status === 'dropped_stale';
  return {
    symbol: e.row.symbol,
    market: e.row.market,
    name: e.row.name,
    sector: e.row.sector,
    status: b.status,
    bindingRule: b.rule,
    detail: b.detail,
    skillId: b.skillId || null,
    staleLastBar: stale ? (e.profile?.lastBar ?? null) : null,
    reasons: e.reasons,
    skills: e.skills,
    value: stale ? null : e.value,
  };
}

const signature = (e: Evaluated): string =>
  JSON.stringify([
    store.equity,
    store.baseCurrency,
    e.state,
    e.reject?.rule,
    e.contract?.priceSource,
    e.sizing?.contracts,
    e.er?.date,
    e.row.maxCollateralPct,
  ]);

export function buildScan(opts: { allowStale: boolean; durationMs: number; save: boolean }): ScanView {
  requireEquity();
  const evaluated = activeRows().map((r) => evaluate(r, { allowStale: opts.allowStale }));
  const ranked = (m: Market) =>
    evaluated
      .filter((e) => e.state === 'idea' && e.row.market === m)
      .sort((a, b) => b.composite - a.composite)
      .map((e, i) => toIdea(e, i + 1));
  const ideas = [...ranked('US'), ...ranked('HK')];

  let cacheHits = 0;
  const scored = evaluated.filter((e) => e.state !== 'waiting' && e.state !== 'no_data');
  for (const e of scored) {
    const sig = signature(e);
    if (store.scanSigs.get(e.key) === sig) cacheHits++;
    store.scanSigs.set(e.key, sig);
  }

  let savedRunId: string | null = null;
  if (opts.save) {
    savedRunId = `scan-${String(store.nextScanId++).padStart(4, '0')}`;
    store.lastScan = { id: savedRunId, at: nowIso(), asOf: ASOF, ideas: ideas.length };
  }
  const openNames: OpenNameView[] = evaluated
    .filter((e) => e.state === 'open')
    .map((e) => ({
      symbol: e.row.symbol,
      market: e.row.market,
      name: e.row.name,
      contracts: openFor(e.row.market, e.row.symbol).reduce((n, p) => n + p.quantity, 0),
    }));
  return {
    asOf: ASOF,
    generatedAt: nowIso(),
    paramsLabel: PARAMS_LABEL,
    stats: { cacheHits, computed: scored.length - cacheHits, durationMs: opts.durationMs },
    ideas,
    rejected: evaluated.filter((e) => e.state === 'reject').map(toReject),
    openNames,
    pasteChainsFor: ideas
      .filter((i) => i.market === 'HK' && i.contract.priceSource === 'synthetic')
      .map((i) => ({ symbol: i.symbol, market: i.market, composite: i.composite })),
    savedRunId,
    waitingForData: evaluated
      .filter((e) => e.state === 'waiting' || e.state === 'no_data')
      .map((e) => ({ symbol: e.row.symbol, market: e.row.market })),
  };
}

// ------------------------------------------------------------------------------------------------ explain
export function buildExplain(row: WatchRow): ExplainView {
  requireEquity();
  const ev = evaluate(row);
  const p = ev.profile;
  const status = !row.active
    ? 'paused'
    : ev.state === 'waiting'
      ? 'pending_first_ingest'
      : ev.state === 'no_data'
        ? 'no_data'
        : ev.state === 'open'
          ? 'open_put'
          : ev.state === 'idea'
            ? 'idea'
            : (ev.reject?.status ?? 'rejected');
  const stale: ExplainView['freshness']['stale'] = [];
  if (!p) stale.push({ source: 'bars', last: null, detail: 'Never ingested: run an ingest to fetch prices.' });
  else {
    if (p.lastBar < ASOF)
      stale.push({ source: 'bars', last: p.lastBar, detail: `Last bar ${p.lastBar}, expected ${ASOF}.` });
    if (p.market === 'HK' && !ev.chain)
      stale.push({ source: 'chain', last: null, detail: 'No chain stored: this HK put is priced synthetically.' });
  }
  const events: ExplainView['events'] = (store.events.get(`${row.market}:${row.symbol}`) ?? []).map((e) => ({
    type: e.type,
    date: e.date,
    confirmed: e.confirmed,
    source: e.source,
  }));
  if (ev.er) events.push({ type: 'earnings', date: ev.er.date, confirmed: ev.er.confirmed, source: ev.er.source });
  const seen = new Set<string>();
  const uniqueEvents = events
    .filter((e) => {
      const k = `${e.type}|${e.date}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.date.localeCompare(b.date));
  return {
    symbol: row.symbol,
    market: row.market,
    name: row.name,
    sector: row.sector,
    asOf: ASOF,
    status: ((): ExplainView['status'] =>
      status === 'idea'
        ? 'ranked'
        : status === 'open_put'
          ? 'excluded'
          : status === 'paused'
            ? 'excluded'
            : status === 'pending_first_ingest' || status === 'no_data'
              ? 'dropped_stale'
              : (status as ExplainView['status']))(),
    binding: ev.reject
      ? { skillId: ev.reject.skillId || 'data.freshness', rule: ev.reject.rule, detail: ev.reject.detail }
      : null,
    skills: ev.skills,
    reasons: ev.reasons,
    contract: ev.contract,
    narrative: ev.narrative,
    freshness: { stale, chainFresh: p !== null && (ev.chain !== null || p.market === 'US') },
    events: uniqueEvents,
  };
}

// ------------------------------------------------------------------------------------------------ chart
export function buildChart(row: WatchRow, bars: number): ChartView {
  const p = row.profile;
  if (!p)
    throw new HttpError(404, 'no_data', `No price history for ${row.market}:${row.symbol} yet: run an ingest first.`);
  const ev = evaluate(row);
  const closes = priceSeries(p);
  const dates = weekdaysEndingAt(p.lastBar, closes.length);
  const from = closes.length - bars;
  const visible = closes.slice(from);
  const idx = (i: number) => from + i;
  const c = ev.contract;
  return {
    symbol: row.symbol,
    market: row.market,
    currency: marketCurrency(row.market),
    asOf: p.lastBar,
    last: p.spot,
    bars: visible.map((close, i) => ({ day: dates[idx(i)], close })),
    sma50: visible.map((_, i) => smaAt(closes, idx(i), 50)),
    sma200: visible.map((_, i) => smaAt(closes, idx(i), 200)),
    support: p.tech.support,
    supportSource: p.tech.supportKind,
    strike: c ? c.strike : null,
    breakeven: c ? c.breakeven : null,
  };
}

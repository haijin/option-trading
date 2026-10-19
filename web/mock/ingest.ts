import type { IngestItemView, IngestJobView, IngestSummaryView, StockKey } from '../../src/server/api-types';
import { type IngestPlanStep, type IngestRec, keyOf, type WatchRow } from './model';
import { activeRows, requireRow, rows, store } from './state';
import { directoryName, directorySector, parseSymbol } from './symbols';
import { synthProfile } from './synth';
import { ASOF, conflict, invalid, isoAt, isRecord, notFound } from './util';

export const INGEST_MS = 5600;

/** Names starting with ZZ simulate "the provider has no data": their ingest step fails. */
export const hasNoProviderData = (symbol: string): boolean => symbol.startsWith('ZZ');

type Plan = Pick<IngestRec, 'plan' | 'summary' | 'error' | 'durationMs'>;

function buildPlan(fetch: WatchRow[], paused: WatchRow[]): Plan {
  const events: Omit<IngestPlanStep, 't'>[] = [];
  const log = (text: string) => events.push({ log: text });
  const item = (target: string, step: string, status: IngestItemView['status'], detail: string) =>
    events.push({ item: { target, step, status, detail } });
  const us = fetch.filter((r) => r.market === 'US');
  const hk = fetch.filter((r) => r.market === 'HK');
  const firsts = fetch.filter((r) => r.ingest !== 'loaded' && !hasNoProviderData(r.symbol));
  let rowCount = 0;
  let barFailures = 0;

  log(`watchlist    ${fetch.length} watched (${us.length} US, ${hk.length} HK)`);
  if (paused.length > 0) log(`skipped      ${paused.length} not watching: ${paused.map((r) => r.symbol).join(', ')}`);
  for (const [label, group] of [
    ['US', us],
    ['HK', hk],
  ] as const) {
    if (group.length === 0) continue;
    const bad = group.filter((r) => hasNoProviderData(r.symbol)).length;
    log(`yahoo bars   ${label}   ${group.length} names ........ ${bad > 0 ? `${bad} failed` : 'ok'}`);
    for (const r of group) {
      if (hasNoProviderData(r.symbol)) {
        barFailures++;
        item(r.symbol, 'bars', 'failed', `Yahoo has no data for ${r.market === 'HK' ? `${r.symbol}.HK` : r.symbol}`);
      } else {
        const first = r.ingest !== 'loaded';
        rowCount += first ? 380 : 1;
        item(r.symbol, 'bars', 'ok', first ? `380 bars (first fetch), last ${ASOF}` : `+1 bar, last ${ASOF}`);
      }
    }
  }
  log('index bars   SPY ^VIX 2800.HK ^HSI ... ok');
  item('indices', 'bars', 'ok', 'SPY ^VIX 2800.HK ^HSI, +1 bar each');
  log('fx           USDHKD CNYHKD ............ ok');
  item('fx', 'rates', 'ok', 'USDHKD 7.78, CNYHKD 1.09');
  rowCount += 6;
  if (firsts.length > 0) {
    log(`fundamentals first fetch ${firsts.map((r) => r.symbol).join(', ')} ........ ok`);
    for (const r of firsts) item(r.symbol, 'fundamentals', 'ok', '4 annual and 8 quarterly statements');
    rowCount += firsts.length * 12;
  } else {
    log('fundamentals weekly, last 2026-10-05 .. skipped');
    item('all', 'fundamentals', 'skipped', 'weekly job, last run 2026-10-05');
  }
  if (us.length > 0) {
    log(`us chains    ${us.length} names ........ ok`);
    item('US', 'chains', 'ok', `${us.length} names, Yahoo option chains`);
    rowCount += us.length * 60;
  }
  log('earnings     dates ............ ok');
  item('all', 'earnings', 'ok', 'next results dates refreshed');
  log('vhsi         no Yahoo history ........ skipped');
  item('HK', 'vhsi', 'skipped', 'no Yahoo history; data/vhsi.csv not found');
  if (firsts.length > 0) log(`first fetch  ${firsts.map((r) => r.symbol).join(', ')} ........ ok (new)`);

  const items = events.flatMap((e) => (e.item ? [e.item] : []));
  const summary = {
    ok: items.filter((i) => i.status === 'ok').length,
    failed: items.filter((i) => i.status === 'failed').length,
    skipped: items.filter((i) => i.status === 'skipped').length,
    rows: rowCount,
  };
  const fetched = fetch.length - barFailures;
  log(
    `${fetched} ${fetched === 1 ? 'name' : 'names'} fetched, ${summary.failed} failed, ${summary.skipped} skipped (${(INGEST_MS / 1000).toFixed(1)} s)`,
  );

  const span = INGEST_MS - 600;
  const plan = events.map((e, i) => ({ ...e, t: Math.round(150 + (i / (events.length - 1)) * span) }));
  const error =
    fetch.length > 0 && barFailures === fetch.length
      ? `Every fetch failed: Yahoo has no data for ${fetch.map((r) => r.symbol).join(', ')}.`
      : null;
  return { plan, summary, error, durationMs: INGEST_MS };
}

function applyEffects(rec: IngestRec): void {
  for (const key of rec.fetched) {
    const row = store.watch.get(key);
    if (!row || row.ingest === 'loaded') continue;
    if (hasNoProviderData(row.symbol)) {
      row.ingest = 'no_data';
      continue;
    }
    row.name = row.name ?? directoryName(row.market, row.symbol);
    row.sector = row.sector ?? directorySector(row.market, row.symbol);
    const profile = synthProfile(row);
    row.profile = profile;
    row.name = profile.name;
    row.sector = profile.sector;
    row.ingest = 'loaded';
    if (row.solvencyInferred) {
      row.solvencyModel =
        profile.sector === 'Financials' ? 'financial' : profile.sector === 'Property' ? 'property' : 'altman';
      row.solvencyInferred = false;
    }
  }
}

/** Jobs advance with wall time: anything past its duration is finished and its effects applied. */
export function settleIngest(now = Date.now()): void {
  for (const rec of store.ingestJobs) {
    if (!rec.settled && now - rec.startedAtMs >= rec.durationMs) {
      rec.settled = true;
      applyEffects(rec);
    }
  }
}

function toView(rec: IngestRec, now: number): IngestJobView {
  const elapsed = now - rec.startedAtMs;
  const done = rec.settled || elapsed >= rec.durationMs;
  const visible = rec.plan.filter((s) => done || s.t <= elapsed);
  return {
    id: rec.id,
    status: done ? (rec.error ? 'failed' : 'done') : 'running',
    startedAt: isoAt(rec.startedAtMs),
    finishedAt: done ? isoAt(rec.startedAtMs + rec.durationMs) : null,
    scope: rec.scope,
    log: visible.flatMap((s) => (s.log !== undefined ? [s.log] : [])),
    items: visible.flatMap((s) => (s.item ? [s.item] : [])),
    summary: done ? rec.summary : null,
    error: done ? rec.error : null,
    pausedSkipped: rec.pausedSkipped,
  };
}

const idOf = (n: number): string => `ing-${String(n).padStart(3, '0')}`;

export function startIngest(raw: unknown): IngestJobView {
  settleIngest();
  const running = store.ingestJobs.find((j) => !j.settled);
  if (running) throw conflict('ingest_running', `An ingest is already running (${running.id}). Wait for it to finish.`);
  const body = raw === undefined || raw === null ? {} : raw;
  if (!isRecord(body)) throw invalid('The request body must be a JSON object.');
  let fetch: WatchRow[];
  let paused: WatchRow[];
  let scope: IngestRec['scope'] = 'all';
  if (body.only === undefined || body.only === null) {
    fetch = activeRows();
    paused = rows().filter((r) => !r.active);
  } else {
    if (!Array.isArray(body.only) || body.only.length === 0)
      throw invalid(
        'Field "only" must be a non-empty array of { market, symbol } (omit it to fetch every watched stock).',
      );
    const picked = body.only.map((k, i) => requireRow(...keyParts(k, i)));
    fetch = picked.filter((r) => r.active);
    paused = picked.filter((r) => !r.active);
    if (fetch.length === 0)
      throw conflict('nothing_to_ingest', 'None of the selected stocks is being watched: resume them first.');
    scope = fetch.map((r) => ({ market: r.market, symbol: r.symbol }));
  }
  if (fetch.length === 0)
    throw conflict('nothing_to_ingest', 'No stock is being watched: add or resume a stock first.');
  const plan = buildPlan(fetch, paused);
  const rec: IngestRec = {
    id: idOf(store.nextIngestId++),
    startedAtMs: Date.now(),
    scope,
    pausedSkipped: paused.map((r) => r.symbol),
    fetched: fetch.map((r) => keyOf(r.market, r.symbol)),
    settled: false,
    ...plan,
  };
  store.ingestJobs.push(rec);
  return toView(rec, Date.now());
}

function keyParts(k: unknown, i: number): [StockKey['market'], string] {
  if (!isRecord(k) || (k.market !== 'US' && k.market !== 'HK') || typeof k.symbol !== 'string') {
    throw invalid(`Field "only[${i}]" must be { market: 'US' | 'HK', symbol: string }.`);
  }
  const parsed = parseSymbol(k.symbol, k.market);
  if (!parsed.ok) throw invalid(`Field "only[${i}]": ${parsed.error}`);
  return [parsed.market, parsed.symbol];
}

export function getIngest(id: string): IngestJobView {
  settleIngest();
  const rec = store.ingestJobs.find((j) => j.id === id);
  if (!rec) throw notFound(`No ingest job "${id}".`);
  return toView(rec, Date.now());
}

export function lastIngestView(): IngestJobView | null {
  settleIngest();
  const rec = store.ingestJobs.at(-1);
  return rec ? toView(rec, Date.now()) : null;
}

export function lastDoneSummary(): IngestSummaryView | null {
  settleIngest();
  const rec = [...store.ingestJobs].reverse().find((j) => j.settled);
  if (!rec) return null;
  return { at: isoAt(rec.startedAtMs + rec.durationMs), ...rec.summary };
}

// ------------------------------------------------------------------------------------------------ seed
/** One finished job from the day before, built from the initial watchlist so the Data page starts with a history. */
export function seedIngest(): void {
  const all = rows();
  const rec: IngestRec = {
    id: idOf(store.nextIngestId++),
    startedAtMs: Date.parse('2026-10-10T10:02:00.000Z'),
    scope: 'all',
    pausedSkipped: [],
    fetched: all.map((r) => keyOf(r.market, r.symbol)),
    settled: true,
    ...buildPlan(all, []),
  };
  store.ingestJobs.push(rec);
}

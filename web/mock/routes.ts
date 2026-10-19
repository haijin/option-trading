import type { AuthSessionView, Market, ValuationOverrides, ValueView } from '../../src/server/api-types';
import { askGet, askStart, askThread } from './ask';
import { addEvent, buildDataStatus, importChain, importFairValues } from './dataops';
import {
  closeDiaryEntry,
  deleteDiaryEntry,
  diaryCalendar,
  diaryExport,
  diaryLessons,
  diaryRevisions,
  getDiaryEntry,
  listDiary,
  putDiaryEntry,
  restoreDiaryRevision,
  undeleteDiaryEntry,
} from './diary';
import { acceptAi, cancelAi, getAi, latestAi, rejectAi, startAi } from './diaryAi';
import { readAsset, uploadAsset } from './diaryAssets';
import { getIngest, startIngest } from './ingest';
import { importJournal } from './journal';
import { buildValueView } from './kpi';
import {
  buildLeaders,
  buildLeadersDays,
  buildLeadersRecord,
  muteLeader,
  refreshLeaders,
  unmuteLeader,
  watchLeader,
} from './leaders';
import type { WatchRow } from './model';
import { keyOf } from './model';
import { buildNews, buildNewsDays, newsBriefs, refreshNews, searchNews } from './news';
import { addPosition, buildPositions, closePosition } from './positions';
import { buildMockReminders } from './reminders';
import { cancelRun, getRun, listRuns, runReportMd, skillCatalog, startRuns } from './research';
import { buildChart, buildExplain, buildHealth, buildOverview, buildScan } from './scan';
import { getSettings, putSettings } from './settings';
import { requireRow, store } from './state';
import { parseSymbol } from './symbols';
import { HttpError, invalid, notFound, parseNum } from './util';
import { Body, triple } from './validate';
import {
  addWatch,
  bulkWatch,
  exportCsv,
  listWatchlist,
  pasteWatch,
  patchWatch,
  previewWatch,
  watchBoard,
} from './watchlist';

export interface RouteCtx {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  /** The latency applied to this request, ms (the scan reports it as its duration). */
  delayMs: number;
}

/** A non-JSON reply: the CSV and Markdown downloads. */
export interface RawReply {
  raw: true;
  contentType: string;
  /** Text, or the bytes of an image. */
  body: string | Buffer;
  headers?: Record<string, string>;
}

export type Reply = unknown;
export interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  pattern: string;
  kind?: 'scan';
  handler: (ctx: RouteCtx) => Reply;
}

const stockRow = (ctx: RouteCtx): WatchRow => {
  const market = ctx.params.market;
  if (market !== 'US' && market !== 'HK') throw notFound(`Unknown market "${market}": use US or HK.`);
  const parsed = parseSymbol(ctx.params.symbol, market as Market);
  if (!parsed.ok) throw invalid(parsed.error);
  return requireRow(parsed.market, parsed.symbol);
};

function rateParam(query: URLSearchParams): number | null {
  const text = query.get('rate');
  if (text === null || text === '') return null;
  const rate = parseNum(text);
  if (!(rate >= 1 && rate <= 30)) throw invalid('Query parameter "rate" must be a number from 1 to 30 (percent).');
  return rate;
}

function barsParam(query: URLSearchParams): number {
  const text = query.get('bars');
  if (text === null || text === '') return 180;
  const n = parseNum(text);
  if (!(Number.isInteger(n) && n >= 20 && n <= 380))
    throw invalid('Query parameter "bars" must be a whole number from 20 to 380.');
  return n;
}

const OVERRIDE_KEYS = ['growthPct', 'targetPe', 'dcfGrowthPct', 'requiredReturnPct'];

function putValuation(ctx: RouteCtx): ValueView {
  const row = stockRow(ctx);
  if (!row.profile)
    throw new HttpError(
      409,
      'no_fundamentals',
      `${row.market}:${row.symbol} has no stored fundamentals yet: run an ingest first.`,
    );
  const key = keyOf(row.market, row.symbol);
  if (ctx.body === null || ctx.body === undefined) store.overrides.delete(key);
  else {
    const b = Body.from(ctx.body);
    const unknown = Object.keys(ctx.body as Record<string, unknown>).filter((k) => !OVERRIDE_KEYS.includes(k));
    if (unknown.length > 0)
      throw invalid(`Unknown field "${unknown[0]}": allowed fields are ${OVERRIDE_KEYS.join(', ')}.`);
    const next: ValuationOverrides = {};
    const present = (k: string) => b.raw(k) !== undefined && b.raw(k) !== null;
    if (present('growthPct')) next.growthPct = triple('growthPct', b.raw('growthPct'), { min: -30, max: 80 });
    if (present('targetPe')) next.targetPe = triple('targetPe', b.raw('targetPe'), { positive: true, max: 100 });
    const dcf = b.optNumber('dcfGrowthPct', { min: -30, max: 80 });
    if (dcf !== undefined) next.dcfGrowthPct = dcf;
    const rate = b.optNumber('requiredReturnPct', { min: 1, max: 30 });
    if (rate !== undefined) next.requiredReturnPct = rate;
    if (Object.keys(next).length === 0) store.overrides.delete(key);
    else store.overrides.set(key, next);
  }
  return buildValueView(row, rateParam(ctx.query));
}

const download = (contentType: string, body: string, filename: string): RawReply => ({
  raw: true,
  contentType,
  body,
  headers: { 'Content-Disposition': `attachment; filename="${filename}"` },
});

const allowStale = (q: URLSearchParams): boolean => q.get('allowStale') === '1' || q.get('allowStale') === 'true';

/** The mock needs no login: this is the answer of a server started with OT_AUTH=off, so the UI shows the app directly. */
const NO_LOGIN: AuthSessionView = {
  authRequired: false,
  user: null,
  setupRequired: false,
  canSetup: false,
  localUrl: '',
  providers: { password: true, google: false, emailLink: true, emailDelivery: 'console' },
};

export const ROUTES: Route[] = [
  { method: 'GET', pattern: '/api/health', handler: () => buildHealth() },
  { method: 'GET', pattern: '/api/auth/session', handler: () => NO_LOGIN },
  { method: 'GET', pattern: '/api/overview', handler: () => buildOverview() },
  {
    method: 'GET',
    pattern: '/api/scan',
    kind: 'scan',
    handler: (c) => buildScan({ allowStale: allowStale(c.query), durationMs: c.delayMs, save: false }),
  },
  {
    method: 'POST',
    pattern: '/api/scan/run',
    kind: 'scan',
    handler: (c) => buildScan({ allowStale: allowStale(c.query), durationMs: c.delayMs, save: true }),
  },
  { method: 'GET', pattern: '/api/stocks/:market/:symbol/explain', handler: (c) => buildExplain(stockRow(c)) },
  {
    method: 'GET',
    pattern: '/api/stocks/:market/:symbol/chart',
    handler: (c) => buildChart(stockRow(c), barsParam(c.query)),
  },
  {
    method: 'GET',
    pattern: '/api/stocks/:market/:symbol/value',
    handler: (c) => buildValueView(stockRow(c), rateParam(c.query)),
  },
  { method: 'PUT', pattern: '/api/stocks/:market/:symbol/valuation', handler: putValuation },
  { method: 'GET', pattern: '/api/watchlist', handler: () => listWatchlist() },
  { method: 'GET', pattern: '/api/watchlist/board', handler: () => watchBoard() },
  {
    method: 'GET',
    pattern: '/api/watchlist/preview',
    handler: (c) => previewWatch(c.query.get('raw') ?? '', c.query.get('market')),
  },
  { method: 'POST', pattern: '/api/watchlist', handler: (c) => addWatch(c.body) },
  { method: 'POST', pattern: '/api/watchlist/bulk', handler: (c) => bulkWatch(c.body) },
  { method: 'POST', pattern: '/api/watchlist/paste', handler: (c) => pasteWatch(c.body) },
  {
    method: 'GET',
    pattern: '/api/watchlist/export.csv',
    handler: () => download('text/csv; charset=utf-8', exportCsv(), 'watchlist.csv'),
  },
  {
    method: 'PATCH',
    pattern: '/api/watchlist/:market/:symbol',
    handler: (c) => {
      const row = stockRow(c);
      return patchWatch(row.market, row.symbol, c.body);
    },
  },
  { method: 'GET', pattern: '/api/positions', handler: () => buildPositions() },
  { method: 'POST', pattern: '/api/positions', handler: (c) => addPosition(c.body) },
  {
    method: 'POST',
    pattern: '/api/positions/:id/close',
    handler: (c) => {
      const id = parseNum(c.params.id);
      if (!Number.isInteger(id)) throw notFound(`Position "${c.params.id}" does not exist.`);
      return closePosition(id, c.body);
    },
  },
  { method: 'POST', pattern: '/api/journal/import', handler: (c) => importJournal(c.body) },
  { method: 'GET', pattern: '/api/journal/entries', handler: (c) => listDiary(c.query) },
  { method: 'GET', pattern: '/api/journal/entries/:date', handler: (c) => getDiaryEntry(c.params.date) },
  { method: 'PUT', pattern: '/api/journal/entries/:date', handler: (c) => putDiaryEntry(c.params.date, c.body) },
  { method: 'DELETE', pattern: '/api/journal/entries/:date', handler: (c) => deleteDiaryEntry(c.params.date) },
  {
    method: 'POST',
    pattern: '/api/journal/entries/:date/close',
    handler: (c) => closeDiaryEntry(c.params.date, c.query.get('reopen') === '1' || c.query.get('reopen') === 'true'),
  },
  { method: 'POST', pattern: '/api/journal/entries/:date/undelete', handler: (c) => undeleteDiaryEntry(c.params.date) },
  { method: 'GET', pattern: '/api/journal/entries/:date/revisions', handler: (c) => diaryRevisions(c.params.date) },
  {
    method: 'POST',
    pattern: '/api/journal/entries/:date/revisions/:no/restore',
    handler: (c) => restoreDiaryRevision(c.params.date, c.params.no),
  },
  {
    method: 'GET',
    pattern: '/api/journal/entries/:date/export.md',
    handler: (c) => {
      const { filename, markdown } = diaryExport(c.params.date);
      return download('text/markdown; charset=utf-8', markdown, filename);
    },
  },
  { method: 'POST', pattern: '/api/journal/assets', handler: (c) => uploadAsset(c.body) },
  { method: 'GET', pattern: '/api/journal/assets/:id', handler: (c) => readAsset(c.params.id) },
  { method: 'POST', pattern: '/api/journal/entries/:date/ai', handler: (c) => startAi(c.params.date, c.body) },
  { method: 'GET', pattern: '/api/journal/entries/:date/ai', handler: (c) => latestAi(c.params.date) },
  { method: 'GET', pattern: '/api/journal/ai/:runId', handler: (c) => getAi(c.params.runId) },
  { method: 'POST', pattern: '/api/journal/ai/:runId/cancel', handler: (c) => cancelAi(c.params.runId) },
  { method: 'POST', pattern: '/api/journal/ai/:runId/accept', handler: (c) => acceptAi(c.params.runId) },
  { method: 'POST', pattern: '/api/journal/ai/:runId/reject', handler: (c) => rejectAi(c.params.runId) },
  { method: 'GET', pattern: '/api/journal/calendar', handler: (c) => diaryCalendar(c.query.get('month')) },
  { method: 'GET', pattern: '/api/journal/lessons', handler: (c) => diaryLessons(c.query.get('limit')) },
  { method: 'GET', pattern: '/api/settings', handler: () => getSettings() },
  { method: 'PUT', pattern: '/api/settings', handler: (c) => putSettings(c.body) },
  { method: 'GET', pattern: '/api/data/status', handler: () => buildDataStatus() },
  { method: 'POST', pattern: '/api/ingest', handler: (c) => startIngest(c.body) },
  { method: 'GET', pattern: '/api/ingest/:id', handler: (c) => getIngest(c.params.id) },
  { method: 'POST', pattern: '/api/chains/import', handler: (c) => importChain(c.body) },
  { method: 'POST', pattern: '/api/events', handler: (c) => addEvent(c.body) },
  { method: 'POST', pattern: '/api/fair-values/import', handler: (c) => importFairValues(c.body) },
  { method: 'GET', pattern: '/api/news', handler: (c) => buildNews(c.query) },
  { method: 'GET', pattern: '/api/news/days', handler: (c) => buildNewsDays(c.query) },
  { method: 'GET', pattern: '/api/news/search', handler: (c) => searchNews(c.query) },
  { method: 'GET', pattern: '/api/news/brief', handler: (c) => newsBriefs(c.query) },
  { method: 'POST', pattern: '/api/news/refresh', handler: () => refreshNews() },
  { method: 'GET', pattern: '/api/leaders', handler: (c) => buildLeaders(c.query) },
  { method: 'GET', pattern: '/api/leaders/days', handler: (c) => buildLeadersDays(c.query) },
  { method: 'GET', pattern: '/api/leaders/record', handler: (c) => buildLeadersRecord(c.query) },
  { method: 'POST', pattern: '/api/leaders/refresh', handler: () => refreshLeaders() },
  { method: 'POST', pattern: '/api/leaders/candidates/:id/mute', handler: (c) => muteLeader(c.params.id, c.body) },
  { method: 'DELETE', pattern: '/api/leaders/candidates/:id/mute', handler: (c) => unmuteLeader(c.params.id) },
  { method: 'POST', pattern: '/api/leaders/candidates/:id/watch', handler: (c) => watchLeader(c.params.id) },
  {
    method: 'GET',
    pattern: '/api/reminders',
    handler: (c) =>
      buildMockReminders(undefined, Math.min(90, Math.max(1, Number.parseInt(c.query.get('days') ?? '30', 10)))),
  },
  { method: 'GET', pattern: '/api/skills', handler: () => skillCatalog() },
  { method: 'POST', pattern: '/api/ask', handler: (c) => askStart(c.body) },
  { method: 'GET', pattern: '/api/ask', handler: (c) => askThread(c.query) },
  { method: 'GET', pattern: '/api/ask/:id', handler: (c) => askGet(c.params.id) },
  { method: 'POST', pattern: '/api/research/runs', handler: (c) => startRuns(c.body) },
  {
    method: 'GET',
    pattern: '/api/research/runs',
    handler: (c) => listRuns(c.query.get('market'), c.query.get('symbol')),
  },
  { method: 'GET', pattern: '/api/research/runs/:id', handler: (c) => getRun(c.params.id) },
  { method: 'POST', pattern: '/api/research/runs/:id/cancel', handler: (c) => cancelRun(c.params.id) },
  {
    method: 'GET',
    pattern: '/api/research/runs/:id/report.md',
    handler: (c) => {
      const { filename, markdown } = runReportMd(c.params.id);
      return download('text/markdown; charset=utf-8', markdown, filename);
    },
  },
  // Phase 3/4 screens: the mock has no price history to replay, so these answer "nothing yet" instead of a 404.
  { method: 'GET', pattern: '/api/lots', handler: () => [] },
  {
    method: 'POST',
    pattern: '/api/lots/:id/sell',
    handler: (c) => {
      throw notFound(`Lot ${c.params.id} not found (the mock holds no lots).`);
    },
  },
  { method: 'GET', pattern: '/api/backtests', handler: () => [] },
  {
    method: 'GET',
    pattern: '/api/backtests/:id',
    handler: (c) => {
      throw notFound(`Backtest ${c.params.id} not found (the mock runs none).`);
    },
  },
  {
    method: 'POST',
    pattern: '/api/backtests',
    handler: () => {
      throw invalid('The mock server has no price history to replay: run the real server to backtest.');
    },
  },
  {
    method: 'GET',
    pattern: '/api/stocks/:market/:symbol/studies',
    handler: (c) => {
      const row = stockRow(c);
      return { market: row.market, symbol: row.symbol, bars: 0, from: null, to: null, rules: [] };
    },
  },
];

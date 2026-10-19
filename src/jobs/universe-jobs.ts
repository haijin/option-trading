/**
 * The Leaders universe jobs (docs/designs/leaders-pullback.md, "Jobs and schedule"):
 *
 *   universe-refresh      Sat 08:30 HKT   constituent lists, new instrument rows, `removed_at` stamps
 *   ingest-universe-hk    17:45 HKT       bars for HK universe names that are not on the watchlist
 *   ingest-universe-us    17:45 New York  same for US
 *
 * Same conventions as the other jobs: a plain async function over `JobDeps`, one `job_runs` row per run, a throw
 * becomes a `failed` row. Registration lives in scheduler.ts.
 */
import { join } from 'node:path';
import { isTradingDay, lastTradingDayOnOrBefore, type Market } from '../core/calendar';
import { addDays, type ISODate } from '../core/dates';
import type { Db } from '../db/client';
import {
  INDEX_CODES,
  INDEX_MARKET,
  type IndexCode,
  type SyncResult,
  syncUniverse,
  type UniverseMember,
} from '../db/universe';
import { fetchUniverse, parseUniverseSeed, SEED_FILES } from '../providers/universe';
import { ingestUniverseBars } from '../providers/universe/ingest';
import { YahooClient } from '../providers/yahoo/client';
import { dateInMarketTz, type JobDeps, type JobOutcome, recorded } from './jobs';

const MARKETS: Market[] = ['US', 'HK'];
const INDEXES_OF: Record<Market, IndexCode[]> = {
  US: INDEX_CODES.filter((c) => INDEX_MARKET[c] === 'US'),
  HK: INDEX_CODES.filter((c) => INDEX_MARKET[c] === 'HK'),
};

/** Minutes after local midnight at which the session of the market counts as complete: close (16:00) plus 30 minutes. */
const SESSION_COMPLETE_MINUTES = 16 * 60 + 30;

const MARKET_TZ: Record<Market, string> = { US: 'America/New_York', HK: 'Asia/Hong_Kong' };

function localMinutes(now: Date, market: Market): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: MARKET_TZ[market],
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return Number(parts.hour) * 60 + Number(parts.minute);
}

/**
 * The last session of the market that is complete at `now`: the latest trading day on or before the market's local
 * date, or the one before it when the local time is not yet past the close plus 30 minutes.
 */
export function lastCompletedSession(now: Date, market: Market): ISODate {
  const local = dateInMarketTz(now, market);
  if (isTradingDay(market, local) && localMinutes(now, market) < SESSION_COMPLETE_MINUTES)
    return lastTradingDayOnOrBefore(market, addDays(local, -1));
  return lastTradingDayOnOrBefore(market, local);
}

const sample = (list: string[], n = 20): string =>
  list.length <= n ? list.join(', ') : `${list.slice(0, n).join(', ')} and ${list.length - n} more`;

// ------------------------------------------------------------------------------------------------------ seed
async function readSeedFile(
  readFile: (path: string) => Promise<string>,
  dir: string,
  market: Market,
): Promise<UniverseMember[] | null> {
  try {
    return parseUniverseSeed(await readFile(join(dir, SEED_FILES[market])));
  } catch {
    return null;
  }
}

export interface SeedOutcome {
  /** Seed files that were found (and how many memberships each holds). */
  files: { market: Market; file: string; members: number }[];
  /** Seed files that could not be read. */
  missing: string[];
  sync: SyncResult;
}

/**
 * Syncs the universe from data/universe-us.csv and data/universe-hk.csv without any network (a fresh database, or a
 * refresh whose sources are down). Add-only: a seed can be older than the database, so it never stamps a removal.
 */
export async function seedUniverse(
  db: Db,
  dataDir: string,
  readFile: (path: string) => Promise<string>,
  today: ISODate,
): Promise<SeedOutcome> {
  const members: UniverseMember[] = [];
  const files: SeedOutcome['files'] = [];
  const missing: string[] = [];
  for (const market of MARKETS) {
    const rows = await readSeedFile(readFile, dataDir, market);
    if (rows === null) missing.push(SEED_FILES[market]);
    else {
      members.push(...rows);
      files.push({ market, file: SEED_FILES[market], members: rows.length });
    }
  }
  const sync = await syncUniverse(db, members, today, { reconcile: [] });
  return { files, missing, sync };
}

// -------------------------------------------------------------------------------------------------- refresh
/**
 * Fetches the constituent lists with the context's live fetch and syncs them. An index whose live source fails falls
 * back to the seed CSV for that index (adds only: its removals are not evaluated this run), and the detail line says
 * which. More than 10% of a market's memberships dropping out in one run is flagged and nothing is removed.
 */
export async function runUniverseRefreshJob(deps: JobDeps): Promise<JobOutcome> {
  const { ctx } = deps;
  return recorded(deps, 'universe-refresh', {}, async () => {
    const db = ctx.db().db;
    const now = ctx.now();
    const fetched = await fetchUniverse(ctx.fetch, { asOf: dateInMarketTz(now, 'HK') });
    const parts: string[] = [];
    let rows = 0;
    let degraded = false;
    let synced = 0;
    let warnings = 0;

    for (const market of MARKETS) {
      const sources = fetched.sources.filter((s) => INDEX_MARKET[s.indexCode] === market);
      const failed = sources.filter((s) => !s.ok);
      let members = fetched.members.filter((m) => m.market === market);

      let seed: UniverseMember[] | null = null;
      if (failed.length > 0 || (market === 'HK' && !fetched.lots.ok)) {
        seed = await readSeedFile((p) => ctx.readFile(p), ctx.dataDir, market);
        degraded = true;
      }
      if (failed.length > 0) {
        const codes = failed.map((s) => s.indexCode);
        for (const s of failed) deps.log(`universe-refresh: ${s.indexCode} live source failed (${s.error})`);
        if (seed) {
          members = [...members, ...seed.filter((m) => codes.includes(m.indexCode))];
          deps.log(`universe-refresh: ${codes.join(', ')} taken from ${SEED_FILES[market]} (add-only, no removals)`);
        } else
          deps.log(`universe-refresh: ${codes.join(', ')}: no seed file ${SEED_FILES[market]}, index left as it is`);
      }
      if (market === 'HK' && !fetched.lots.ok) {
        deps.log(
          `universe-refresh: HKEX stock lots unavailable (${fetched.lots.error}); using the seed's lots where it has them`,
        );
        const lots = new Map((seed ?? []).filter((m) => m.stockLot).map((m) => [m.symbol, m.stockLot as number]));
        members = members.map((m) => (m.stockLot || !lots.has(m.symbol) ? m : { ...m, stockLot: lots.get(m.symbol) }));
      }
      for (const s of sources)
        for (const w of s.warnings) {
          warnings++;
          deps.log(`universe-refresh: ${w}`);
        }
      if (members.length === 0) {
        parts.push(`${market}: no data`);
        continue;
      }
      const reconcile = INDEXES_OF[market].filter((c) => sources.some((s) => s.indexCode === c && s.ok));
      const res = await syncUniverse(db, members, dateInMarketTz(now, market), { reconcile });
      rows += res.added + res.reactivated + res.removed;
      synced += res.instruments;
      for (const [what, list] of Object.entries(res.changes))
        if (list.length > 0) deps.log(`universe-refresh: ${market} ${what}: ${sample(list)}`);
      for (const f of res.flagged) {
        degraded = true;
        deps.log(
          `universe-refresh: FLAG ${f.market}: ${f.wouldRemove} of ${f.of} memberships would be removed (more than 10%), removals skipped; check the source format (would remove: ${sample(f.names)})`,
        );
      }
      const counts = sources.map((s) => `${s.indexCode} ${s.ok ? s.count : 'FAILED'}`).join(', ');
      parts.push(
        `${market} ${counts}: +${res.added} added, ${res.reactivated} reactivated, ${res.removed} removed${res.flagged.length ? ', FLAGGED' : ''}`,
      );
    }
    if (fetched.members.length === 0 && fetched.sources.every((s) => !s.ok) && fetched.sources.length > 0)
      return { status: 'failed', rows, detail: `every live source failed; ${parts.join('; ')}` };
    return {
      status: degraded ? 'partial' : 'ok',
      rows,
      detail: `${synced} names; ${parts.join('; ')}${warnings ? ` (${warnings} source note${warnings === 1 ? '' : 's'} in the log)` : ''}`,
    };
  });
}

// -------------------------------------------------------------------------------------------------- ingest
/**
 * Bars for the market's universe names that are not on the watchlist, as of the last completed session (default: see
 * `lastCompletedSession`). A warm run makes no HTTP call.
 */
export async function runUniverseIngestJob(
  deps: JobDeps,
  opts: { market: Market; asOf?: ISODate },
): Promise<JobOutcome> {
  const { ctx } = deps;
  const asOf = opts.asOf ?? lastCompletedSession(ctx.now(), opts.market);
  return recorded(deps, `ingest-universe-${opts.market.toLowerCase()}`, { asOf }, async () => {
    const res = await ingestUniverseBars(
      { db: ctx.db().db, client: new YahooClient({ fetch: ctx.fetch }), now: ctx.now(), log: deps.log },
      { market: opts.market, asOf },
    );
    if (res.names === 0)
      return {
        status: 'ok',
        rows: 0,
        detail: `no ${opts.market} universe names (run universe-refresh or seed the universe)`,
      };
    const attempted = res.fetched + res.failed + res.notFound;
    const sample = res.failures.slice(0, 3).join(' | ');
    return {
      status: res.failed === 0 ? 'ok' : res.fetched === 0 && attempted > 0 ? 'failed' : 'partial',
      rows: res.rows,
      detail: `${asOf}: ${res.names} names, ${res.fetched} fetched, ${res.skipped} up to date, ${res.failed} failed, ${res.notFound} not found, ${res.rows} rows${sample ? `; failed: ${sample}` : ''}`,
    };
  });
}

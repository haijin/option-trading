/**
 * `pnpm cli ingest --all`: the only code that fetches from providers. Every step is isolated (one failing symbol never
 * aborts the run), every write goes through the db writers (which invalidate cached skill results), and the outcome of
 * each step is returned for the CLI to print and for `job_runs`.
 */
import { join } from 'node:path';
import { INDEX_SPECS } from '../core/benchmarks';
import { addDays, type ISODate, toISO } from '../core/dates';
import { FX_PAIRS, FX_YAHOO, type FxPair } from '../core/fx';
import { yahooSymbol } from '../core/symbols';
import type { Instrument, OptionChainSnapshot, SolvencyModel } from '../core/types';
import type { Db } from '../db/client';
import {
  findInstrument,
  finishJob,
  lastBarDay,
  listWatchlist,
  loadParams,
  startJob,
  upsertInstrument,
} from '../db/repos';
import {
  type WriteResult,
  writeBars,
  writeCorporateEvents,
  writeFundamentals,
  writeFxRates,
  writeIvDaily,
  writeIvHistory,
  writeOptionChain,
} from '../db/writers';
import { iv30, skew25d } from '../indicators/chain-iv';
import type { FutuSource } from './futu';
import { parseIndexCsv } from './seed-files';
import { fetchStooqBars } from './stooq';
import { ProviderError, type YahooClient } from './yahoo/client';
import {
  buildYahooSnapshot,
  expiryOf,
  localDate,
  MARKET_TZ,
  normalizeCalendar,
  normalizeChartBars,
  normalizeStatementRow,
  selectExpiries,
  toDate,
} from './yahoo/normalize';

export type IngestStep = 'fx' | 'indices' | 'profile' | 'bars' | 'fundamentals' | 'events' | 'chains' | 'volatility';
export const ALL_STEPS: IngestStep[] = [
  'fx',
  'indices',
  'profile',
  'bars',
  'fundamentals',
  'events',
  'chains',
  'volatility',
];

/** Every chain source fetches at least this DTE window, so IV30 (interpolated around 30 days) is always computable. */
export const CHAIN_DTE_MIN = 14;
export const CHAIN_DTE_MAX_FLOOR = 75;
/** How far back the OpenD IV history backfill reaches: enough for a one-year IV rank with margin. */
export const IV_HISTORY_DAYS = 400;

export interface IngestDeps {
  db: Db;
  client: YahooClient;
  /**
   * Optional moomoo OpenD source. When present it is the first source for HK bars and chains and the only source of
   * the HK IV-history backfill; Yahoo and Stooq remain the fallbacks for bars.
   */
  futu?: Pick<FutuSource, 'putChain' | 'dailyBars' | 'ivHistory' | 'staticInfo'>;
  fetch: typeof fetch;
  now: Date;
  dataDir: string;
  readFile(path: string): Promise<string>;
  fileExists(path: string): Promise<boolean>;
  log(line: string): void;
  /** Called after every finished step, so a UI can show progress while a long run is still going. */
  onItem?(item: IngestItem): void;
}

export interface IngestOptions {
  steps?: IngestStep[];
  /** Restrict to these watchlist symbols (canonical). */
  only?: string[];
  /** Process exactly these instruments instead of the watchlist (one-name fetches, for example a Leaders name's statements). */
  names?: Instrument[];
  years?: number;
}

export interface IngestItem {
  target: string;
  step: IngestStep;
  status: 'ok' | 'failed' | 'skipped';
  detail: string;
}

export interface IngestSummary {
  items: IngestItem[];
  rowsWritten: number;
  failed: number;
}

const FUNDAMENTALS_FROM = '2014-01-01';

function rowsOf(r: WriteResult): number {
  return r.inserted + r.updated;
}

export function inferSolvency(sector: string | null, industry: string | null): SolvencyModel {
  const s = (sector ?? '').toLowerCase();
  const i = (industry ?? '').toLowerCase();
  if (i.includes('bank') || i.includes('insurance')) return 'financial';
  if (s.includes('real estate')) return i.includes('reit') ? 'reit' : 'property';
  return 'altman';
}

function yahooSymbolOf(inst: Instrument): string {
  const given = inst.providerSymbols.yahoo;
  return typeof given === 'string' && given ? given : yahooSymbol(inst.market, inst.symbol);
}

/** Writes a chain and its IV30 / skew day row. Shared by every chain source. */
async function persistChain(
  deps: IngestDeps,
  instId: number,
  snap: OptionChainSnapshot,
  rf: number,
): Promise<{ rows: number; iv: ReturnType<typeof iv30> }> {
  const wr = await writeOptionChain(deps.db, instId, snap, deps.now);
  const iv = iv30(snap, rf);
  if (iv) {
    await writeIvDaily(deps.db, instId, {
      day: snap.snapshotDate,
      iv30: iv.iv30,
      iv60: iv.iv60,
      skew25d: skew25d(snap, rf),
      termRatio: iv.termRatio,
      tier: 'real',
    });
  }
  return { rows: rowsOf(wr), iv };
}

export async function runIngest(deps: IngestDeps, opts: IngestOptions = {}): Promise<IngestSummary> {
  const steps = new Set(opts.steps ?? ALL_STEPS);
  const items: IngestItem[] = [];
  const record = (item: IngestItem): void => {
    items.push(item);
    deps.onItem?.(item);
  };
  let rowsWritten = 0;
  const today = toISO(deps.now);
  const tomorrow = addDays(today, 1);
  const from = addDays(today, -Math.round((opts.years ?? 10) * 365.25));
  const jobId = await startJob(deps.db, 'ingest', { steps: [...steps], asOf: today });

  async function step(
    target: string,
    name: IngestStep,
    fn: () => Promise<{ rows: number; detail: string }>,
  ): Promise<void> {
    try {
      const r = await fn();
      rowsWritten += r.rows;
      record({ target, step: name, status: 'ok', detail: r.detail });
    } catch (err) {
      const msg = err instanceof ProviderError ? err.message : `${target}: ${(err as Error).message}`;
      record({ target, step: name, status: 'failed', detail: msg });
    }
  }

  // ------------------------------------------------------------------ FX
  if (steps.has('fx')) {
    for (const pair of FX_PAIRS) {
      await step(pair, 'fx', async () => {
        const raw = await deps.client.chart(FX_YAHOO[pair as FxPair], from, tomorrow);
        const bars = normalizeChartBars(raw, 'yahoo');
        if (bars.length === 0) throw new ProviderError('yahoo', pair, 'no FX bars returned');
        const w = await writeFxRates(
          deps.db,
          bars.map((b) => ({ day: b.day, pair, rate: b.close, source: 'yahoo' })),
        );
        return {
          rows: rowsOf(w),
          detail: `${bars.length} days, ${rowsOf(w)} written${w.invalidated ? `, ${w.invalidated} cached results dropped` : ''}`,
        };
      });
    }
  }

  // --------------------------------------------------- index / vol-index bars
  if (steps.has('indices')) {
    for (const spec of INDEX_SPECS) {
      const inst = await findInstrument(deps.db, spec.market, spec.symbol);
      if (!inst) continue;
      const label = `${spec.symbol} (${spec.market})`;
      if (spec.yahoo) {
        await step(label, 'indices', async () => {
          const bars = normalizeChartBars(await deps.client.chart(spec.yahoo as string, from, tomorrow), 'yahoo');
          if (bars.length === 0) throw new ProviderError('yahoo', spec.symbol, 'no bars returned');
          const w = await writeBars(deps.db, inst.id, bars);
          return { rows: rowsOf(w), detail: `${bars.length} bars, ${rowsOf(w)} written` };
        });
      } else {
        const file = join(deps.dataDir, `${spec.symbol.toLowerCase()}.csv`);
        if (await deps.fileExists(file)) {
          await step(label, 'indices', async () => {
            const bars = parseIndexCsv(await deps.readFile(file), 'csv');
            const w = await writeBars(deps.db, inst.id, bars);
            return {
              rows: rowsOf(w),
              detail: `${bars.length} bars from ${spec.symbol.toLowerCase()}.csv, ${rowsOf(w)} written`,
            };
          });
        } else {
          record({
            target: label,
            step: 'indices',
            status: 'skipped',
            detail: `no Yahoo history and no data/${spec.symbol.toLowerCase()}.csv: ${spec.market} regime runs without a vol index (regime.noVolIndex)`,
          });
        }
      }
    }
  }

  // ------------------------------------------------------- watchlist names
  const watch: Instrument[] =
    opts.names ?? (await listWatchlist(deps.db)).filter((w) => !opts.only || opts.only.includes(w.symbol));
  const params = (await loadParams(deps.db)).params;

  for (const w of watch) {
    const label = `${w.symbol} (${w.market})`;
    let inst: Instrument = w;
    const ysym = yahooSymbolOf(inst);

    if (steps.has('profile')) {
      await step(label, 'profile', async () => {
        const p = await deps.client.profile(ysym);
        const ps = { ...inst.providerSymbols };
        if (p.financialCurrency) ps.financialCurrency = p.financialCurrency;
        const userSolvency = ps.solvencySource === 'user';
        if (!userSolvency) ps.solvencySource = 'inferred';
        inst = await upsertInstrument(deps.db, {
          market: inst.market,
          symbol: inst.symbol,
          name: p.name ?? inst.name,
          sector: p.sector ?? inst.sector,
          industry: p.industry ?? inst.industry,
          providerSymbols: ps,
          ...(userSolvency ? {} : { solvencyModel: inferSolvency(p.sector, p.industry) }),
        });
        let futuNote = '';
        if (inst.market === 'HK' && deps.futu) {
          // OpenD knows the listed name and the stock board lot; it fills a name Yahoo lacks and is reported for a
          // by-eye check. It never writes board_lot: the HK multiplier is the option contract size, which can differ.
          const [info] = await deps.futu.staticInfo([inst]).catch(() => []);
          if (info) {
            if (!inst.name && info.name) {
              inst = await upsertInstrument(deps.db, { market: inst.market, symbol: inst.symbol, name: info.name });
            }
            futuNote = ` | futu: ${info.name}, stock lot ${info.lotSize}${info.delisting ? ', DELISTING' : ''}`;
          }
        }
        return {
          rows: 0,
          detail: `${p.name ?? '?'} | ${p.sector ?? '?'} | statements in ${p.financialCurrency ?? '?'} | solvency ${inst.solvencyModel}${futuNote}`,
        };
      });
    }

    if (steps.has('bars')) {
      await step(label, 'bars', async () => {
        // HK: the broker's own daily bars first (raw OHLC plus forward-adjusted close), Yahoo if OpenD is down.
        let futuErr: Error | null = null;
        if (inst.market === 'HK' && deps.futu) {
          try {
            const bars = await deps.futu.dailyBars(inst, from, today);
            const wr = await writeBars(deps.db, inst.id, bars);
            return {
              rows: rowsOf(wr),
              detail: `futu OpenD: ${bars.length} bars to ${bars[bars.length - 1]?.day}, ${wr.inserted} new, ${wr.updated} restated${wr.invalidated ? `, ${wr.invalidated} cached results dropped` : ''}`,
            };
          } catch (err) {
            futuErr = err as Error;
          }
        }
        const prefix = futuErr ? `futu failed (${futuErr.message}); ` : '';
        try {
          const bars = normalizeChartBars(await deps.client.chart(ysym, from, tomorrow), 'yahoo');
          if (bars.length === 0) throw new ProviderError('yahoo', inst.symbol, 'no bars returned', 'not_found');
          const wr = await writeBars(deps.db, inst.id, bars);
          return {
            rows: rowsOf(wr),
            detail: `${prefix}yahoo: ${bars.length} bars to ${bars[bars.length - 1]?.day}, ${wr.inserted} new, ${wr.updated} restated${wr.invalidated ? `, ${wr.invalidated} cached results dropped` : ''}`,
          };
        } catch (yahooErr) {
          // Fallback: Stooq, appended after the stored history only (it has no adjusted close).
          const last = await lastBarDay(deps.db, inst.id);
          try {
            const sb = await fetchStooqBars(deps.fetch, inst.market, inst.symbol, last ?? from, tomorrow);
            const fresh = sb.filter((b) => !last || b.day > last);
            const wr = await writeBars(deps.db, inst.id, fresh);
            return {
              rows: rowsOf(wr),
              detail: `${prefix}yahoo failed (${(yahooErr as Error).message}); stooq fallback appended ${fresh.length} bars`,
            };
          } catch (stooqErr) {
            throw new ProviderError(
              'ingest',
              inst.symbol,
              `no bar source worked: ${prefix}${(yahooErr as Error).message}; ${(stooqErr as Error).message}`,
            );
          }
        }
      });
    }

    if (steps.has('fundamentals')) {
      await step(label, 'fundamentals', async () => {
        const ccy =
          typeof inst.providerSymbols.financialCurrency === 'string'
            ? inst.providerSymbols.financialCurrency
            : inst.currency;
        let rows = 0;
        const parts: string[] = [];
        for (const type of ['annual', 'quarterly'] as const) {
          const raw = await deps.client.fundamentals(ysym, type, FUNDAMENTALS_FROM);
          const statements = raw.map((r) => normalizeStatementRow(r, { currency: ccy })).filter((s) => s !== null);
          const wr = await writeFundamentals(deps.db, inst.id, inst.market, statements, deps.now);
          rows += rowsOf(wr);
          parts.push(`${type} ${statements.length} (${rowsOf(wr)} written)`);
        }
        return { rows, detail: `${parts.join(', ')} in ${ccy}` };
      });
    }

    if (steps.has('events')) {
      await step(label, 'events', async () => {
        const cal = normalizeCalendar(await deps.client.calendar(ysym), inst.market);
        const events = [
          ...cal.earnings.map((e) => ({
            type: 'earnings' as const,
            date: e.date,
            confirmed: e.confirmed,
            source: 'yahoo',
          })),
          ...(cal.exDividend
            ? [{ type: 'ex_dividend' as const, date: cal.exDividend, confirmed: true, source: 'yahoo' }]
            : []),
        ];
        const wr = await writeCorporateEvents(deps.db, inst.id, events, deps.now, {
          supersede: { source: 'yahoo', types: ['earnings'], fromDate: today },
        });
        return {
          rows: rowsOf(wr),
          detail: `${cal.earnings[0] ? `next earnings ${cal.earnings[0].date}${cal.earnings[0].confirmed ? '' : ' (estimate)'}` : 'no earnings date from Yahoo'}`,
        };
      });
    }

    // The stored chain must cover the strategy's own DTE window (HK goes out to six months) and the IV30 bracket.
    const dteMax = Math.max(CHAIN_DTE_MAX_FLOOR, params['option.select'].dteMax[inst.market]);

    if (steps.has('chains') && inst.market === 'HK' && inst.hasListedOptions && deps.futu) {
      const futu = deps.futu;
      await step(label, 'chains', async () => {
        const snap = await futu.putChain(inst, { now: deps.now, minDte: CHAIN_DTE_MIN, maxDte: dteMax });
        const { rows, iv } = await persistChain(deps, inst.id, snap, params['option.select'].riskFreeHK);
        const expiries = new Set(snap.quotes.map((q) => q.expiry)).size;
        return {
          rows,
          detail: `futu OpenD: ${snap.quotes.length} puts over ${expiries} expiries to ${dteMax}d @ ${snap.snapshotDate}${iv ? `, IV30 ${(iv.iv30 * 100).toFixed(1)}%` : ', no IV30'}`,
        };
      });
    } else if (steps.has('chains')) {
      if (inst.market === 'HK' || !inst.hasListedOptions) {
        record({
          target: label,
          step: 'chains',
          status: 'skipped',
          detail:
            inst.market === 'HK' ? 'no free HK chain source: use `chain import` (CSV paste)' : 'no listed options',
        });
      } else {
        await step(label, 'chains', async () => {
          const head = await deps.client.options(ysym);
          const underlying = Number(head.underlyingPrice);
          const quoteTime = toDate(head.underlyingTime);
          if (!Number.isFinite(underlying) || underlying <= 0 || !quoteTime) {
            throw new ProviderError('yahoo', inst.symbol, 'options response has no underlying price');
          }
          const snapshotDate = localDate(quoteTime, MARKET_TZ[inst.market]);
          const expiries = selectExpiries(head.expirationDates, snapshotDate, CHAIN_DTE_MIN, dteMax);
          const puts: { expiry: ISODate; row: (typeof head.puts)[number] }[] = [];
          for (const e of expiries) {
            const r = await deps.client.options(ysym, e);
            const expiry = expiryOf(r);
            if (!expiry) continue;
            for (const row of r.puts) puts.push({ expiry, row });
          }
          const snap = buildYahooSnapshot({ underlyingPrice: underlying, snapshotDate, puts }, inst.multiplier);
          if (snap.quotes.length === 0) throw new ProviderError('yahoo', inst.symbol, 'no usable put quotes');
          const { rows, iv } = await persistChain(deps, inst.id, snap, params['option.select'].riskFreeUS);
          return {
            rows,
            detail: `${snap.quotes.length} puts over ${expiries.length} expiries @ ${snapshotDate}${iv ? `, IV30 ${(iv.iv30 * 100).toFixed(1)}%` : ', no IV30'}`,
          };
        });
      }
    }

    // OpenD's IV history for the underlying backfills iv_daily where the app has no row of its own, so S3 ranks
    // today's IV against a real year instead of the vol-index proxy. Silent without OpenD: there is no other source.
    if (steps.has('volatility') && inst.market === 'HK' && inst.hasListedOptions && deps.futu) {
      const futu = deps.futu;
      await step(label, 'volatility', async () => {
        const points = await futu.ivHistory(inst, addDays(today, -IV_HISTORY_DAYS), today);
        const wr = await writeIvHistory(
          deps.db,
          inst.id,
          points.map((p) => ({ day: p.day, iv30: p.iv, tier: 'real' as const })),
        );
        const last = points[points.length - 1];
        return {
          rows: rowsOf(wr),
          detail: `futu OpenD: ${points.length} IV days to ${last?.day} (${last ? (last.iv * 100).toFixed(1) : '?'}%), ${wr.inserted} new, ${wr.unchanged} already stored${wr.invalidated ? `, ${wr.invalidated} cached results dropped` : ''}`,
        };
      });
    }
  }

  const failed = items.filter((i) => i.status === 'failed').length;
  await finishJob(deps.db, jobId, {
    status: failed === 0 ? 'ok' : failed === items.filter((i) => i.status !== 'skipped').length ? 'failed' : 'partial',
    rowsWritten,
    error: failed
      ? items
          .filter((i) => i.status === 'failed')
          .map((i) => i.detail)
          .join(' | ')
          .slice(0, 2000)
      : null,
    meta: { items: items.length, failed },
  });
  return { items, rowsWritten, failed };
}

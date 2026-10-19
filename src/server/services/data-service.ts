import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { defaultAsOf } from '../../cli/asof';
import { canonicalSymbol } from '../../core/symbols';
import { dataStatusFor, lastJob, listWatchlistAll, upsertFairValue } from '../../db/app-repos';
import { findInstrument, loadParams } from '../../db/repos';
import { writeCorporateEvents } from '../../db/writers';
import { readCsv } from '../../providers/csv/read';
import { importChain } from '../../providers/csv/store';
import { futuFromEnv } from '../../providers/futu';
import { runIngest } from '../../providers/ingest';
import { YahooClient } from '../../providers/yahoo/client';
import type {
  ChainImportInput,
  ChainImportView,
  DataStatusRow,
  DataStatusView,
  EventAddInput,
  FairValueImportInput,
  FairValueImportView,
  IngestJobView,
  IngestStartInput,
  IngestSummaryView,
  ProviderStatusView,
} from '../api-types';
import type { ServerDeps } from '../deps';
import { badRequest, conflict, notFound } from '../errors';
import type { ScanService } from './scan-service';
import type { AppState } from './state';
import type { ValueService } from './value-service';
import { parseMarketSymbol, type WatchService } from './watch-service';

export class DataService {
  private readonly jobs = new Map<string, IngestJobView>();
  private currentId: string | null = null;
  private lastDone: IngestJobView | null = null;

  constructor(
    private readonly deps: ServerDeps,
    private readonly state: AppState,
    private readonly scan: ScanService,
    private readonly watch: WatchService,
    private readonly values: () => ValueService,
  ) {}

  // ------------------------------------------------------------------------------------------ ingest
  async startIngest(input: IngestStartInput): Promise<IngestJobView> {
    if (this.currentId)
      throw conflict('ingest_running', 'an ingest is already running: wait for it to finish', { id: this.currentId });
    const all = await listWatchlistAll(this.deps.db);
    const paused = all.filter((w) => !w.active).map((w) => w.symbol);
    const only = input.only?.map((k) => canonicalSymbol(k.market, k.symbol));
    if (input.only && input.only.length === 0) throw badRequest('nothing_selected', 'no stocks selected');
    const job: IngestJobView = {
      id: randomUUID(),
      status: 'running',
      startedAt: this.deps.now().toISOString(),
      finishedAt: null,
      scope: input.only ?? 'all',
      log: [
        `watchlist: ${all.length - paused.length} watched, ${paused.length} paused${paused.length ? ` (skipped: ${paused.join(', ')})` : ''}`,
      ],
      items: [],
      summary: null,
      error: null,
      pausedSkipped: paused,
    };
    this.jobs.set(job.id, job);
    this.currentId = job.id;
    void this.run(job, only);
    return job;
  }

  private async run(job: IngestJobView, only?: string[]): Promise<void> {
    try {
      const futu = futuFromEnv(process.env);
      const summary = await runIngest(
        {
          db: this.deps.db,
          client: new YahooClient({ fetch: this.deps.fetch }),
          futu: futu ?? undefined,
          fetch: this.deps.fetch,
          now: this.deps.now(),
          dataDir: this.deps.dataDir,
          readFile: (p) => this.deps.readFile(p),
          fileExists: (p) => this.deps.fileExists(p),
          log: (l) => job.log.push(l),
          onItem: (i) => {
            job.items.push(i);
            job.log.push(
              `${i.status === 'ok' ? 'ok     ' : i.status === 'skipped' ? 'skipped' : 'FAILED '} ${i.target.padEnd(14)} ${i.step.padEnd(12)} ${i.detail}`,
            );
          },
        },
        { ...(only ? { only } : {}) },
      ).finally(() => futu?.close());
      const ok = summary.items.filter((i) => i.status === 'ok').length;
      const skipped = summary.items.filter((i) => i.status === 'skipped').length;
      job.summary = { ok, failed: summary.failed, skipped, rows: summary.rowsWritten };
      job.log.push(
        `ingest finished: ${ok} ok, ${summary.failed} failed, ${skipped} skipped; ${summary.rowsWritten} rows written`,
      );
      job.status = 'done';
    } catch (err) {
      job.status = 'failed';
      job.error = (err as Error).message;
      job.log.push(`ingest aborted: ${job.error}`);
    } finally {
      job.finishedAt = this.deps.now().toISOString();
      this.currentId = null;
      this.lastDone = job;
      this.state.bump();
    }
  }

  getJob(id: string): IngestJobView {
    const j = this.jobs.get(id);
    if (!j) throw notFound(`no ingest job ${id}`);
    return j;
  }

  /** Summary of the most recent ingest: from memory when this process ran one, else from the job log table. */
  async lastIngestSummary(): Promise<IngestSummaryView | null> {
    if (this.lastDone?.summary)
      return { at: this.lastDone.finishedAt ?? this.lastDone.startedAt, ...this.lastDone.summary };
    const j = await lastJob(this.deps.db, 'ingest');
    if (!j?.finishedAt) return null;
    const meta = j.meta as { items?: number; failed?: number } | null;
    const items = meta?.items ?? 0;
    const failed = meta?.failed ?? 0;
    return {
      at: j.finishedAt.toISOString(),
      ok: Math.max(0, items - failed),
      failed,
      skipped: 0,
      rows: j.rowsWritten ?? 0,
    };
  }

  // ------------------------------------------------------------------------------------------ status
  async status(): Promise<DataStatusView> {
    const rows = (await listWatchlistAll(this.deps.db)).filter((r) => r.active);
    const asOf = defaultAsOf(this.deps.now());
    const raw = await dataStatusFor(
      this.deps.db,
      rows.map((r) => r.id),
      asOf,
    );
    const entries = new Map((await this.watch.list()).map((e) => [`${e.market}|${e.symbol}`, e]));
    const scan = this.scan.peek();
    const stale = new Set(
      scan?.rejected.filter((r) => r.status === 'dropped_stale').map((r) => `${r.market}|${r.symbol}`),
    );
    const badges = await this.values().badgesForWatchlist(rows.map((r) => r.id));
    const names: DataStatusRow[] = rows.map((r) => {
      const d = raw.get(r.id);
      const e = entries.get(`${r.market}|${r.symbol}`);
      return {
        symbol: r.symbol,
        market: r.market,
        name: r.name,
        lastBar: d?.lastBar ?? null,
        lastClose: d?.lastClose ?? null,
        chain: d?.chain ?? null,
        nextEarnings: d?.nextEarnings ?? null,
        fundamentals: { annual: d?.annual ?? 0, quarterly: d?.quarterly ?? 0, lastPeriodEnd: d?.lastPeriodEnd ?? null },
        stale: stale.has(`${r.market}|${r.symbol}`),
        priceVsIv: badges.get(r.id) ?? null,
        status: (e?.status ?? { kind: 'unscored', label: 'not scored yet', detail: null }) as DataStatusRow['status'],
      };
    });
    const lotsPath = join(this.deps.dataDir, 'hk-board-lots.csv');
    const vhsiPath = join(this.deps.dataDir, 'vhsi.csv');
    return {
      lastIngest: this.lastDone,
      names,
      providers: await this.providers(),
      files: {
        boardLots: { path: lotsPath, rows: await this.watch.lotFileRows() },
        vhsi: { path: vhsiPath, found: await this.deps.fileExists(vhsiPath) },
      },
    };
  }

  private async providers(): Promise<ProviderStatusView[]> {
    const last = await this.lastIngestSummary();
    const yahoo: ProviderStatusView = !last
      ? { id: 'yahoo', label: 'Yahoo Finance', state: 'unknown', detail: 'no ingest has run yet' }
      : last.failed === 0
        ? {
            id: 'yahoo',
            label: 'Yahoo Finance',
            state: 'ok',
            detail: `last ingest ${last.at.slice(0, 16).replace('T', ' ')} UTC: ${last.ok} ok, ${last.rows} rows`,
          }
        : {
            id: 'yahoo',
            label: 'Yahoo Finance',
            state: 'warn',
            detail: `last ingest had ${last.failed} failed step(s); see the ingest log`,
          };
    const vhsi = await this.deps.fileExists(join(this.deps.dataDir, 'vhsi.csv'));
    return [
      yahoo,
      {
        id: 'stooq',
        label: 'Stooq (bar fallback)',
        state: 'warn',
        detail: 'answers scripts with a browser verification page; the adapter detects it and is not used',
      },
      {
        id: 'opend',
        label: 'moomoo OpenD (HK chains)',
        state: 'unknown',
        detail: 'not built into this app yet: paste HK chains from your broker screen',
      },
      {
        id: 'vhsi',
        label: 'VHSI file',
        state: vhsi ? 'ok' : 'warn',
        detail: vhsi
          ? 'data/vhsi.csv found'
          : 'data/vhsi.csv missing: the HK regime runs without a vol index (regime.noVolIndex)',
      },
    ];
  }

  // ------------------------------------------------------------------------------------------ imports
  async importChainCsv(input: ChainImportInput): Promise<ChainImportView> {
    const { market, symbol } = parseMarketSymbol(input.symbol, input.market);
    const inst = await findInstrument(this.deps.db, market, symbol);
    if (!inst)
      throw badRequest('unknown_stock', `${market}:${symbol} is not in the database: add it to the watchlist first`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw badRequest('invalid_date', 'date must be YYYY-MM-DD');
    if (!(input.spot > 0)) throw badRequest('invalid_spot', 'spot must be a positive number');
    const params = (await loadParams(this.deps.db)).params;
    const rf = market === 'HK' ? params['option.select'].riskFreeHK : params['option.select'].riskFreeUS;
    const r = await importChain(this.deps.db, inst, input.csv, {
      spot: input.spot,
      date: input.date,
      now: this.deps.now(),
      riskFree: rf,
    });
    if (r.ok) this.state.bump();
    return { ok: r.ok, stored: r.stored, expiries: r.expiries, iv30: r.iv30, warnings: r.warnings, errors: r.errors };
  }

  /** Imports Morningstar fair values (the Invest-agent CSV: ticker, fair_value, moat, uncertainty). Only watched US names are stored. */
  async importFairValues(input: FairValueImportInput): Promise<FairValueImportView> {
    const asOf = input.asOf ?? this.deps.now().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw badRequest('invalid_date', 'asOf must be YYYY-MM-DD');
    const csv = readCsv(input.csv);
    if (csv.errors.length > 0) throw badRequest('invalid_csv', csv.errors.map((e) => e.message).join('; '));
    if (!csv.header.includes('ticker') || !csv.header.includes('fair_value'))
      throw badRequest('invalid_csv', 'the CSV needs the columns ticker and fair_value (optional: moat, uncertainty)');
    const watched = new Map(
      (await listWatchlistAll(this.deps.db)).filter((w) => w.market === 'US').map((w) => [w.symbol, w]),
    );
    let matched = 0;
    const unmatched: string[] = [];
    for (const r of csv.rows) {
      const ticker = (r.cells.ticker ?? '').toUpperCase().replace('-', '.');
      const value = Number(r.cells.fair_value);
      if (!ticker || !(value > 0)) continue;
      const w = watched.get(ticker);
      if (!w) {
        if (unmatched.length < 50) unmatched.push(ticker);
        continue;
      }
      await upsertFairValue(this.deps.db, {
        instrumentId: w.id,
        asOf,
        value,
        moat: r.cells.moat || null,
        uncertainty: r.cells.uncertainty || null,
      });
      matched++;
    }
    if (matched > 0) this.state.bump();
    return { matched, unmatched, asOf };
  }

  async addEvent(input: EventAddInput): Promise<void> {
    const { market, symbol } = parseMarketSymbol(input.symbol, input.market);
    const inst = await findInstrument(this.deps.db, market, symbol);
    if (!inst)
      throw badRequest('unknown_stock', `${market}:${symbol} is not in the database: add it to the watchlist first`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw badRequest('invalid_date', 'date must be YYYY-MM-DD');
    await writeCorporateEvents(
      this.deps.db,
      inst.id,
      [{ type: input.type, date: input.date, confirmed: input.confirmed ?? true, source: 'manual' }],
      this.deps.now(),
    );
    this.state.bump();
  }
}

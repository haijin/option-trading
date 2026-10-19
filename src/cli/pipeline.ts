import type { ISODate } from '../core/dates';
import type { Instrument } from '../core/types';
import { UserError } from '../core/util';
import { createRunStore, loadPortfolio } from '../db/history';
import { getSettings, type LoadedParams, listWatchlist, loadParams } from '../db/repos';
import { type RunReport, runPipeline, type WatchInstrument } from '../skills';
import { defaultAsOf } from './asof';
import type { CliContext } from './context';
import type { RenderMeta } from './render';

export interface RunRequest {
  asOf: ISODate;
  mode: 'scan' | 'full';
  gate: 'enforce' | 'report';
  allowStale: boolean;
  /** Names to analyse; default is the active watchlist. */
  only?: Instrument[];
  requireEquity: boolean;
}

export interface RunOutcome {
  report: RunReport;
  meta: RenderMeta;
  params: LoadedParams;
}

export async function executeRun(ctx: CliContext, req: RunRequest): Promise<RunOutcome> {
  const db = ctx.db().db;
  const settings = await getSettings(db);
  if (req.requireEquity && settings.equity === null) {
    throw new UserError('equity is not set: run `pnpm cli settings set equity <amount> --base HKD` before scanning');
  }
  const params = await loadParams(db);
  const watch = await listWatchlist(db);
  let names: WatchInstrument[];
  if (req.only) {
    names = req.only.map((i) => {
      const w = watch.find((x) => x.id === i.id);
      return {
        ...i,
        conviction: w?.conviction ?? null,
        maxCollateralPct: w?.maxCollateralPct == null ? null : w.maxCollateralPct / 100,
      };
    });
  } else {
    if (watch.length === 0)
      throw new UserError('the watchlist is empty: add names with `pnpm cli watchlist add AAPL US`');
    names = watch.map((w) => ({
      ...w,
      maxCollateralPct: w.maxCollateralPct === null ? null : w.maxCollateralPct / 100,
    }));
  }
  const portfolio = await loadPortfolio(db, req.asOf);
  const store = createRunStore(db);
  // A live scan (the latest completed session) knows what ingest saw today; a historical replay knows only up to its as-of.
  const nowDate = ctx.now().toISOString().slice(0, 10);
  const knownThrough = req.asOf >= defaultAsOf(ctx.now()) && nowDate > req.asOf ? nowDate : undefined;
  const report = await runPipeline(store.ports, names, {
    asOf: req.asOf,
    params: params.params,
    mode: req.mode,
    gate: req.gate,
    allowStale: req.allowStale,
    portfolio,
    ...(knownThrough ? { knownThrough } : {}),
  });
  return {
    report,
    params,
    meta: {
      asOf: req.asOf,
      paramsLabel: `params ${params.name} v${params.version} [${report.paramsHash.slice(0, 8)}]`,
      baseCurrency: settings.baseCurrency,
      equity: settings.equity,
      allowStale: req.allowStale,
    },
  };
}

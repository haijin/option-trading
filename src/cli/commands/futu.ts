import type { Command } from 'commander';
import { UserError } from '../../core/util';
import { listWatchlist } from '../../db/repos';
import { type FutuSource, futuFromEnv } from '../../providers/futu';
import type { CliContext } from '../context';
import { renderTable } from '../table';

/** Qot_Common.QotMarketState names for the states a daily workflow meets. */
const MARKET_STATE: Record<number, string> = {
  0: 'no trading',
  1: 'auction',
  2: 'waiting to open',
  3: 'morning session',
  4: 'lunch break',
  5: 'afternoon session',
  6: 'closed',
  8: 'pre-market',
  9: 'pre-market ended',
  10: 'after hours',
  11: 'after hours ended',
  13: 'night session',
  14: 'night session ended',
};

function marketState(code: number): string {
  return MARKET_STATE[code] ?? `state ${code}`;
}

export interface FutuStatusReport {
  lines: string[];
}

/** What `futu status` prints: gateway login state, market states, history quota and the HK watchlist as OpenD sees it. */
export async function futuStatus(ctx: CliContext, source: FutuSource): Promise<FutuStatusReport> {
  const lines: string[] = [];
  const state = await source.globalState();
  lines.push(
    `OpenD ${state.serverVer ? `v${state.serverVer}` : ''} quote login ${state.qotLogined ? 'yes' : 'NO'}, trade login ${state.trdLogined ? 'yes (unused: the app never trades)' : 'no'}`,
  );
  lines.push(`HK market ${marketState(state.marketHK)}; US market ${marketState(state.marketUS)}`);
  try {
    const q = await source.historyQuota();
    lines.push(`history-bar quota: ${q.used} used, ${q.remaining} securities left in this 30-day window`);
  } catch (err) {
    lines.push(`history-bar quota: unavailable (${(err as Error).message})`);
  }
  const hk = (await listWatchlist(ctx.db().db)).filter((w) => w.market === 'HK');
  if (hk.length === 0) {
    lines.push('no HK names on the watchlist');
    return { lines };
  }
  const info = await source.staticInfo(hk);
  const byCode = new Map(info.map((i) => [i.security.code, i]));
  const rows = hk.map((w) => {
    const i = byCode.get(w.symbol.padStart(5, '0'));
    const lot = i ? String(i.lotSize) : '?';
    const flag = !i ? 'unknown to OpenD' : i.delisting ? 'DELISTING' : i.lotSize === w.multiplier ? '' : 'differs';
    return [w.symbol, i?.name ?? '(not found)', lot, String(w.multiplier), w.hasListedOptions ? 'yes' : 'no', flag];
  });
  lines.push(
    ...renderTable(
      [
        { header: 'Symbol' },
        { header: 'OpenD name' },
        { header: 'Stock lot', align: 'right' },
        { header: 'Multiplier', align: 'right' },
        { header: 'Options' },
        { header: 'Note' },
      ],
      rows,
    ),
  );
  lines.push(
    'Multiplier is the option contract size (data/hk-board-lots.csv); "differs" is normal where HKEX sets it apart from the stock lot.',
  );
  return { lines };
}

export function registerFutu(program: Command, ctx: CliContext): void {
  const futu = program.command('futu').description('moomoo OpenD (read-only HK bars, chains and IV history)');
  futu
    .command('status')
    .description('check that OpenD is reachable and logged in, and show what it knows about the HK watchlist')
    .action(async () => {
      const source = futuFromEnv(process.env);
      if (!source) throw new UserError('FUTU_PORT is not set: add the OpenD WebSocket port to .env (see .env.example)');
      try {
        const report = await futuStatus(ctx, source);
        for (const l of report.lines) ctx.out(l);
      } finally {
        source.close();
      }
    });
}

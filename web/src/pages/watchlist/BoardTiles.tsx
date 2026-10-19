import type { ReactNode } from 'react';
import type { WatchBoardRow } from '../../api/types';
import { num } from '../../lib/format';
import { type BoardSummary, headlines } from './boardLib';

const SHOWN = 3;

function Tile({
  label,
  value,
  tone,
  children,
}: {
  label: string;
  value: number;
  tone?: 'ok' | 'warn';
  children: ReactNode;
}) {
  return (
    <div className={`panel tile wl-tile${tone ? ` ${tone}` : ''}`}>
      <small>{label}</small>
      <h2>{value}</h2>
      <div className="wl-tilenote">{children}</div>
    </div>
  );
}

const names = (rows: WatchBoardRow[], text: (row: WatchBoardRow) => string): string =>
  rows.slice(0, SHOWN).map(text).join(' · ') + (rows.length > SHOWN ? ` · +${rows.length - SHOWN}` : '');

/** Four numbers about the whole list, each with the names behind it: the portfolio-level highlight. */
export function BoardTiles({ summary, rows }: { summary: BoardSummary; rows: readonly WatchBoardRow[] }) {
  const h = headlines(rows);
  return (
    <section className="wl-tiles" aria-label="Watchlist summary">
      <Tile label="Watching" value={summary.watching}>
        US {summary.us} &middot; HK {summary.hk}
        {summary.needsData > 0 ? <span className="neg"> &middot; {summary.needsData} need data</span> : null}
      </Tile>
      <Tile label="Sell a put" value={summary.sellPut} tone={summary.sellPut > 0 ? 'ok' : undefined}>
        {h.best?.put ? (
          <>
            Best: <b>{h.best.symbol}</b> {num(h.best.put.annRocPct, 1)}% a year
          </>
        ) : (
          'No idea passes today'
        )}
      </Tile>
      <Tile
        label="Results within 14 days"
        value={summary.earningsSoon}
        tone={summary.earningsSoon > 0 ? 'warn' : undefined}
      >
        {h.soon.length > 0 ? names(h.soon, (r) => `${r.symbol} ${r.earningsInDays}d`) : 'None close'}
      </Tile>
      <Tile label="Below intrinsic value" value={summary.undervalued} tone={summary.undervalued > 0 ? 'ok' : undefined}>
        {h.cheap.length > 0
          ? names(h.cheap, (r) => `${r.symbol} -${Math.round((1 - (r.value?.priceRatio ?? 1)) * 100)}%`)
          : 'None 20% or more below'}
      </Tile>
    </section>
  );
}

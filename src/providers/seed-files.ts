import type { DailyBar } from '../core/types';

/** `symbol,lot[,name]` rows; the user maintains data/hk-board-lots.csv. `#` lines and the header are skipped. */
export function parseBoardLotsCsv(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || /^symbol\s*,/i.test(line)) continue;
    const [sym, lot] = line.split(',').map((s) => s.trim());
    const n = Number(lot);
    if (sym && /^\d{1,5}$/.test(sym) && Number.isInteger(n) && n > 0)
      out.set(sym.replace(/^0+(?=\d)/, '').padStart(4, '0'), n);
  }
  return out;
}

/** Like parseBoardLotsCsv but keeps the name column: `{ symbol, lot, name }` per row, symbols zero-padded to four digits. */
export function parseBoardLotRows(text: string): { symbol: string; lot: number; name: string | null }[] {
  const out: { symbol: string; lot: number; name: string | null }[] = [];
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || /^symbol\s*,/i.test(line)) continue;
    const [sym, lot, ...rest] = line.split(',').map((x) => x.trim());
    const n = Number(lot);
    if (sym && /^\d{1,5}$/.test(sym) && Number.isInteger(n) && n > 0)
      out.push({ symbol: sym.replace(/^0+(?=\d)/, '').padStart(4, '0'), lot: n, name: rest.join(',') || null });
  }
  return out;
}

/**
 * Daily index levels from a CSV (the VHSI seed, since Yahoo has no VHSI history). Accepts `date,close` or any header
 * containing date and close columns; dates may be YYYY-MM-DD or DD/MM/YYYY. open = high = low = close.
 */
export function parseIndexCsv(text: string, source = 'csv'): DailyBar[] {
  const lines = text
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (lines.length < 2) return [];
  const header = (lines[0] as string)
    .toLowerCase()
    .split(',')
    .map((s) => s.trim());
  const iDate = Math.max(
    0,
    header.findIndex((h) => h.includes('date')),
  );
  const iClose = header.length === 2 ? 1 : header.findIndex((h) => h.includes('close'));
  if (iClose < 0) return [];
  const bars: DailyBar[] = [];
  for (const line of lines.slice(1)) {
    const c = line.split(',').map((s) => s.trim());
    let day = c[iDate] ?? '';
    const dmy = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(day);
    if (dmy) day = `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
    const close = Number(c[iClose]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(close) || close <= 0) continue;
    bars.push({ day, open: close, high: close, low: close, close, adjClose: close, volume: 0, source });
  }
  return bars.sort((a, b) => a.day.localeCompare(b.day));
}

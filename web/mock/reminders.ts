import type { ISODate, Market, ReminderLevel, RemindersView, ReminderView } from '../../src/server/api-types';
import { positionView } from './positions';
import { activeRows, openPositions, store } from './state';
import { ASOF } from './util';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function shortDate(iso: string): string {
  const [, m, d] = iso.split('-').map(Number) as [number, number, number];
  return `${d} ${MONTHS[(m as number) - 1]}`;
}

function strikeText(strike: number): string {
  if (Number.isInteger(strike)) return String(Math.round(strike));
  const s = strike.toFixed(2);
  return s.endsWith('0') ? strike.toFixed(1) : s;
}

function putLabel(expiry: string, strike: number): string {
  return `${shortDate(expiry)} ${strikeText(strike)} put`;
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function diffDays(from: string, to: string): number {
  const ms = (s: string) => {
    const [y, m, d] = s.split('-').map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((ms(to) - ms(from)) / 86_400_000);
}

const LEVEL_ORDER: Record<ReminderLevel, number> = { fail: 0, warn: 1, info: 2 };

export function buildMockReminders(today: ISODate = ASOF, days = 30): RemindersView {
  const horizon = addDays(today, days);
  const open = openPositions();
  const items: ReminderView[] = [];

  // ---- position views (have alerts)
  const views = open.map(positionView);

  // ---- 1. Results dates from profiles
  for (const row of activeRows()) {
    if (!row.profile?.er) continue;
    const er = row.profile.er;
    if (er.date < today || er.date > horizon) continue;
    const puts = open.filter((p) => p.market === row.market && p.symbol === row.symbol);
    const after = puts.filter((p) => p.expiry > er.date);
    let why: string;
    let level: ReminderLevel = 'info';
    if (after.length > 0) {
      why = `Open ${after.map((p) => putLabel(p.expiry, p.strike)).join(' and ')} ${after.length === 1 ? 'expires' : 'expire'} after the results.`;
      level = 'warn';
    } else if (puts.length > 0) {
      const before = puts.filter((p) => p.expiry <= er.date);
      const list = before.length > 0 ? before : puts;
      why = `Open ${list.map((p) => putLabel(p.expiry, p.strike)).join(' and ')} ${list.length === 1 ? 'settles' : 'settle'} before it.`;
    } else {
      why = 'Watched, not on the shortlist.';
    }
    items.push({
      id: `results:${row.market}:${row.symbol}:${er.date}`,
      date: er.date,
      market: row.market as Market,
      symbol: row.symbol,
      kind: 'results',
      level,
      title: `${row.symbol} results${er.confirmed ? '' : ' (date unconfirmed)'}`,
      why,
      href: `#/research/${row.market}/${encodeURIComponent(row.symbol)}`,
    });
  }

  // ---- 2. Ex-dividend from store.events
  for (const [key, evList] of store.events) {
    const [market, symbol] = key.split(':') as [string, string];
    for (const ev of evList) {
      if (ev.type !== 'ex_dividend') continue;
      if (ev.date < today || ev.date > horizon) continue;
      const puts = open.filter((p) => p.market === market && p.symbol === symbol);
      let why: string;
      let level: ReminderLevel = 'info';
      if (puts.length > 0) {
        why = `Open ${puts.map((p) => putLabel(p.expiry, p.strike)).join(', ')}; ex-div ${shortDate(ev.date)}.`;
        level = 'warn';
      } else {
        why = 'Watched.';
      }
      items.push({
        id: `ex_dividend:${market}:${symbol}:${ev.date}`,
        date: ev.date,
        market: market as Market,
        symbol,
        kind: 'ex_dividend',
        level,
        title: `${symbol} ex-dividend`,
        why,
        href: `#/research/${market}/${encodeURIComponent(symbol)}`,
      });
    }
  }

  // ---- 3. Expiries (grouped by market + day)
  const byExpiry = new Map<string, typeof open>();
  for (const p of open) {
    if (p.expiry < today || p.expiry > horizon) continue;
    const k = `${p.market}:${p.expiry}`;
    const bucket = byExpiry.get(k) ?? [];
    bucket.push(p);
    byExpiry.set(k, bucket);
  }
  for (const [, puts] of byExpiry) {
    const first = puts[0]!;
    const list = puts.map((p) => `${p.symbol} ${strikeText(p.strike)} P`).join(', ');
    const dte = diffDays(today, first.expiry);
    items.push({
      id: `expiry:${first.market}:${first.expiry}`,
      date: first.expiry,
      market: first.market as Market,
      symbol: first.symbol,
      kind: 'expiry',
      level: 'info',
      title: `${first.market} expiry: ${list}`,
      why:
        dte === 0
          ? 'Settles today.'
          : `${puts.length === 1 ? 'Settles' : 'Settle'} in ${dte} ${dte === 1 ? 'day' : 'days'}.`,
      href: '#/positions',
    });
  }

  // ---- 4. Position alerts
  for (let i = 0; i < open.length; i++) {
    const p = open[i]!;
    const view = views[i]!;
    for (const alert of view.alerts) {
      items.push({
        id: `alert:${p.id}:${alert.code}`,
        date: today,
        market: p.market as Market,
        symbol: p.symbol,
        kind: 'alert',
        level: alert.level,
        title: `${p.symbol}: ${alert.text}`,
        why: `${putLabel(p.expiry, p.strike)}, ${Math.max(0, diffDays(today, p.expiry))} dte.`,
        href: '#/positions',
      });
    }
  }

  items.sort(
    (a, b) =>
      a.date.localeCompare(b.date) || LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || a.title.localeCompare(b.title),
  );

  return {
    asOf: today,
    today: items.filter((i) => i.date <= today),
    upcoming: items.filter((i) => i.date > today),
  };
}

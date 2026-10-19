import { and, asc, gte, inArray, lte } from 'drizzle-orm';
import { evaluateAlerts } from '../core/alerts';
import type { Market } from '../core/calendar';
import { addDays, diffDays, type ISODate } from '../core/dates';
import { hkDayOf } from '../core/news';
import type { ReminderLevel, RemindersView, ReminderView } from '../core/reminders';
import { lastCloses, listPositionsDetailed } from './app-repos';
import type { Db } from './client';
import { latestMarks } from './marks';
import { latestScanRecommendations, listNewsItems } from './news';
import { listWatchlist } from './repos';
import { corporateEvents } from './schema';

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

const LEVEL_ORDER: Record<ReminderLevel, number> = { fail: 0, warn: 1, info: 2 };

/** Core query: builds the full reminders view from the database. Used by RemindersService and the CLI. */
export async function buildRemindersView(db: Db, today: ISODate, days = 30): Promise<RemindersView> {
  const horizon = addDays(today, days);

  // ---- watched names
  const watched = await listWatchlist(db, { activeOnly: true });
  const watchedIds = watched.map((w) => w.id);
  const idMeta = new Map(watched.map((w) => [w.id, { symbol: w.symbol, market: w.market as Market, name: w.name }]));

  // ---- all open positions (with openPrice / openDate for alerts)
  const allPositions = await listPositionsDetailed(db);
  const openRows = allPositions.filter((p) => p.status === 'open');
  const positionIds = openRows.map((p) => p.id);

  // ---- latest marks for mark-based alert rules
  const marks = await latestMarks(db, positionIds);

  // ---- spot prices for open puts + watched names
  const openInstIds = openRows.map((p) => p.instrument.id);
  const allInstIds = [...new Set([...openInstIds, ...watchedIds])];
  const closes = await lastCloses(db, allInstIds);

  // ---- corporate events (earnings + ex_dividend) for watched names within the window
  const eventRows =
    watchedIds.length === 0
      ? []
      : await db
          .select({
            instrumentId: corporateEvents.instrumentId,
            eventType: corporateEvents.eventType,
            eventDate: corporateEvents.eventDate,
            confirmed: corporateEvents.confirmed,
            knownAt: corporateEvents.knownAt,
          })
          .from(corporateEvents)
          .where(
            and(
              inArray(corporateEvents.instrumentId, watchedIds),
              inArray(corporateEvents.eventType, ['earnings', 'ex_dividend']),
              gte(corporateEvents.eventDate, today),
              lte(corporateEvents.eventDate, horizon),
            ),
          )
          .orderBy(asc(corporateEvents.eventDate));

  // ---- latest scan recommendations (most recent completed run)
  const scanRecs = await latestScanRecommendations(db, 1);
  const recs = scanRecs[0]?.recs ?? [];
  const recByInst = new Map(recs.map((r) => [r.instrumentId, r]));

  // ---- news: blocks/caution from the last 24 h for all relevant instruments
  const newsInstIds = [...new Set([...openInstIds, ...watchedIds])];
  const newsFrom = new Date(Date.now() - 26 * 3_600_000);
  const newsTo = new Date(Date.now() + 3_600_000);
  const newsRows =
    newsInstIds.length === 0 ? [] : await listNewsItems(db, { from: newsFrom, to: newsTo, instrumentIds: newsInstIds });

  const items: ReminderView[] = [];

  // ---- 1. Results dates
  for (const ev of eventRows.filter((e) => e.eventType === 'earnings')) {
    const meta = idMeta.get(ev.instrumentId);
    if (!meta) continue;
    const puts = openRows.filter((p) => p.instrument.id === ev.instrumentId);
    const after = puts.filter((p) => p.expiry > ev.eventDate);
    const rec = recByInst.get(ev.instrumentId);
    let why: string;
    let level: ReminderLevel = 'info';
    if (after.length > 0) {
      why = `Open ${after.map((p) => putLabel(p.expiry, p.strike)).join(' and ')} ${after.length === 1 ? 'expires' : 'expire'} after the results.`;
      level = 'warn';
    } else if (rec) {
      why = `The scan recommends the ${putLabel(rec.expiry, rec.strike)}; results fall inside its window.`;
      level = 'warn';
    } else if (puts.length > 0) {
      const before = puts.filter((p) => p.expiry <= ev.eventDate);
      const list = before.length > 0 ? before : puts;
      why = `Open ${list.map((p) => putLabel(p.expiry, p.strike)).join(' and ')} ${list.length === 1 ? 'settles' : 'settle'} before it.`;
    } else {
      why = 'Watched, not on the shortlist.';
    }
    items.push({
      id: `results:${meta.market}:${meta.symbol}:${ev.eventDate}`,
      date: ev.eventDate,
      market: meta.market,
      symbol: meta.symbol,
      kind: 'results',
      level,
      title: `${meta.symbol} results${ev.confirmed ? '' : ' (date unconfirmed)'}`,
      why,
      href: `#/research/${meta.market}/${encodeURIComponent(meta.symbol)}`,
    });
  }

  // ---- 2. Ex-dividend dates
  for (const ev of eventRows.filter((e) => e.eventType === 'ex_dividend')) {
    const meta = idMeta.get(ev.instrumentId);
    if (!meta) continue;
    const puts = openRows.filter((p) => p.instrument.id === ev.instrumentId);
    const rec = recByInst.get(ev.instrumentId);
    let why: string;
    let level: ReminderLevel = 'info';
    if (puts.length > 0) {
      why = `Open ${puts.map((p) => putLabel(p.expiry, p.strike)).join(', ')}; ex-div ${shortDate(ev.eventDate)}.`;
      level = 'warn';
    } else if (rec) {
      why = `Scan recommends ${putLabel(rec.expiry, rec.strike)}; ex-div ${shortDate(ev.eventDate)}.`;
    } else {
      why = 'Watched.';
    }
    items.push({
      id: `ex_dividend:${meta.market}:${meta.symbol}:${ev.eventDate}`,
      date: ev.eventDate,
      market: meta.market,
      symbol: meta.symbol,
      kind: 'ex_dividend',
      level,
      title: `${meta.symbol} ex-dividend`,
      why,
      href: `#/research/${meta.market}/${encodeURIComponent(meta.symbol)}`,
    });
  }

  // ---- 3. Expiries: one row per market and calendar day
  const byExpiry = new Map<string, typeof openRows>();
  for (const p of openRows) {
    if (p.expiry < today || p.expiry > horizon) continue;
    const k = `${p.instrument.market}:${p.expiry}`;
    const bucket = byExpiry.get(k) ?? [];
    bucket.push(p);
    byExpiry.set(k, bucket);
  }
  for (const [, puts] of byExpiry) {
    const first = puts[0]!;
    const list = puts.map((p) => `${p.instrument.symbol} ${strikeText(p.strike)} P`).join(', ');
    const dte = diffDays(today, first.expiry);
    items.push({
      id: `expiry:${first.instrument.market}:${first.expiry}`,
      date: first.expiry,
      market: first.instrument.market as Market,
      symbol: first.instrument.symbol,
      kind: 'expiry',
      level: 'info',
      title: `${first.instrument.market} expiry: ${list}`,
      why:
        dte === 0
          ? 'Settles today.'
          : `${puts.length === 1 ? 'Settles' : 'Settle'} in ${dte} ${dte === 1 ? 'day' : 'days'}.`,
      href: '#/positions',
    });
  }

  // ---- 4. Position alerts, dated today
  for (const p of openRows) {
    const spot = closes.get(p.instrument.id)?.close ?? null;
    const m = marks.get(p.id) ?? null;
    const freshMark = m !== null && diffDays(today, m.day) <= 7 ? m.mark : null;
    const earningsEv = eventRows.find((e) => e.instrumentId === p.instrument.id && e.eventType === 'earnings');
    const nextEarnings = earningsEv ? { date: earningsEv.eventDate, knownAt: earningsEv.knownAt.toISOString() } : null;
    const alerts = evaluateAlerts({
      strike: p.strike,
      expiry: p.expiry,
      openPrice: p.openPrice,
      openDate: p.openDate,
      today,
      spot,
      mark: freshMark,
      nextEarnings,
    });
    for (const alert of alerts) {
      items.push({
        id: `alert:${p.id}:${alert.code}`,
        date: today,
        market: p.instrument.market as Market,
        symbol: p.instrument.symbol,
        kind: 'alert',
        level: alert.level,
        title: `${p.instrument.symbol}: ${alert.text}`,
        why: `${putLabel(p.expiry, p.strike)}, ${diffDays(today, p.expiry)} dte.`,
        href: '#/positions',
      });
    }
  }

  // ---- 5. Key news: blocks/caution from the last 24 h
  const yesterday = addDays(today, -1);
  for (const row of newsRows) {
    if (row.impact !== 'blocks' && row.impact !== 'caution') continue;
    if (!row.instrumentId || !row.market || !row.symbol) continue;
    const day = hkDayOf(row.publishedAt);
    if (day < yesterday) continue;
    const standingText = row.standing
      ? `${row.standing.label}${row.standing.detail ? `, ${row.standing.detail}` : ''}`
      : '';
    items.push({
      id: `news:${row.id}`,
      date: day > today ? today : day,
      market: row.market as Market,
      symbol: row.symbol,
      kind: 'news',
      level: row.impact === 'blocks' ? 'fail' : 'warn',
      title: `${row.symbol}: ${row.title}`,
      why: row.summary ?? standingText,
      href: '#/news',
    });
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

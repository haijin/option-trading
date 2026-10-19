/**
 * Which names a news scope covers, and what each name's standing is now. Reads the database only (the latest stored scan,
 * the open positions, the latest stored gate verdict): it never runs the pipeline and never calls a model.
 */
import type { Market } from '../../core/calendar';
import { diffDays } from '../../core/dates';
import { fmtDayMonth, fmtStrike, hkDayOf, type NewsStanding } from '../../core/news';
import type { Db } from '../../db/client';
import {
  latestCloses,
  latestScanRecommendations,
  latestSkillVerdicts,
  listOpenPuts,
  type OpenPutRow,
  type RunRecommendation,
} from '../../db/news';
import { getInstrument, listWatchlist } from '../../db/repos';
import type { NewsScope } from '../api-types';

export interface NameState {
  instrumentId: number;
  market: Market;
  symbol: string;
  name: string | null;
  standing: NewsStanding;
  price: number | null;
  changePct: number | null;
  hasOpenPosition: boolean;
  inShortlist: boolean;
  inPositions: boolean;
}

const pct1 = (x: number): string => `${(x * 100).toFixed(1)}%`;

/** The standing line of an open put: nearest expiry first when a name carries several. */
export function openStanding(put: OpenPutRow, spot: number | null, today: string): NewsStanding {
  const dte = diffDays(put.expiry, today);
  const otmPct = spot && spot > 0 ? ((spot - put.strike) / spot) * 100 : null;
  const parts = [`${fmtDayMonth(put.expiry)}`, `${fmtStrike(put.strike)} put`];
  if (otmPct !== null) parts.push(`${otmPct.toFixed(1)}% OTM`);
  parts.push(dte === 1 ? '1 day' : `${dte} days`);
  return {
    kind: 'open',
    label: 'Open put',
    detail: parts.join(' · '),
    strike: put.strike,
    expiry: put.expiry,
    dte,
    otmPct: otmPct === null ? null : Number(otmPct.toFixed(1)),
  };
}

export function sellStanding(rec: RunRecommendation, spot: number | null): NewsStanding {
  const px = spot ?? rec.underlyingPrice;
  const otmPct = px > 0 ? ((px - rec.strike) / px) * 100 : null;
  return {
    kind: 'sell',
    label: 'Sell',
    detail: `${fmtDayMonth(rec.expiry)} · ${fmtStrike(rec.strike)} put · ${pct1(rec.annualizedRoc)}/yr`,
    strike: rec.strike,
    expiry: rec.expiry,
    dte: rec.dte,
    otmPct: otmPct === null ? null : Number(otmPct.toFixed(1)),
  };
}

const WAIT: NewsStanding = {
  kind: 'wait',
  label: 'Wait',
  detail: '',
  strike: null,
  expiry: null,
  dte: null,
  otmPct: null,
};

/** Every active watched name and every name with an open put, with its standing now. */
export async function resolveNames(db: Db, now: Date): Promise<NameState[]> {
  const today = hkDayOf(now);
  const watch = await listWatchlist(db, { activeOnly: true });
  const puts = await listOpenPuts(db);
  const [latest, previous] = await latestScanRecommendations(db, 2);

  const base = new Map<number, { market: Market; symbol: string; name: string | null }>();
  for (const w of watch) base.set(w.id, { market: w.market, symbol: w.symbol, name: w.name });
  for (const p of puts)
    if (!base.has(p.instrumentId)) {
      const inst = await getInstrument(db, p.instrumentId);
      if (inst) base.set(inst.id, { market: inst.market, symbol: inst.symbol, name: inst.name });
    }
  const ids = [...base.keys()];
  const [closes, gates] = await Promise.all([latestCloses(db, ids), latestSkillVerdicts(db, ids, 'fundamental.gate')]);

  const recNow = new Map((latest?.recs ?? []).map((r) => [r.instrumentId, r]));
  const sellBefore = new Set((previous?.recs ?? []).map((r) => r.instrumentId));
  const putOf = new Map<number, OpenPutRow>();
  for (const p of puts) if (!putOf.has(p.instrumentId)) putOf.set(p.instrumentId, p); // listed by expiry: nearest first

  const out: NameState[] = [];
  for (const [id, b] of base) {
    const close = closes.get(id);
    const spot = close?.close ?? null;
    const put = putOf.get(id);
    const rec = recNow.get(id);
    const fell = !rec && sellBefore.has(id);
    let standing: NewsStanding;
    if (put) standing = openStanding(put, spot, today);
    else if (rec) standing = sellStanding(rec, spot);
    else if (fell) standing = { ...WAIT, label: 'Wait (was Sell)' };
    else if (gates.get(id)?.verdict === 'FAIL')
      standing = { ...WAIT, kind: 'avoid', label: 'Avoid', detail: 'quality gate fails' };
    else standing = { ...WAIT };
    out.push({
      instrumentId: id,
      ...b,
      standing,
      price: spot,
      changePct:
        close?.changePct === null || close?.changePct === undefined ? null : Number(close.changePct.toFixed(1)),
      hasOpenPosition: put !== undefined,
      inShortlist: rec !== undefined || fell,
      inPositions: put !== undefined,
    });
  }
  return out.sort((a, b) => a.market.localeCompare(b.market) * -1 || a.symbol.localeCompare(b.symbol));
}

/** The names a scope covers. */
export function inScope(names: readonly NameState[], scope: NewsScope): NameState[] {
  if (scope === 'all') return [...names];
  return names.filter((n) => (scope === 'shortlist' ? n.inShortlist : n.inPositions));
}

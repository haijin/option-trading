import type { Fund, Profile, WatchRow } from './model';
import { ZH_NAMES } from './seed-ref';
import { ASOF, addDays, hash, mulberry, round } from './util';

const SECTORS = [
  'Technology',
  'Healthcare',
  'Industrials',
  'Consumer',
  'Staples',
  'Energy',
  'Communication',
  'Materials',
];
const SUPPORT_KINDS = ['prior-swing-low', 'prior-month-low', 'SMA50'];

/** A plausible, deterministic market-data profile for a name that was just ingested for the first time. */
export function synthProfile(row: WatchRow): Profile {
  const rnd = mulberry(hash(`${row.market}:${row.symbol}`));
  const r = (lo: number, hi: number) => lo + rnd() * (hi - lo);
  const hk = row.market === 'HK';
  const fin = row.sector === 'Financials' || row.solvencyModel === 'financial';
  const spot = round(hk ? r(18, 520) : r(25, 380), 2);
  const pe = r(11, 26);
  const eps = round(spot / pe, 2);
  const outcome = rnd();
  const fcfYield = outcome >= 0.7 && outcome < 0.85 ? r(1.5, 3.5) : r(4.3, 8);
  const b = r(3, 9);
  const roe5 = round(r(9, 25), 1);
  const fund: Fund = {
    fin,
    eps,
    bvps: round(eps * r(4, 12), 2),
    fcfps: round((spot * fcfYield) / 100, 2),
    dps: round(eps * r(0.1, 0.6), 2),
    roe5,
    roe10: round(roe5 * r(0.85, 1.05), 1),
    roic: fin ? null : round(r(6, 18), 1),
    gm: fin ? null : round(r(28, 65), 1),
    om: fin ? null : round(r(10, 35), 1),
    nm: round(r(7, 25), 1),
    ocf: round(r(0.9, 1.4), 2),
    capex: round(r(2, 12), 1),
    cov: fin ? null : round(r(6, 40), 1),
    dni: fin ? null : round(r(0.3, 2.8), 1),
    rc5: round(r(1, 10), 1),
    ec5: round(r(0, 12), 1),
    dil: round(r(-6, 2), 1),
    pay: round(r(15, 60), 0),
    bb: round(r(0, 3), 1),
    g: [round(b + 4, 1), round(b, 1), round(Math.max(b - 4, -1), 1)],
    pe: [round(pe * 1.2, 1), round(pe * 0.95, 1), round(pe * 0.72, 1)],
    hpe: [round(pe, 1), Math.round(r(25, 75))],
    comp: 3,
    mg: 3,
    listed: 15,
    info: 'B',
  };
  const support = round(spot * r(0.93, 0.965), 2);
  const dte = hk ? 20 : 35;
  const lot = hk ? row.boardLot : 100;
  const tick = (x: number) => (x > 30 ? Math.round(x * 2) / 2 : round(x, 1));
  const strike = tick(Math.min(spot * r(0.88, 0.94), support * 0.99));
  const annRoc = r(11.5, 18);
  const contract =
    outcome >= 0.85
      ? null
      : {
          strike,
          prem: Math.max(0.01, round(((strike * annRoc) / 100) * (dte / 365), 2)),
          mult: lot,
          dte,
          expiry: hk ? '2026-10-29' : '2026-11-13',
          delta: round(r(0.15, 0.2), 2),
        };
  const iv = round(r(20, 38), 1);
  return {
    symbol: row.symbol,
    market: row.market,
    name: row.name ?? `${row.symbol} Corp.`,
    zhName: ZH_NAMES[row.symbol] ?? row.name ?? row.symbol,
    sector: row.sector ?? SECTORS[hash(row.symbol) % SECTORS.length],
    spot,
    lastBar: ASOF,
    pathA: round(r(0.8, 1.2), 2),
    score: round(r(48, 70), 1),
    q: {
      f: Math.round(r(6, 8)),
      z: fin ? null : round(r(2.2, 6), 1),
      fcf: round(fcfYield, 1),
      nd: rnd() < 0.4 ? null : round(r(0.2, 2.8), 1),
      cagr: round(r(0, 9), 1),
      eps: 4,
    },
    tech: {
      rsi: round(r(36, 50), 1),
      macd: round(r(-0.5, 0.3), 2),
      support,
      supportKind: SUPPORT_KINDS[Math.floor(rnd() * SUPPORT_KINDS.length)],
      touch: rnd() < 0.4,
    },
    vol: { iv, rv: round(iv * r(0.75, 0.95), 1), ivr: Math.round(r(28, 55)), mode: hk ? 'rvOnly' : 'chain' },
    er: { date: addDays(ASOF, dte + Math.round(r(5, 35))), source: hk ? 'estimate' : 'yahoo', confirmed: !hk },
    contract,
    binding: null,
    fund,
  };
}

import type {
  ContractView,
  DataTier,
  EarningsView,
  ReasonView,
  SizingView,
  SkillRowView,
  ValueBadge,
} from '../../src/server/api-types';
import type { ChainRec, Profile, StaticBinding, WatchRow } from './model';
import { buildNarrative, buildReasons, buildSkillRows, type ReasonCtx } from './reasons';
import { lastSma, priceSeries } from './series';
import {
  baseSymbol,
  deployView,
  nextEarnings,
  openFor,
  openPositions,
  PER_NAME_CAP_PCT,
  REGIMES,
  rowKey,
  store,
  toBase,
} from './state';
import { marketCurrency } from './symbols';
import { ASOF, daysBetween, round } from './util';
import { valueBadge } from './value';

export interface Evaluated {
  row: WatchRow;
  key: string;
  state: 'idea' | 'reject' | 'open' | 'waiting' | 'no_data';
  profile: Profile | null;
  contract: ContractView | null;
  sizing: SizingView | null;
  composite: number;
  tier: DataTier;
  staleTagged: boolean;
  /** The rule that decided a rejection (also set on an open name that would otherwise be rejected). */
  reject: StaticBinding | null;
  reasons: ReasonView[];
  ruleWarns: string[];
  skills: SkillRowView[];
  narrative: { headline: string; lines: string[] } | null;
  er: EarningsView | null;
  /** Full badge (with net cost) for ideas, price-only badge for everything else with fundamentals. */
  value: ValueBadge | null;
  trend: 'up' | 'down' | 'side';
  chain: ChainRec | null;
}

/** HK contracts use the instrument's board lot as multiplier, so an edited lot changes every HK number. */
export function buildContract(p: Profile, chain: ChainRec | undefined, boardLot: number): ContractView | null {
  const seed = p.contract;
  if (!seed) return null;
  const k = { ...seed, mult: p.market === 'HK' ? boardLot : seed.mult };
  const credit = k.prem * k.mult;
  const collateral = k.strike * k.mult;
  const breakeven = k.strike - k.prem;
  const synthetic = p.market === 'HK' && !chain;
  const probItm = round(k.delta * 1.04, 3);
  return {
    expiry: k.expiry,
    dte: k.dte,
    strike: k.strike,
    delta: k.delta,
    premium: k.prem,
    multiplier: k.mult,
    credit: round(credit, 2),
    collateral: round(collateral, 2),
    collateralBase: round(toBase(collateral, marketCurrency(p.market)), 2),
    annRocPct: round((((credit / collateral) * 365) / k.dte) * 100, 2),
    rocPct: round((credit / collateral) * 100, 2),
    cushionPct: round(((p.spot - breakeven) / p.spot) * 100, 2),
    breakeven: round(breakeven, 2),
    probItm,
    // Premium kept minus the chance of assignment times a typical 2.5%-of-strike shortfall below the strike.
    expectedValue: round(credit - probItm * k.mult * k.strike * 0.025, 2),
    bid: synthetic ? null : round(k.prem * 0.96, 2),
    ask: synthetic ? null : round(k.prem * 1.04, 2),
    iv: chain?.iv30 ?? round(p.vol.iv / 100, 3),
    priceSource: chain ? 'csv' : p.market === 'US' ? 'yahoo' : 'synthetic',
    tier: synthetic ? 'synthetic' : 'real',
  };
}

function computeSizing(
  row: WatchRow,
  p: Profile,
  contract: ContractView,
  equity: number,
  below: boolean,
  sectorOpen: number,
): SizingView {
  const one = contract.collateralBase ?? contract.collateral;
  const capPct = row.maxCollateralPct ?? PER_NAME_CAP_PCT;
  let n = Math.floor((equity * capPct) / 100 / one);
  const capsHit = ['size.perNameCap'];
  if (below && n > 0) {
    n = Math.max(1, Math.floor(n / 2));
    capsHit.push('size.belowSma200');
  }
  const deploy = deployView(p.market);
  const remaining = deploy.allowedBase - deploy.amountBase;
  if (n * one > remaining) {
    n = Math.max(0, Math.floor(remaining / one));
    capsHit.push('size.regimeCap');
  }
  if (sectorOpen >= 3) {
    n = 0;
    capsHit.push('size.sectorCap');
  }
  return {
    contracts: n,
    collateralBase: round(n * one, 2),
    pctOfEquity: round(((n * one) / equity) * 100, 2),
    capsHit,
    sizeFactor: below ? 0.5 : 1,
  };
}

function sectorOpenCount(row: WatchRow): number {
  if (!row.sector) return 0;
  return openPositions().filter((pos) => {
    const other = store.watch.get(`${pos.market}:${pos.symbol}`);
    return other?.sector === row.sector && other !== row;
  }).length;
}

/** Decide the first rule that rejects a name, in pipeline order. Null = it is an idea. */
function decideReject(
  p: Profile,
  contract: ContractView | null,
  er: EarningsView | null,
  sizing: SizingView | null,
  stale: boolean,
  money: string,
  oneContract: number,
  capBase: number,
): StaticBinding | null {
  const regime = REGIMES[p.market];
  const bind = (
    status: StaticBinding['status'],
    group: string,
    rule: string,
    value: string,
    want: string,
    detail: string,
    skillId: string,
  ): StaticBinding => ({ status, group, rule, value, want, detail, skillId });
  if (stale) {
    const days = daysBetween(p.lastBar, ASOF);
    return bind(
      'dropped_stale',
      'Freshness',
      'data.stale',
      `last bar ${p.lastBar}`,
      `last session ${ASOF}`,
      `Last bar ${p.lastBar} is ${days} days behind ${ASOF}: run ingest, or scan with allowStale=1 to rank it tagged STALE.`,
      '',
    );
  }
  if (p.binding) return p.binding;
  const q = p.q;
  if (q.f < 6)
    return bind(
      'excluded',
      'Quality gate',
      'fundamentals.fScore',
      String(q.f),
      '>= 6',
      `Piotroski F-score ${q.f}/9 is below the quality floor.`,
      'fundamental.gate',
    );
  if (q.fcf < 4)
    return bind(
      'excluded',
      'Quality gate',
      'quality.fcfYield',
      `${q.fcf}%`,
      '>= 4%',
      'Free cash flow yield below the quality floor.',
      'fundamental.gate',
    );
  if ((q.nd ?? 0) > 3)
    return bind(
      'excluded',
      'Quality gate',
      'quality.netDebtEbitda',
      `${q.nd}x`,
      '<= 3',
      'Net debt is more than three times EBITDA.',
      'fundamental.gate',
    );
  if (q.z !== null && q.z <= 1.81)
    return bind(
      'excluded',
      'Quality gate',
      'solvency.altmanZ',
      String(q.z),
      '> 1.81',
      'Altman Z is in the distress zone.',
      'fundamental.gate',
    );
  if (!contract)
    return bind(
      'no_contract',
      'Option',
      'option.noContract',
      'none',
      'one contract in the delta band',
      'No contract in the delta band is quoted for this name.',
      'option.select',
    );
  if (er && er.date > ASOF && contract.expiry >= er.date) {
    return bind(
      'failed',
      'Events',
      'events.earningsWindow',
      er.date,
      `after expiry ${contract.expiry}`,
      `Results on ${er.date} (${er.confirmed ? 'confirmed' : 'estimated'}, ${er.source}) fall before the ${contract.expiry} expiry.`,
      'fundamental.gate',
    );
  }
  if (contract.delta > regime.deltaCap)
    return bind(
      'failed',
      'Option',
      'option.delta',
      contract.delta.toFixed(2),
      `<= ${regime.deltaCap.toFixed(2)}`,
      `Delta is above the ${regime.label} cap.`,
      'option.select',
    );
  if (contract.annRocPct < regime.minRoc) {
    return bind(
      'no_contract',
      'Option',
      'option.annRoc',
      `${round(contract.annRocPct, 1)}%`,
      `>= ${regime.minRoc}%`,
      'Best contract in the delta band pays too little on collateral.',
      'option.select',
    );
  }
  if (sizing && sizing.contracts < 1) {
    const rule = sizing.capsHit.includes('size.sectorCap')
      ? 'size.sectorCap'
      : sizing.capsHit.includes('size.regimeCap')
        ? 'size.regimeCap'
        : 'size.perNameCap';
    const detail =
      rule === 'size.perNameCap'
        ? `One contract is ${money}${Math.round(oneContract).toLocaleString('en-US')} of notional; the per-name cap is ${money}${Math.round(capBase).toLocaleString('en-US')}.`
        : rule === 'size.regimeCap'
          ? `The ${regime.label} regime has no room left to deploy: the market is at its cap.`
          : 'Three puts are already open in this sector.';
    return bind('cut', 'Sizing', rule, '0 contracts', 'at least 1 contract', detail, 'size.position');
  }
  return null;
}

export function evaluate(row: WatchRow, opts: { allowStale?: boolean } = {}): Evaluated {
  const key = rowKey(row);
  const p = row.profile;
  const base = {
    row,
    key,
    profile: p,
    contract: null,
    sizing: null,
    composite: 0,
    tier: 'proxy' as DataTier,
    staleTagged: false,
    reject: null,
    reasons: [],
    ruleWarns: [],
    skills: [],
    narrative: null,
    er: null,
    value: null,
    trend: 'side' as const,
    chain: null,
  };
  if (!p) return { ...base, state: row.ingest === 'no_data' ? 'no_data' : 'waiting' };

  const chain = store.chains.get(key);
  const contract = buildContract(p, chain, row.boardLot);
  const series = priceSeries(p);
  const sma200 = lastSma(series, 200);
  const sma50 = lastSma(series, 50);
  const below = p.spot < sma200;
  const er = nextEarnings(p.market, p.symbol, p);
  const stale = p.lastBar < ASOF;
  const staleTagged = stale && opts.allowStale === true;
  const equity = store.equity;
  const sectorOpen = sectorOpenCount(row);
  const sizing = contract && equity ? computeSizing(row, p, contract, equity, below, sectorOpen) : null;
  const oneContract = contract?.collateralBase ?? 0;
  const capBase = equity ? (equity * (row.maxCollateralPct ?? PER_NAME_CAP_PCT)) / 100 : 0;
  const reject = decideReject(p, contract, er, sizing, stale && !staleTagged, baseSymbol(), oneContract, capBase);
  const isOpen = openFor(p.market, p.symbol).length > 0;

  const volMode = chain && chain.iv30 !== null ? 'chain' : p.vol.mode;
  const ivPct = chain?.iv30 != null ? chain.iv30 * 100 : p.vol.iv;
  const tier: DataTier = contract?.tier === 'synthetic' ? 'synthetic' : 'proxy';
  const regime = REGIMES[p.market];
  const ctx: ReasonCtx = {
    p,
    regime,
    contract,
    sizing,
    size: equity
      ? {
          oneContractBase: oneContract,
          capBase,
          allowedBase: deployView(p.market).allowedBase,
          capPct: row.maxCollateralPct ?? PER_NAME_CAP_PCT,
          money: baseSymbol(),
        }
      : null,
    er,
    composite: p.score,
    tier,
    volMode,
    ivPct,
    below,
    sma200,
    binding: reject,
    stale,
    staleTagged,
    chain: chain ? { source: 'csv', date: chain.date } : p.market === 'US' ? { source: 'yahoo', date: ASOF } : null,
    sectorOpen,
  };
  const { reasons, ruleWarns } = buildReasons(ctx);
  const isIdea = reject === null;
  return {
    ...base,
    state: isOpen ? 'open' : isIdea ? 'idea' : 'reject',
    contract,
    sizing,
    composite: p.score,
    tier,
    staleTagged,
    reject,
    reasons,
    ruleWarns,
    skills: buildSkillRows(ctx, ruleWarns.length),
    narrative: buildNarrative(ctx),
    er,
    value: stale && !staleTagged ? valueBadge(p, null) : valueBadge(p, isIdea ? (contract?.breakeven ?? null) : null),
    trend: below ? 'down' : p.spot > sma50 * 1.01 ? 'up' : 'side',
    chain: chain ?? null,
  };
}

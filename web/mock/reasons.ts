import type {
  ContractView,
  DataTier,
  EarningsView,
  Level,
  ReasonView,
  SizingView,
  SkillRowView,
} from '../../src/server/api-types';
import type { Profile, StaticBinding } from './model';
import type { Regime } from './state';
import { ASOF, fmt0, fmt2, round } from './util';

export interface ReasonCtx {
  p: Profile;
  regime: Regime;
  contract: ContractView | null;
  sizing: SizingView | null;
  /** Notional of one contract and the per-name cap, both in the base currency, plus its symbol. */
  size: { oneContractBase: number; capBase: number; allowedBase: number; capPct: number; money: string } | null;
  er: EarningsView | null;
  composite: number;
  tier: DataTier;
  volMode: 'chain' | 'rvOnly';
  ivPct: number;
  below: boolean;
  sma200: number;
  binding: StaticBinding | null;
  stale: boolean;
  /** A stale name ranked because the scan was allowed to use stale data. */
  staleTagged: boolean;
  chain: { source: string; date: string } | null;
  sectorOpen: number;
}

const GROUPS = ['Market', 'Quality gate', 'Events', 'Timing', 'Volatility', 'Option', 'Rank', 'Sizing', 'Freshness'];
const SKILL_OF: Record<string, string> = {
  Market: 'market.regime',
  'Quality gate': 'fundamental.gate',
  Events: 'fundamental.gate',
  Timing: 'technical.timing',
  Volatility: 'volatility.edge',
  Option: 'option.select',
  Rank: 'rank.composite',
  Sizing: 'size.position',
  Freshness: 'data.freshness',
};

/** Reasons shown in the "Why" panel, grouped like the prototype, plus the list of rules that carry a WARN into the rank. */
export function buildReasons(c: ReasonCtx): { reasons: ReasonView[]; ruleWarns: string[] } {
  const out: ReasonView[] = [];
  const ruleWarns: string[] = [];
  const add = (
    group: string,
    rule: string,
    level: Level,
    value: ReasonView['value'],
    threshold: string | null,
    note: string | null,
    o: { data?: boolean; warn?: boolean } = {},
  ) => {
    out.push({ rule, value, threshold, level, kind: o.data ? 'data' : 'rule', note, group, skillId: SKILL_OF[group] });
    if (o.warn) ruleWarns.push(rule);
  };
  const { p, regime, contract } = c;
  const q = p.q;
  const t = p.tech;
  const v = p.vol;

  if (c.stale && !c.staleTagged) {
    add(
      'Freshness',
      'data.stale',
      'FAIL',
      `last bar ${p.lastBar}`,
      `last session ${ASOF}`,
      'Behind by several sessions: run an ingest, or scan with allowStale=1 to rank it tagged STALE.',
      { data: true },
    );
    return { reasons: out, ruleWarns };
  }

  add('Market', 'regime.state', p.market === 'US' ? 'PASS' : 'WARN', regime.regime, null, regime.note);
  if (p.market === 'HK')
    add('Market', 'regime.noVolIndex', 'WARN', true, null, 'no VHSI history: regime from HSI vs its 200d SMA only', {
      data: true,
    });

  add('Quality gate', 'fundamentals.fScore', q.f >= 6 ? 'PASS' : 'FAIL', q.f, '>= 6', `${q.f}/9 computable components`);
  if (q.z === null) add('Quality gate', 'solvency.altmanZ', 'INFO', null, null, 'not used for banks and insurers');
  else
    add(
      'Quality gate',
      'solvency.altmanZ',
      q.z > 2.99 ? 'PASS' : q.z > 1.81 ? 'WARN' : 'FAIL',
      q.z,
      '> 2.99 pass, 1.81-2.99 warn',
      null,
      { warn: q.z <= 2.99 },
    );
  add('Quality gate', 'quality.fcfYield', q.fcf >= 4 ? 'PASS' : 'FAIL', q.fcf, '>= 4%', null);
  add(
    'Quality gate',
    'quality.netDebtEbitda',
    (q.nd ?? 0) <= 3 ? 'PASS' : 'FAIL',
    q.nd ?? 0,
    '<= 3',
    q.nd === null ? 'net cash' : null,
  );
  add('Quality gate', 'quality.revenueCagr3y', q.cagr >= 0 ? 'PASS' : 'WARN', q.cagr, '>= 0%', null);
  add('Quality gate', 'quality.epsPositiveYears', 'PASS', q.eps, '>= 3 of last 4', null);
  add('Quality gate', 'quality.dividendCut', 'PASS', false, 'no cut in the last 3 years', null);

  add('Events', 'events.pendingCorporateAction', 'PASS', false, null, null);
  if (c.er) {
    const inside = contract !== null && c.er.date > ASOF && contract.expiry >= c.er.date;
    add(
      'Events',
      'events.earningsWindow',
      inside ? 'FAIL' : 'PASS',
      c.er.date,
      contract ? `no expiry may reach ${c.er.date}` : null,
      `${c.er.confirmed ? 'confirmed' : 'estimated'} (${c.er.source})${contract ? '; only expiries before this date qualify' : ''}`,
    );
  } else {
    add(
      'Events',
      'events.earningsUnknown',
      'WARN',
      null,
      'a known results date',
      'No results date known: add one in Data, under Add an event.',
      { warn: true },
    );
  }

  add(
    'Timing',
    'technical.pullback',
    'PASS',
    t.rsi,
    'RSI 30-45 or Bollinger touch within 5d',
    t.touch ? 'touched lower Bollinger band' : null,
  );
  add(
    'Timing',
    'technical.momentum',
    'PASS',
    t.macd,
    'histogram rising 3 days, or RSI turning up from below 40',
    'MACD histogram',
  );
  if (c.below)
    add(
      'Timing',
      'trend.belowSma200',
      'WARN',
      p.spot,
      `SMA200 ${fmt2(c.sma200)}`,
      'position size is halved downstream',
      { warn: true },
    );

  if (c.volMode === 'rvOnly') {
    add(
      'Volatility',
      'iv.rvOnly',
      'WARN',
      round(c.ivPct / 100, 3),
      null,
      'RV60 x 1.10 (default IV/RV ratio): no chain and no vol index',
      { data: true },
    );
    add(
      'Volatility',
      'iv.unscored',
      'WARN',
      true,
      null,
      'IV = RV60 x constant, so the VRP ratio is that constant; not scored',
      { data: true },
    );
  } else {
    add('Volatility', 'iv.rank', v.ivr >= 30 ? 'PASS' : 'WARN', v.ivr, '>= 30 (prefer >= 50)', null);
    add(
      'Volatility',
      'iv.vrp',
      'PASS',
      round(c.ivPct / v.rv, 2),
      '> 1.0',
      `IV30 ${round(c.ivPct, 1)}% vs realised ${v.rv}%`,
    );
  }

  if (contract) {
    const synthetic = contract.priceSource === 'synthetic';
    add(
      'Option',
      'option.delta',
      contract.delta <= regime.deltaCap ? 'PASS' : 'FAIL',
      contract.delta,
      `0.15-${regime.deltaCap.toFixed(2)}`,
      synthetic ? 'model delta' : 'chain delta',
    );
    add('Option', 'option.dte', 'PASS', contract.dte, '20-45 days', contract.expiry);
    add(
      'Option',
      'option.support',
      contract.strike <= t.support ? 'PASS' : 'WARN',
      contract.strike,
      `<= support ${fmt2(t.support)}`,
      `${t.supportKind}`,
    );
    add(
      'Option',
      'option.annRoc',
      contract.annRocPct >= regime.minRoc ? 'PASS' : 'FAIL',
      round(contract.annRocPct, 1),
      `>= ${regime.minRoc}%`,
      `${synthetic ? 'synthetic' : 'quoted'} price ${fmt2(contract.premium)} x ${contract.multiplier} = ${fmt0(contract.credit)} on collateral ${fmt0(contract.collateral)}`,
    );
    if (synthetic)
      add(
        'Option',
        'option.synthetic',
        'WARN',
        true,
        null,
        `no fresh chain; priced from IV30 ${round(c.ivPct, 1)}% with a skew bump and 20% haircuts`,
        { data: true },
      );
    add(
      'Rank',
      'rank.composite',
      'INFO',
      c.composite,
      null,
      'weights: quality 35%, timing 20%, volatility 25%, option 20%',
    );
    if (ruleWarns.length > 0)
      add('Rank', 'rank.warnMultiplier', 'WARN', 0.85, null, `rule-based warning(s): ${ruleWarns.join(', ')}`);
  }
  if (contract && c.size) {
    const s = c.size;
    add(
      'Sizing',
      'size.perNameCap',
      (c.sizing?.contracts ?? 0) >= 1 ? 'PASS' : 'FAIL',
      s.capPct,
      'at least 1 contract within the cap',
      `${s.money}${fmt0(s.capBase)} per name; one contract is ${s.money}${fmt0(s.oneContractBase)}`,
    );
    add(
      'Sizing',
      'size.regimeCap',
      'PASS',
      regime.deployCapPct,
      null,
      `${s.money}${fmt0(s.allowedBase)} allowed for ${p.market} in a ${regime.label} regime`,
    );
    add('Sizing', 'size.sectorCap', c.sectorOpen < 3 ? 'PASS' : 'FAIL', c.sectorOpen, '< 3 open puts per sector', null);
    if (c.below) add('Sizing', 'size.reducedSize', 'WARN', 0.5, null, 'below SMA200 x0.5');
  }

  if (c.stale)
    add(
      'Freshness',
      'data.stale',
      'WARN',
      `last bar ${p.lastBar}`,
      `last session ${ASOF}`,
      'ranked with stale data (allowStale=1): tagged STALE',
      { data: true },
    );
  else add('Freshness', 'data.bars', 'PASS', `last bar ${p.lastBar}`, `last session ${ASOF}`, null, { data: true });
  if (contract) {
    if (c.chain)
      add('Freshness', 'data.chain', 'PASS', c.chain.source, null, `chain dated ${c.chain.date}`, { data: true });
    else
      add(
        'Freshness',
        'data.chain',
        'WARN',
        'none',
        null,
        'no chain stored: paste one in Data to price this put from real quotes',
        { data: true },
      );
  }
  add(
    'Freshness',
    'data.fundamentals',
    'INFO',
    '2026-06-30',
    null,
    'last period end; free data holds about 4 annual statements',
    { data: true },
  );

  const b = c.binding;
  if (b) {
    const existing = out.find((r) => r.rule === b.rule);
    if (existing) {
      existing.level = 'FAIL';
      existing.note = b.detail;
      existing.threshold = existing.threshold ?? (b.want || null);
    } else {
      out.push({
        rule: b.rule,
        value: b.value,
        threshold: b.want || null,
        level: 'FAIL',
        kind: 'rule',
        note: b.detail,
        group: b.group,
        skillId: SKILL_OF[b.group] ?? 'data.freshness',
      });
    }
  }
  out.sort((a, z) => GROUPS.indexOf(a.group) - GROUPS.indexOf(z.group));
  return { reasons: out, ruleWarns };
}

/** The S0..S7 rows of the pipeline. A stale name that was dropped never reached the skills. */
export function buildSkillRows(c: ReasonCtx, ruleWarnCount: number): SkillRowView[] {
  if (c.stale && !c.staleTagged) return [];
  const { p, binding } = c;
  const sk = p.sk ?? {};
  const s1 = sk.s1 ?? Math.round(40 + p.q.f * 5 + Math.min(p.q.fcf, 8) * 1.5);
  const s2 = sk.s2 ?? Math.round(55 + (c.below ? -8 : 10) + (p.tech.touch ? 5 : 0));
  const s3 = sk.s3 ?? (c.volMode === 'rvOnly' ? null : Math.round(p.vol.ivr * 0.9 + 10));
  const rule = binding?.rule ?? '';
  const gateFail = /^(quality|events|fundamental|solvency)/.test(rule);
  const optionFail = /^option/.test(rule);
  const sizeFail = /^size/.test(rule);
  const hasContract = c.contract !== null;
  const synthetic = c.contract?.priceSource === 'synthetic';
  const row = (
    skillId: string,
    version: string,
    verdict: SkillRowView['verdict'],
    score: number | null,
    tier: DataTier,
    missing: string[] = [],
  ): SkillRowView => ({
    skillId,
    version,
    verdict,
    score,
    tier,
    missing,
  });
  return [
    row('market.regime', '1.0.0', 'NA', null, p.market === 'HK' ? 'proxy' : 'real', p.market === 'HK' ? ['vhsi'] : []),
    row('fundamental.gate', '1.1.0', gateFail ? 'FAIL' : ruleWarnCount > 0 ? 'WARN' : 'PASS', s1, 'proxy', [
      'roic5y',
      'gmStdev',
      'evEbitZ',
      'peZ',
    ]),
    row('technical.timing', '1.0.0', s2 >= 60 ? 'PASS' : 'WARN', s2, 'real'),
    row(
      'volatility.edge',
      '1.0.0',
      s3 === null || s3 < 30 ? 'WARN' : 'PASS',
      s3,
      c.volMode === 'rvOnly' ? 'proxy' : 'real',
      c.volMode === 'rvOnly' ? ['iv_chain', 'vol_index'] : [],
    ),
    row(
      'option.select',
      '1.1.0',
      !hasContract || optionFail ? 'FAIL' : 'PASS',
      null,
      synthetic ? 'synthetic' : 'real',
      synthetic ? ['chain'] : [],
    ),
    row('rank.composite', '1.0.0', binding ? 'FAIL' : 'PASS', c.composite, c.tier),
    row('size.position', '1.0.0', binding ? (sizeFail ? 'FAIL' : 'NA') : hasContract ? 'PASS' : 'NA', null, 'real'),
    row('explain.narrative', '1.0.0', binding ? 'NA' : 'PASS', null, c.tier),
  ];
}

export function buildNarrative(c: ReasonCtx): { headline: string; lines: string[] } | null {
  const k = c.contract;
  if (!k || c.binding || (c.stale && !c.staleTagged)) return null;
  const { p, regime } = c;
  const cur = p.market === 'US' ? 'US$' : 'HK$';
  const headline = `Sell ${k.expiry.slice(0, 7)} Put ${fmt2(k.strike)} (delta ${fmt2(k.delta)}, ${k.dte} DTE) for ${cur}${fmt2(k.premium)} x ${k.multiplier} = ${cur}${fmt0(k.credit)}; collateral ${cur}${fmt0(k.collateral)}; ${round(k.annRocPct, 1)}% annualised; breakeven ${fmt2(k.breakeven)} (-${round(k.cushionPct, 1)}%).`;
  const lines = [
    `Quality: F-score ${p.q.f}/9, Altman Z ${p.q.z === null ? 'n/a' : fmt2(p.q.z)}, FCF yield ${p.q.fcf}%, ${p.q.nd === null ? 'net cash' : `net debt/EBITDA ${fmt2(p.q.nd)}x`}. Not testable on free data: roic5y, gmStdev, evEbitZ, peZ.`,
    `Timing: ${c.below ? 'down' : 'up'} trend (close ${fmt2(p.spot)}, SMA200 ${fmt2(c.sma200)}), support ${fmt2(p.tech.support)} (${p.tech.supportKind}), RSI ${p.tech.rsi}.`,
    `Volatility: IV30 ${round(c.ivPct, 1)}% (${c.volMode === 'rvOnly' ? 'realised-vol proxy' : 'from chain'}) vs realised ${p.vol.rv}% (VRP ${fmt2(c.ivPct / p.vol.rv)}), IV rank ${p.vol.ivr}${c.volMode === 'rvOnly' ? ' on rv history; not scored' : ''}.`,
    c.er
      ? `Events: results on ${c.er.date} fall ${k.expiry >= c.er.date ? 'INSIDE the window' : 'AFTER expiry'}.`
      : 'Events: no results date known: add one in Data.',
    `Regime: ${p.market} ${regime.label} (deploy cap ${regime.deployCapPct}%, delta <= ${fmt2(regime.deltaCap)}).`,
  ];
  if (c.sizing && c.sizing.contracts > 0) {
    lines.push(
      `Size: ${c.sizing.contracts} contract(s), ${cur}${fmt0(c.sizing.contracts * k.collateral)} notional (${round(c.sizing.pctOfEquity, 1)}% of equity).`,
    );
  }
  return { headline, lines };
}

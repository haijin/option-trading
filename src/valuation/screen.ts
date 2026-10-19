/**
 * The quality screen: the Invest-agent `quality-screen` skill (7 filters, 3 exemptions) over stored annual statements.
 *
 *  - A filter passes, is borderline ('warn': within 10% of its threshold, on the passing side), fails, or is 'na'
 *    (not defined for banks and insurers, or the data to judge it is missing: the skill says "insufficient data", never
 *    pass or fail by default).
 *  - Exemption A (filter 1) and B (filter 6) are applied by the numbers. Exemption C needs a business-model judgement
 *    (membership, platform commission, high-turnover thin margins) that no data field holds, so it is never applied:
 *    when its numeric conditions hold the row note says it might apply.
 *  - Verdict: INCOMPLETE (fewer than 2 annual statements, or more than 3 filters 'na') comes first, so thin data never
 *    excludes a company ("better to let one slip than to kill a first-rate company"); then any non-exempt fail is
 *    EXCLUDED; then any exemption is EXEMPT-PASS; else PASS.
 *  - Exemption A's "listed under 10 years" is judged from the span of the stored price bars. Bars are capped at 10
 *    years upstream, so a span of 10 years (within a quarter of a year) means "10 or more".
 */
import { fixed, lastN, pctText, r6, timesText } from './math';
import {
  avgOver,
  cumulativeFcf,
  dilutionPct,
  ebitOf,
  grossMarginYear,
  interestCoverYear,
  NEED_5Y,
  NEED_10Y,
  netMarginYear,
  ocfNiYear,
  roeYear,
  yearlyValues,
} from './metrics';
import type { Facts, ScreenRowView, ScreenView } from './types';

type Status = ScreenRowView['status'];

/** Bars are capped at 10 years upstream; a span this close to the cap means "10 or more years". */
const BARS_CAP_YEARS = 10;
const BARS_CAP_TOLERANCE_YEARS = 0.25;

/** Pass at or above `threshold x 1.1`, borderline from the threshold up to that, fail below. */
function lowerBound(v: number, threshold: number): Status {
  return v >= r6(threshold * 1.1) ? 'pass' : v >= threshold ? 'warn' : 'fail';
}
/** Pass at or below `threshold x 0.9`, borderline up to the threshold, fail above. */
function upperBound(v: number, threshold: number): Status {
  return v <= r6(threshold * 0.9) ? 'pass' : v <= threshold ? 'warn' : 'fail';
}

const join = (...parts: (string | null | undefined | false)[]): string => parts.filter(Boolean).join('; ');

export function qualityScreen(facts: Facts): ScreenView {
  const A = facts.annual;
  const n = A.length;
  const L = facts.latest;
  const fin = facts.solvencyModel === 'financial';
  const windowNote = (need: number): string | null => (n < need ? `data window ${n}y of ${need}y` : null);

  const roe10 = avgOver(facts, 10, roeYear).value;
  const roe5 = avgOver(facts, 5, roeYear).value;
  const gm = fin ? null : avgOver(facts, 5, grossMarginYear).value;
  const ocf = avgOver(facts, 5, ocfNiYear).value;
  const nm = avgOver(facts, 10, netMarginYear).value;
  const dil = dilutionPct(facts);
  const fcf = cumulativeFcf(facts);

  const rows: ScreenRowView[] = [];
  const add = (r: number, label: string, rule: string, valueText: string, status: Status, note: string): void => {
    rows.push({ n: r, label, valueText, rule, status, note });
  };
  const na = (r: number, label: string, rule: string, note: string): void => add(r, label, rule, 'n/a', 'na', note);

  // 1. 10-year average ROE
  {
    const label = '10-year average ROE';
    if (roe10 === null)
      na(
        1,
        label,
        '>= 8%',
        join('no ROE could be computed (needs net income and positive equity)', windowNote(NEED_10Y)),
      );
    else add(1, label, '>= 8%', pctText(roe10), lowerBound(r6(roe10), 8), join(windowNote(NEED_10Y)));
  }

  // 2. 5-year cumulative free cash flow
  {
    const label = '5-year cumulative free cash flow';
    const expected = Math.min(n, NEED_5Y);
    if (fcf.sum === null) na(2, label, 'not negative', join('no free cash flow figure stored', windowNote(NEED_5Y)));
    else {
      add(
        2,
        label,
        'not negative',
        fcf.sum > 0 ? 'positive' : fcf.sum < 0 ? 'negative' : 'zero',
        fcf.sum < 0 ? 'fail' : 'pass',
        join(
          windowNote(NEED_5Y),
          fcf.used < expected && `${fcf.used} of ${expected} years have a free cash flow figure`,
        ),
      );
    }
  }

  // 3. interest cover
  {
    const label = 'Interest cover (EBIT / interest)';
    const rule = '>= 2x';
    if (fin) na(3, label, rule, 'banks and insurers are exempt from this filter');
    else if (!L || L.interestExpense === null || ebitOf(L) === null) {
      na(3, label, rule, 'EBIT or interest expense missing in the latest annual statement');
    } else if (L.interestExpense === 0) add(3, label, rule, 'no interest expense', 'pass', '');
    else {
      const cover = r6(interestCoverYear(L) as number);
      add(3, label, rule, timesText(cover), lowerBound(cover, 2), '');
    }
  }

  // 4. long-run gross margin
  {
    const label = 'Long-run gross margin';
    if (fin) na(4, label, '>= 15%', 'not defined for banks and insurers');
    else if (gm === null) na(4, label, '>= 15%', join('no gross profit and revenue stored', windowNote(NEED_5Y)));
    else add(4, label, '>= 15%', pctText(gm), lowerBound(r6(gm), 15), join(windowNote(NEED_5Y)));
  }

  // 5. operating cash flow / net income
  {
    const label = 'Operating cash flow / net income (5y)';
    if (ocf === null) {
      na(5, label, '>= 0.7', join('needs positive net income and an operating cash flow figure', windowNote(NEED_5Y)));
    } else add(5, label, '>= 0.7', timesText(ocf), lowerBound(r6(ocf), 0.7), join(windowNote(NEED_5Y)));
  }

  // 6. long-run net margin
  {
    const label = 'Long-run net margin';
    if (nm === null) na(6, label, '>= 5%', join('no net income and revenue stored', windowNote(NEED_10Y)));
    else add(6, label, '>= 5%', pctText(nm), lowerBound(r6(nm), 5), join(windowNote(NEED_10Y)));
  }

  // 7. share count change
  {
    const label = '5-year share count change';
    if (dil === null) na(7, label, '<= +20%', join('needs diluted share counts for two years', windowNote(NEED_5Y)));
    else {
      const v = r6(dil);
      const status = upperBound(v, 20);
      add(
        7,
        label,
        '<= +20%',
        `${v >= 0 ? '+' : ''}${pctText(v)}`,
        status,
        join(
          windowNote(NEED_5Y),
          status !== 'pass' &&
            'the skill excludes only when the increase is not from an acquisition, which the data cannot tell',
        ),
      );
    }
  }

  const row = (r: number): ScreenRowView => rows[r - 1] as ScreenRowView;
  const set = (r: ScreenRowView, status: Status, note: string): void => {
    r.status = status;
    r.note = join(r.note, note);
  };

  // Exemption A: investment-phase company with a weak 10-year ROE.
  if (row(1).status === 'fail') {
    const span = facts.barsSpanYears;
    const atCap = span !== null && span >= BARS_CAP_YEARS - BARS_CAP_TOLERANCE_YEARS;
    const lastTwo = lastN(A, 2);
    const conditions: { ok: boolean; met: string; unmet: string }[] = [
      {
        ok: span !== null && !atCap,
        met: `listed under 10 years (price history spans ${span === null ? '?' : fixed(span, 1)} years; bars are capped at 10 years)`,
        unmet:
          span === null
            ? 'listing age unknown (no price history)'
            : `listed 10 or more years (price history spans ${fixed(span, 1)} years; bars are capped at 10 years, so 10 means "10 or more")`,
      },
      {
        ok: gm !== null && gm > 30,
        met: `long-run gross margin ${gm === null ? '?' : pctText(gm)} is over 30%`,
        unmet: gm === null ? 'gross margin not available' : `long-run gross margin ${pctText(gm)} is not over 30%`,
      },
      {
        ok: lastTwo.length === 2 && lastTwo.every((a) => a.cfo !== null && a.cfo > 0),
        met: 'operating cash flow positive in each of the last 2 years',
        unmet: 'operating cash flow not positive in each of the last 2 years',
      },
    ];
    if (conditions.every((c) => c.ok)) {
      set(
        row(1),
        'exempt',
        `Exemption A: ${conditions.map((c) => c.met).join(', ')} (a business in its investment phase)`,
      );
    } else {
      set(
        row(1),
        'fail',
        `Exemption A not met: ${conditions
          .filter((c) => !c.ok)
          .map((c) => c.unmet)
          .join('; ')}`,
      );
    }
  }

  // Exemption B: deliberately thin net margin with pricing power.
  if (row(6).status === 'fail') {
    const margins = yearlyValues(facts, 3, netMarginYear).map(r6);
    const lastTwoMargins = lastN(A, 2).map(netMarginYear);
    const backAbove5 = lastTwoMargins.length === 2 && lastTwoMargins.every((m) => m !== null && r6(m) >= 5);
    const rising =
      margins.length === 3 &&
      (margins[0] as number) < (margins[1] as number) &&
      (margins[1] as number) < (margins[2] as number);
    const gmOk = gm !== null && gm > 30;
    if (gmOk && (backAbove5 || rising)) {
      set(
        row(6),
        'exempt',
        `Exemption B: long-run gross margin ${pctText(gm as number)} is over 30% and ${
          backAbove5
            ? `net margin is back above 5% in each of the last 2 years (${lastTwoMargins.map((m) => pctText(r6(m as number))).join(', ')})`
            : `net margin has risen three years running (${margins.map(pctText).join(', ')})`
        }`,
      );
    } else {
      set(
        row(6),
        'fail',
        `Exemption B not met: ${join(
          !gmOk &&
            (gm === null
              ? 'gross margin not available'
              : `long-run gross margin ${pctText(gm as number)} is not over 30%`),
          !(backAbove5 || rising) &&
            'net margin is neither above 5% in each of the last 2 years nor rising for 3 years',
        )}`,
      );
    }
  }

  // Exemption C: never applied, only pointed out.
  if ((row(4).status === 'fail' || row(6).status === 'fail') && roe5 !== null && ocf !== null && roe5 > 20 && ocf > 1) {
    const hint = `Exemption C might apply (a human judgement): 5-year ROE ${pctText(roe5)} is over 20% and operating cash flow / net income ${timesText(ocf)} is over 1.0, but it also needs a membership, platform-commission or high-turnover thin-margin business model, which the data cannot show`;
    for (const r of [row(4), row(6)]) if (r.status === 'fail') set(r, 'fail', hint);
  }

  const naCount = rows.filter((r) => r.status === 'na').length;
  const verdict: ScreenView['verdict'] =
    n < 2 || naCount > 3
      ? 'INCOMPLETE'
      : rows.some((r) => r.status === 'fail')
        ? 'EXCLUDED'
        : rows.some((r) => r.status === 'exempt')
          ? 'EXEMPT-PASS'
          : 'PASS';

  return { verdict, rows, borderline: rows.filter((r) => r.status === 'warn').length, windowYears: n };
}

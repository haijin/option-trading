import { useState } from 'react';
import type { KpiRowView, ValueView } from '../api/types';
import { n2, num, pct, signedPct } from '../lib/format';
import { kpiHelp } from '../lib/glossary';
import { Chip, type ChipKind } from './Chip';
import { HelpBody } from './HelpBody';
import { Panel } from './Panel';
import { Sparkline } from './Sparkline';

const STATUS: Record<KpiRowView['status'], { text: string; kind: ChipKind }> = {
  ok: { text: 'OK', kind: 'ok' },
  warn: { text: 'WATCH', kind: 'warn' },
  fail: { text: 'FAIL', kind: 'fail' },
  info: { text: 'INFO', kind: '' },
};

export function kpiValue(row: KpiRowView): string {
  if (row.unit === 'text') return row.text ?? '-';
  if (row.value === null) return row.text ?? 'n/a';
  switch (row.unit) {
    case '%':
      return pct(row.value);
    case 'x':
      return `${n2(row.value)}x`;
    case 'yrs':
      return `${num(row.value, 1)} yrs`;
    default:
      return n2(row.value);
  }
}

const GROUP_ORDER: KpiRowView['group'][] = [
  'Profitability',
  'Cash quality',
  'Safety',
  'Growth',
  'Valuation',
  'Shareholder',
];

/** KPI table grouped by theme (value, trend, rule of thumb, status, data window) and the last quarters. */
export function KpiPanel({ value }: { value: ValueView }) {
  const groups = GROUP_ORDER.filter((group) => value.kpis.some((row) => row.group === group));
  return (
    <>
      <Panel
        flush
        title="Financial KPIs"
        actions={<small>stored data only; {value.fundamentals.annual} annual statements</small>}
      >
        <table className="tbl">
          <thead>
            <tr>
              <th>KPI</th>
              <th className="num">Value</th>
              <th>Trend</th>
              <th>Rule of thumb</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              <GroupRows key={group} group={group} rows={value.kpis.filter((row) => row.group === group)} />
            ))}
          </tbody>
        </table>
      </Panel>
      <Panel flush title="Last quarters" actions={<small>revenue growth, gross margin, EPS surprise</small>}>
        {value.quarters.length === 0 ? (
          <p className="muted" style={{ padding: 12 }}>
            No quarterly statements stored yet.
          </p>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Quarter</th>
                <th className="num">Revenue YoY</th>
                <th className="num">Gross margin</th>
                <th className="num">EPS vs estimate</th>
              </tr>
            </thead>
            <tbody>
              {value.quarters.map((quarter) => (
                <tr key={quarter.label}>
                  <td>{quarter.label}</td>
                  <td className={`num ${(quarter.revenueYoyPct ?? 0) >= 0 ? 'pos' : 'neg'}`}>
                    {signedPct(quarter.revenueYoyPct)}
                  </td>
                  <td className="num">
                    {quarter.grossMarginPct === null ? <span className="faint">n/a</span> : pct(quarter.grossMarginPct)}
                  </td>
                  <td className="num">
                    {quarter.epsSurprisePct === null ? (
                      <span className="faint" title="Free data often has no estimates for HK names">
                        not available
                      </span>
                    ) : (
                      signedPct(quarter.epsSurprisePct)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}

function GroupRows({ group, rows }: { group: string; rows: KpiRowView[] }) {
  return (
    <>
      <tr>
        <td colSpan={5} className="gh2">
          {group}
        </td>
      </tr>
      {rows.map((row) => (
        <KpiRow key={row.key} row={row} />
      ))}
    </>
  );
}

/** One KPI row; the name opens a plain-English explanation underneath. */
function KpiRow({ row }: { row: KpiRowView }) {
  const [open, setOpen] = useState(false);
  const help = kpiHelp(row.key);
  return (
    <>
      <tr>
        <td>
          {help ? (
            <button type="button" className="rule-btn kpi-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
              {row.label}
              <span className="qm" aria-hidden="true">
                {open ? '−' : '?'}
              </span>
            </button>
          ) : (
            row.label
          )}{' '}
          {row.window ? (
            <Chip kind="warn" title="Free data holds about four annual statements; the rule wants more.">
              {row.window}
            </Chip>
          ) : null}
        </td>
        <td className="num">
          <b>{kpiValue(row)}</b>
        </td>
        <td>
          {row.trend && row.trend.length > 1 ? <Sparkline values={row.trend} label={`${row.label} trend`} /> : null}
        </td>
        <td className="muted" style={{ fontSize: 12 }}>
          {row.rule}
        </td>
        <td>
          <Chip kind={STATUS[row.status].kind}>{STATUS[row.status].text}</Chip>
        </td>
      </tr>
      {open && help ? (
        <tr>
          <td colSpan={5} className="khelp">
            <HelpBody help={help} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

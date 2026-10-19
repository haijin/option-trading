import type { ScreenRowView, ScreenView } from '../api/types';
import { Chip, type ChipKind } from './Chip';
import { Panel } from './Panel';

const ROW_TAG: Record<ScreenRowView['status'], { text: string; kind: ChipKind }> = {
  pass: { text: 'PASS', kind: 'ok' },
  warn: { text: 'BORDER', kind: 'warn' },
  fail: { text: 'FAIL', kind: 'fail' },
  exempt: { text: 'EXEMPT', kind: 'blue' },
  na: { text: 'N/A', kind: '' },
};

const VERDICT_KIND: Record<ScreenView['verdict'], ChipKind> = {
  PASS: 'ok',
  'EXEMPT-PASS': 'blue',
  EXCLUDED: 'fail',
  INCOMPLETE: 'warn',
};

/** The 7-filter quality screen (去劣筛选) with its exemptions and an overall verdict. */
export function ScreenTable({ screen }: { screen: ScreenView }) {
  return (
    <>
      <Panel
        flush
        title={
          <>
            Quality screen <span className="zh">去劣筛选 &middot; 7 filters</span>
          </>
        }
        actions={
          <span className="row" style={{ gap: 6 }}>
            {screen.borderline > 0 ? <Chip kind="warn">{screen.borderline} borderline</Chip> : null}
            <Chip kind={VERDICT_KIND[screen.verdict]}>{screen.verdict}</Chip>
          </span>
        }
      >
        <table className="tbl">
          <thead>
            <tr>
              <th>#</th>
              <th>Filter</th>
              <th className="num">Value</th>
              <th>Rule</th>
              <th>Result</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {screen.rows.map((row) => {
              const tag = ROW_TAG[row.status];
              return (
                <tr key={row.n}>
                  <td>{row.n}</td>
                  <td>{row.label}</td>
                  <td className="num">{row.valueText}</td>
                  <td className="muted">{row.rule}</td>
                  <td>
                    <Chip kind={tag.kind}>{tag.text}</Chip>
                  </td>
                  <td className="muted" style={{ fontSize: 12 }}>
                    {row.note}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Panel>
      <p className="note">
        Based on {screen.windowYears} {screen.windowYears === 1 ? 'year' : 'years'} of annual statements (free data
        holds about four). The screen removes companies that are clearly not first-rate; passing does not mean good, so
        business model, management and price still need judgement.
      </p>
    </>
  );
}

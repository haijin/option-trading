import { useState } from 'react';
import { api } from '../../api/endpoints';
import type { AssumptionParam, ValuationOverrides, ValueView } from '../../api/types';
import { Callout } from '../../components/Callout';
import { Panel } from '../../components/Panel';
import { useMutation } from '../../hooks/useMutation';
import { n2, num, parseNumber } from '../../lib/format';

type Triple = [string, string, string];

/** Inputs show two decimals; the stored value keeps full precision, so "unchanged" is judged on the rounded figure. */
const round2 = (value: number): number => Math.round(value * 100) / 100;

const fieldText = (param: AssumptionParam): string => (param.value === null ? '' : String(round2(param.value)));

const isUnchanged = (text: string, param: AssumptionParam | undefined): boolean =>
  parseNumber(text) === (param?.value == null ? null : round2(param.value));

function SourceBadge({ param }: { param: AssumptionParam }) {
  return (
    <span className={`src-badge ${param.source}`} title={param.note ?? undefined}>
      {param.source}
    </span>
  );
}

function sameTriple(inputs: Triple, params: readonly AssumptionParam[]): boolean {
  return inputs.every((text, index) => isUnchanged(text, params[index]));
}

/** Untouched fields keep their full-precision value, so editing one case does not turn the others into overrides. */
function toTriple(
  inputs: Triple,
  params: readonly AssumptionParam[],
  label: string,
  min: number,
  max: number,
): [number, number, number] | string {
  const values = inputs.map((text, index) => {
    const param = params[index];
    return param && param.value !== null && isUnchanged(text, param) ? param.value : parseNumber(text);
  });
  if (values.some((v) => v === null || v < min || v > max)) return `${label}: three numbers between ${min} and ${max}.`;
  return values as [number, number, number];
}

/** Every valuation assumption with where it came from (data / default / override), and editable overrides. */
export function AssumptionsPanel({
  view,
  market,
  symbol,
}: {
  view: ValueView;
  market: ValueView['market'];
  symbol: string;
}) {
  const mutation = useMutation();
  const a = view.intrinsic?.assumptions;
  const [growth, setGrowth] = useState<Triple>(() =>
    a ? [fieldText(a.growthPct[0]), fieldText(a.growthPct[1]), fieldText(a.growthPct[2])] : ['', '', ''],
  );
  const [pe, setPe] = useState<Triple>(() =>
    a ? [fieldText(a.targetPe[0]), fieldText(a.targetPe[1]), fieldText(a.targetPe[2])] : ['', '', ''],
  );
  const [dcf, setDcf] = useState(() => (a ? fieldText(a.dcfGrowthPct) : ''));
  const [error, setError] = useState<string | null>(null);

  if (!a) return null;
  const hasOverrides = view.overrides !== null && Object.keys(view.overrides).length > 0;

  const save = async () => {
    const next: ValuationOverrides = { ...(view.overrides ?? {}) };
    if (!sameTriple(growth, a.growthPct)) {
      const parsed = toTriple(growth, a.growthPct, 'EPS growth', -50, 100);
      if (typeof parsed === 'string') return setError(parsed);
      next.growthPct = parsed;
    }
    if (!sameTriple(pe, a.targetPe)) {
      const parsed = toTriple(pe, a.targetPe, 'Target P/E', 1, 100);
      if (typeof parsed === 'string') return setError(parsed);
      next.targetPe = parsed;
    }
    if (!isUnchanged(dcf, a.dcfGrowthPct)) {
      const parsed = parseNumber(dcf);
      if (parsed === null || parsed < -20 || parsed > 50) return setError('DCF growth: a number between -20 and 50.');
      next.dcfGrowthPct = parsed;
    }
    if (Object.keys(next).length === 0) return setError('Nothing changed yet. Edit a value first.');
    setError(null);
    await mutation.run(() => api.putValuation(market, symbol, next), {
      success: `${symbol}: valuation overrides saved.`,
    });
  };

  const reset = async () => {
    setError(null);
    await mutation.run(() => api.putValuation(market, symbol, null), {
      success: `${symbol}: valuation overrides cleared.`,
    });
  };

  const cell = (value: string, set: (text: string) => void, label: string, param: AssumptionParam) => (
    <td key={label}>
      <input aria-label={label} inputMode="decimal" value={value} onChange={(e) => set(e.target.value)} />
      <div>
        <SourceBadge param={param} />
      </div>
    </td>
  );
  const edit = (triple: Triple, set: (t: Triple) => void, index: number) => (text: string) => {
    const copy: Triple = [...triple];
    copy[index] = text;
    set(copy);
  };
  const cases = ['Bull', 'Base', 'Bear'] as const;
  const readOnly = (label: string, param: AssumptionParam, digits = 2) => (
    <tr>
      <td>{label}</td>
      <td className="num">{param.value === null ? '-' : n2(Number(param.value.toFixed(digits)))}</td>
      <td colSpan={3}>
        <SourceBadge param={param} /> <small>{param.note ?? ''}</small>
      </td>
    </tr>
  );

  return (
    <Panel
      flush
      title="Assumptions"
      actions={
        <span className="row" style={{ gap: 6 }}>
          <button type="button" className="btn sm primary" onClick={save} disabled={mutation.busy}>
            Save
          </button>
          <button type="button" className="btn sm" onClick={reset} disabled={mutation.busy || !hasOverrides}>
            Reset
          </button>
        </span>
      }
    >
      <div style={{ padding: '10px 14px' }} className="stack">
        <small>
          <span className="src-badge data">data</span> derived from stored statements,{' '}
          <span className="src-badge default">default</span> a fixed default,{' '}
          <span className="src-badge override">override</span> set by you. Edit a number and Save to override it for
          this stock.
        </small>
        {error ? (
          <Callout kind="fail" role="alert">
            {error}
          </Callout>
        ) : null}
        {mutation.error ? (
          <Callout kind="fail" role="alert">
            {mutation.error.message}
          </Callout>
        ) : null}
      </div>
      <table className="tbl">
        <thead>
          <tr>
            <th>Parameter</th>
            <th>{cases[0]}</th>
            <th>{cases[1]}</th>
            <th>{cases[2]}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>EPS growth per year (%)</td>
            {cases.map((name, i) =>
              cell(
                growth[i] as string,
                edit(growth, setGrowth, i),
                `${name} EPS growth`,
                a.growthPct[i] as AssumptionParam,
              ),
            )}
            <td />
          </tr>
          <tr>
            <td>Target P/E in 3 years</td>
            {cases.map((name, i) =>
              cell(pe[i] as string, edit(pe, setPe, i), `${name} target P/E`, a.targetPe[i] as AssumptionParam),
            )}
            <td />
          </tr>
          <tr>
            <td>DCF growth, years 1 to 5 (%)</td>
            {cell(dcf, setDcf, 'DCF growth', a.dcfGrowthPct)}
            <td colSpan={3}>
              <small>then fading to {num(a.terminalGrowthPct, 0, 1)}% terminal growth</small>
            </td>
          </tr>
          {readOnly('EPS per share', a.eps)}
          {readOnly('Dividend per share', a.dividendPerShare)}
          {readOnly('Free cash flow per share', a.fcfPerShare)}
          <tr>
            <td>Required return (%)</td>
            <td className="num">{a.requiredReturnPct.value === null ? '-' : n2(a.requiredReturnPct.value)}</td>
            <td colSpan={3}>
              <SourceBadge param={a.requiredReturnPct} />{' '}
              <small>{a.requiredReturnPct.note ?? 'move the slider above to change it'}</small>
            </td>
          </tr>
        </tbody>
      </table>
    </Panel>
  );
}

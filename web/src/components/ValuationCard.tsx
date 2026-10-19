import type { ReactNode } from 'react';
import type { FairValueView, IntrinsicView } from '../api/types';
import { money, n0, n2, num, pct, priceVsIvText, ratioPct } from '../lib/format';
import { Callout } from './Callout';
import { Chip } from './Chip';
import { Panel } from './Panel';
import { METHOD_COLOR, RangeBar } from './RangeBar';
import { Stars } from './Stars';

/** "If assigned" block: strike and net cost against intrinsic value. */
export function AssignedCallout({ put }: { put: NonNullable<IntrinsicView['proposedPut']> }) {
  const within = put.costRatio <= 1;
  const verdict =
    put.costRatio <= 0.7
      ? 'Strong margin of safety.'
      : within
        ? 'Below intrinsic value, modest margin.'
        : 'Above intrinsic value: you would own it at a price the numbers do not support.';
  return (
    <Callout
      kind={put.costRatio <= 0.7 ? 'ok' : within ? 'blue' : ''}
      action={<Chip kind={within ? 'ok' : 'warn'}>{within ? 'within IV' : 'above IV'}</Chip>}
    >
      <b>If assigned:</b> you pay {n2(put.strike)} per share, net {n2(put.breakeven)} after the premium. That is{' '}
      <b>{ratioPct(put.strikeRatio)}</b> of intrinsic value at the strike and <b>{ratioPct(put.costRatio)}</b> net.{' '}
      {verdict}
    </Callout>
  );
}

/**
 * Intrinsic value: base figure, range, price vs intrinsic with stars, the range bar, the methods and the three scenarios.
 * `headerExtra` is where the Research page puts its required-return slider.
 */
export function ValuationCard({
  intrinsic,
  headerExtra,
  fairValue,
}: {
  intrinsic: IntrinsicView;
  headerExtra?: ReactNode;
  fairValue?: FairValueView | null;
}) {
  const { currency, price } = intrinsic;
  const { base, low, high } = intrinsic;
  const ratio = intrinsic.priceRatio;

  return (
    <Panel title="Intrinsic value" actions={headerExtra}>
      <div className="stack">
        {intrinsic.warnings.map((warning) => (
          <Callout key={warning}>{warning}</Callout>
        ))}
        {base === null || low === null || high === null ? (
          <Callout kind="blue">
            No valuation method could be computed for this stock from the stored data, so there is no intrinsic value to
            show yet.
          </Callout>
        ) : (
          <>
            <div className="bigiv">
              <div>
                <small>Current intrinsic value (base)</small>
                <br />
                <b>{money(base, currency, 2)}</b>
              </div>
              <div>
                <small>Range</small>
                <br />
                <b className="sm">
                  {money(low, currency, 2)} to {money(high, currency, 2)}
                </b>
              </div>
              <div>
                <small>Price</small>
                <br />
                <b className="sm">{money(price, currency, 2)}</b>
              </div>
              <div>
                <small>Price vs intrinsic</small>
                <br />
                {ratio !== null ? (
                  <b className={`sm ${priceVsIvText(ratio).tone}`}>{priceVsIvText(ratio).text}</b>
                ) : null}{' '}
                <Stars value={intrinsic.stars} />
              </div>
            </div>
            <RangeBar
              price={price}
              base={base}
              low={low}
              high={high}
              strike={intrinsic.proposedPut?.strike ?? null}
              methods={intrinsic.methods}
            />
            {intrinsic.proposedPut ? (
              <AssignedCallout put={intrinsic.proposedPut} />
            ) : (
              <Callout kind="blue">
                No put is proposed for this stock today, so there is no strike to compare with intrinsic value.
              </Callout>
            )}
          </>
        )}

        {intrinsic.methods.length > 0 ? (
          <div style={{ overflow: 'auto' }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Method</th>
                  <th className="num">Value</th>
                  <th className="num">vs price</th>
                  <th>How</th>
                </tr>
              </thead>
              <tbody>
                {intrinsic.methods.map((method) => {
                  const diff = price > 0 ? (method.value / price - 1) * 100 : 0;
                  return (
                    <tr key={method.id}>
                      <td>
                        <i className="dot" style={{ background: METHOD_COLOR[method.id] }} />
                        <b>{method.label}</b>
                      </td>
                      <td className="num">{money(method.value, currency, 2)}</td>
                      <td className={`num ${diff >= 0 ? 'pos' : 'neg'}`}>
                        {diff >= 0 ? '+' : ''}
                        {n0(diff)}%
                      </td>
                      <td className="muted">{method.note}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}

        {intrinsic.scenarios.length > 0 ? (
          <div>
            <h4 style={{ marginBottom: 6 }}>
              Three scenarios <small>(3-year horizon, discounted at {pct(intrinsic.requiredReturnPct, 1)})</small>
            </h4>
            <div style={{ overflow: 'auto' }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Case</th>
                    <th className="num">EPS growth</th>
                    <th className="num">Target P/E</th>
                    <th className="num">EPS in 3y</th>
                    <th className="num">Price in 3y</th>
                    <th className="num">Dividends</th>
                    <th className="num">Value today</th>
                  </tr>
                </thead>
                <tbody>
                  {intrinsic.scenarios.map((scenario) => (
                    <tr key={scenario.name}>
                      <td>
                        <b>{scenario.name}</b>
                      </td>
                      <td className="num">{pct(scenario.growthPct)}</td>
                      <td className="num">{num(scenario.targetPe, 0, 1)}x</td>
                      <td className="num">{n2(scenario.eps3y)}</td>
                      <td className="num">{n2(scenario.price3y)}</td>
                      <td className="num">{n2(scenario.dividends3y)}</td>
                      <td className="num">
                        <b>{money(scenario.presentValue, currency, 2)}</b>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}

        {intrinsic.reverse ? (
          <p className="note">
            <b>Reverse DCF:</b> at {money(price, currency, 2)} the market is pricing in about{' '}
            <b>{pct(intrinsic.reverse.impliedGrowthPct)}</b> free-cash-flow growth a year for 5 years, then fading to
            3%.{' '}
            {intrinsic.reverse.historicalEpsCagrPct !== null
              ? `History: EPS grew ${pct(intrinsic.reverse.historicalEpsCagrPct)} a year. `
              : 'No EPS history to compare with. '}
            That expectation is <b>{intrinsic.reverse.verdict}</b>.
          </p>
        ) : (
          <p className="note">
            The free-cash-flow DCF and reverse DCF are skipped when cash flow is not meaningful (banks and insurers) or
            data is missing.
          </p>
        )}
        {fairValue ? (
          <p className="note">
            <b>Morningstar fair value</b> {money(fairValue.value, currency, 2)} as of {fairValue.asOf} (
            {fairValue.source}
            {fairValue.moat ? `, moat ${fairValue.moat}` : ''}
            {fairValue.uncertainty ? `, uncertainty ${fairValue.uncertainty}` : ''}).
          </p>
        ) : null}
        <p className="note">
          Intrinsic value is a range, not a number: move the required return and watch it change. It is a statistic
          about the inputs shown, not a price target.
        </p>
      </div>
    </Panel>
  );
}

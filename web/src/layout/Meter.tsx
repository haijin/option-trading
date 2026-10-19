import type { DeployView, Market } from '../api/types';
import { pct } from '../lib/format';

/**
 * Capital deployed against the regime cap. The fill is the deployed share of equity; the marker is the cap. `label`
 * replaces the default caption where the market is already named next to the meter (Home).
 */
export function Meter({ market, deploy, label }: { market: Market; deploy: DeployView; label?: string }) {
  const scaleMax = Math.max(deploy.capPct * 1.25, deploy.pctOfEquity * 1.05, 1);
  const fill = Math.min(100, (deploy.pctOfEquity / scaleMax) * 100);
  const marker = Math.min(100, (deploy.capPct / scaleMax) * 100);
  const over = deploy.pctOfEquity > deploy.capPct;
  return (
    <div className="mini">
      <span>
        {label ?? (
          <>
            {market} {pct(deploy.pctOfEquity)} of equity deployed &middot; cap {pct(deploy.capPct, 0)}
          </>
        )}
      </span>
      {/* biome-ignore lint/a11y/useSemanticElements: custom-drawn meter with a cap marker; a native <meter> cannot show one */}
      <div
        className="meter"
        role="meter"
        aria-label={`${market} capital deployed`}
        aria-valuemin={0}
        aria-valuemax={deploy.capPct}
        aria-valuenow={Math.round(deploy.pctOfEquity * 10) / 10}
        aria-valuetext={`${pct(deploy.pctOfEquity)} of equity, cap ${pct(deploy.capPct, 0)}`}
      >
        <i className={over ? 'over' : undefined} style={{ width: `${fill}%` }} />
        <b style={{ left: `calc(${marker}% - 1px)` }} title={`${market} deployment cap ${pct(deploy.capPct, 0)}`} />
      </div>
    </div>
  );
}

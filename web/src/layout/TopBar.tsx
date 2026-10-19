import { useState } from 'react';
import { api } from '../api/endpoints';
import type { Market, OverviewView, RegimeView } from '../api/types';
import { Chip, type ChipKind } from '../components/Chip';
import { useMutation } from '../hooks/useMutation';
import { useNow } from '../hooks/useNow';
import { n2, pct } from '../lib/format';
import { PAGE_TITLES, type PageId, toHash } from '../lib/route';
import { sessionState } from '../lib/sessions';
import { useOverview } from '../state/overview';
import { useReminders } from '../state/reminders';
import { useToast } from '../state/toast';
import { Icon } from './Icon';
import { Meter } from './Meter';
import { MoreSheet } from './MoreSheet';

function regimeKind(regime: RegimeView): ChipKind {
  if (regime.regime.startsWith('bull')) return 'ok';
  if (regime.regime.startsWith('panic')) return 'fail';
  return 'warn';
}

function RegimeChip({ market, regime }: { market: Market; regime: RegimeView }) {
  return (
    <Chip kind={regimeKind(regime)} title={regime.note}>
      {market} {regime.label} &middot; cap {pct(regime.deployCapPct, 0)} &middot; delta &le; {n2(regime.deltaCap)}
    </Chip>
  );
}

/** Runs the scan and reports the counts. Shown on the Puts page; Home has the same button in its Puts panel. */
export function RunScanButton({ compact = false }: { compact?: boolean }) {
  const scan = useMutation();
  const toast = useToast();
  const runScan = async () => {
    const view = await scan.run(() => api.runScan());
    if (view) toast.push(`Scan finished: ${view.ideas.length} ideas, ${view.rejected.length} not recommended.`);
  };
  return (
    <button
      type="button"
      className={compact ? 'btn sm primary' : 'btn primary'}
      onClick={runScan}
      disabled={scan.busy}
      aria-label={scan.busy ? 'Scanning' : 'Run scan'}
    >
      <Icon name="scan" size={compact ? 16 : 18} className={scan.busy ? 'ic spin' : 'ic'} />
      <span className="lbl">{scan.busy ? 'Scanning...' : 'Run scan'}</span>
    </button>
  );
}

/** The bell: Reminders, with the count due today. */
function Bell() {
  const { due } = useReminders();
  const label = due > 0 ? `Reminders, ${due} due today` : 'Reminders';
  return (
    <a className="btn icon bell" href={toHash({ page: 'reminders' })} aria-label={label} title={label}>
      <Icon name="bell" size={20} />
      {due > 0 ? <span className="bdg">{due > 99 ? '99+' : due}</span> : null}
    </a>
  );
}

/**
 * Page title, the regime and capital strip, and the global actions: the bell (Reminders) and More. On Home the title
 * is the day and the strip is left out: the session card under it carries the regime and the meters. On a phone the
 * strip drops to its own horizontally scrolling row.
 */
export function TopBar({ page }: { page: PageId }) {
  const { data: overview, error } = useOverview();
  const [more, setMore] = useState(false);
  const now = useNow(page === 'home', 30_000);
  const title = page === 'home' ? sessionState(new Date(now)).dateTitle : PAGE_TITLES[page];

  return (
    <header className="top">
      <div className="title">
        <h1>{title}</h1>
        {overview ? <span className="asof">as of {overview.asOf}</span> : null}
      </div>
      <div className="top-actions">
        {page === 'puts' ? <RunScanButton /> : null}
        <Bell />
        <button
          type="button"
          className="btn icon"
          onClick={() => setMore(true)}
          aria-label="More pages"
          title="More pages"
        >
          <Icon name="more" size={20} />
        </button>
      </div>
      {page === 'home' ? null : (
        <div className="strip">
          <RegimeChips overview={overview} />
          {overview ? (
            <>
              <Meter market="US" deploy={overview.deployed.US} />
              <Meter market="HK" deploy={overview.deployed.HK} />
            </>
          ) : null}
          {error && !overview ? (
            <Chip kind="fail" title={error.message}>
              server unreachable
            </Chip>
          ) : null}
        </div>
      )}
      {more ? <MoreSheet onClose={() => setMore(false)} /> : null}
    </header>
  );
}

function RegimeChips({ overview }: { overview: OverviewView | undefined }) {
  if (!overview) return null;
  return (
    <>
      {(['US', 'HK'] as const).map((market) => {
        const regime = overview.regime[market];
        return regime ? <RegimeChip key={market} market={market} regime={regime} /> : null;
      })}
    </>
  );
}

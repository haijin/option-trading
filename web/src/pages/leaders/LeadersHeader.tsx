import type { LeadersView } from '../../api/types';
import { Icon } from '../../layout/Icon';
import { asOfLine } from './leadersLib';

/**
 * The run time, Refresh, and the regime line with the posture it implies. In watch-only (panic or crash guard) the regime
 * line turns amber and says that pullback entries are off.
 */
export function LeadersHeader({
  view,
  loading,
  busy,
  onRefresh,
}: {
  view: LeadersView | undefined;
  loading: boolean;
  busy: boolean;
  onRefresh: () => void;
}) {
  const regime = view?.regime ?? null;
  const watchOnly = regime?.posture === 'watch_only';
  return (
    <header className="ld-head">
      <div className="ld-headrow">
        <span className="ld-asof" aria-live="polite">
          {view ? asOfLine(view) : loading ? 'Loading' : 'Not loaded'}
        </span>
        <button
          type="button"
          className="ld-refresh"
          onClick={onRefresh}
          disabled={busy}
          aria-label={busy ? 'Refreshing leaders' : 'Refresh leaders'}
        >
          <Icon name="scan" size={16} className={busy ? 'ic spin' : 'ic'} />
          {busy ? 'Refreshing' : 'Refresh'}
        </button>
      </div>
      {regime ? (
        <div className={`ld-regime${watchOnly ? ' off' : ''}`}>
          <span className="dot" aria-hidden="true" />
          <b>{regime.line}</b>
          <span className="post">· {regime.postureText}</span>
        </div>
      ) : null}
    </header>
  );
}

import { useState } from 'react';
import { api } from '../../api/endpoints';
import type { LeaderRecordExtreme, LeaderRecordView } from '../../api/types';
import { ErrorBanner } from '../../components/Callout';
import { Skeleton } from '../../components/Skeleton';
import { useResource } from '../../hooks/useResource';
import { num } from '../../lib/format';
import { fmtDayMonth } from '../../lib/news';
import { tone } from './leadersLib';

type RecordWindow = LeaderRecordView['window'];

/** "+7.4R · CLS · 2 Sep" / "-1.3R · XYZ · gap through the stop · 18 Sep" (a true minus sign). */
export function extremeText(e: LeaderRecordExtreme | null): string {
  if (!e) return '-';
  const r = `${e.r >= 0 ? '+' : '−'}${num(Math.abs(e.r), 1)}R`;
  return [r, e.symbol, e.note, fmtDayMonth(e.day)].filter((part) => part !== null && part !== '').join(' · ');
}

const share = (part: number, whole: number): string => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '-');

function Tile({
  label,
  value,
  small,
  toneClass = '',
}: {
  label: string;
  value: string;
  small?: string;
  toneClass?: string;
}) {
  return (
    <div className="t">
      <div className="l">{label}</div>
      <div className={`v ${toneClass}`.trim()}>
        {value}
        {small ? <small>{small}</small> : null}
      </div>
    </div>
  );
}

function Tiles({ r }: { r: LeaderRecordView }) {
  if (r.setups === 0) {
    return (
      <p className="ld-note">
        No Setup has been counted in this window yet. The record fills in as shown Setups reach 3R or their stop.
      </p>
    );
  }
  return (
    <div className="ld-rec">
      <Tile label="Setups shown" value={num(r.setups)} />
      <Tile label="Reached 3R first" value={share(r.hit3r, r.setups)} small={` ${r.hit3r}`} />
      <Tile label="Stopped first" value={share(r.stopped, r.setups)} small={` ${r.stopped}`} />
      <Tile label="Still open" value={num(r.open)} />
      <Tile
        label="Avg R (20 d)"
        value={r.avgR === null ? '-' : `${r.avgR >= 0 ? '+' : '−'}${num(Math.abs(r.avgR), 2)}`}
        toneClass={tone(r.avgR)}
      />
      <Tile label="Median days to 3R" value={r.medianDaysTo3r === null ? '-' : num(r.medianDaysTo3r)} />
      <div className="t wide">
        <div className="l">Best · worst</div>
        <div className="v sm">
          <span>{extremeText(r.best)}</span>
          <span>{extremeText(r.worst)}</span>
        </div>
      </div>
    </div>
  );
}

/** The app's own forward record over the Setups it showed: last 60 days or all time. Numbers only, and what they are not. */
export function RecordCard() {
  const [win, setWin] = useState<RecordWindow>('60');
  const record = useResource((signal) => api.leadersRecord(win, signal), [win]);
  const r = record.data;
  return (
    <section className="ld-card ld-panel" aria-label="How past signals did">
      <h2 className="ld-h">How past signals did</h2>
      <div className="ld-rwin">
        <button
          type="button"
          className={win === '60' ? 'on' : ''}
          aria-pressed={win === '60'}
          onClick={() => setWin('60')}
        >
          Last 60 days
        </button>
        <button
          type="button"
          className={win === 'all' ? 'on' : ''}
          aria-pressed={win === 'all'}
          onClick={() => setWin('all')}
        >
          All time
        </button>
      </div>
      {record.loading ? (
        <div aria-busy="true" className="ld-rec-skel">
          <span className="sr-only">Loading</span>
          <Skeleton height={56} />
          <Skeleton height={56} />
        </div>
      ) : record.error && !r ? (
        <ErrorBanner error={record.error} onRetry={record.refresh} title="Could not load the record." />
      ) : r ? (
        <>
          <Tiles r={r} />
          <p className="ld-note">
            Counted from the close of the day a Setup was shown, entry at that close, exit at 3R or the stop, else
            marked at 20 days. Watch names that later printed a Setup: {r.watchToSetup.became} of {r.watchToSetup.of}.
            This is the app's own forward record, not a backtest; the edge, if any, is in the stop, not the entry.
            {r.since ? ` Counting since ${fmtDayMonth(r.since)} ${r.since.slice(0, 4)}.` : ''}
          </p>
        </>
      ) : null}
    </section>
  );
}

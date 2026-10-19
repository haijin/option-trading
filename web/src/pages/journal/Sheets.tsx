import { type ReactNode, useEffect, useState } from 'react';
import { JOURNAL_TEMPLATES } from '../../../../src/journal';
import { api } from '../../api/endpoints';
import type { JournalRevisionView } from '../../api/types';
import { ErrorBanner } from '../../components/Callout';
import { Skeleton } from '../../components/Skeleton';
import { cardDate, localDay, localTime, longDate } from './dates';
import type { TemplateId } from './entryModel';
import { Sheet } from './Sheet';

function MenuIcon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

/** The "..." menu: History, Apply a template, Export, Close or Reopen the day, Delete. */
export function MoreSheet({
  date,
  onClose,
  revisionCount,
  closed,
  saved,
  onHistory,
  onTemplates,
  onExport,
  onToggleClosed,
  onDelete,
}: {
  date: string;
  onClose: () => void;
  revisionCount: number | null;
  closed: boolean;
  /** The entry exists on the server: History, Export, Close and Delete have something to act on. */
  saved: boolean;
  onHistory: () => void;
  onTemplates: () => void;
  onExport: () => void;
  onToggleClosed: () => void;
  onDelete: () => void;
}) {
  return (
    <Sheet title={longDate(date)} onClose={onClose}>
      <div className="jr-menu">
        <button type="button" onClick={onHistory} disabled={!saved}>
          <MenuIcon>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </MenuIcon>
          History
          {revisionCount !== null ? (
            <span className="jr-menu-note">
              {revisionCount} {revisionCount === 1 ? 'revision' : 'revisions'}
            </span>
          ) : null}
        </button>
        <button type="button" onClick={onTemplates}>
          <MenuIcon>
            <path d="M5 4h14v16H5z" />
            <path d="M8 8h8M8 12h8M8 16h5" />
          </MenuIcon>
          Apply a template
        </button>
        <button type="button" onClick={onExport} disabled={!saved}>
          <MenuIcon>
            <path d="M12 3v12M7 10l5 5 5-5M4 21h16" />
          </MenuIcon>
          Export as Markdown
        </button>
        <button type="button" onClick={onToggleClosed} disabled={!saved}>
          <MenuIcon>
            <path d="M5 12l5 5L20 7" />
          </MenuIcon>
          {closed ? 'Reopen day' : 'Close day'}
          <span className="jr-menu-note">{closed ? 'Closed' : 'Draft'}</span>
        </button>
        <button type="button" className="danger" onClick={onDelete} disabled={!saved}>
          <MenuIcon>
            <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
          </MenuIcon>
          Delete entry
        </button>
      </div>
      {saved ? null : (
        <p className="jr-note">
          This day has no saved entry yet. History, export, close and delete work once you have typed something.
        </p>
      )}
    </Sheet>
  );
}

/** "Tue 13 Oct 16:42" for an older revision, just "16:42" for today's. */
function whenText(iso: string): string {
  const day = localDay(new Date(iso));
  return day === localDay() ? localTime(iso) : `${cardDate(day)} ${localTime(iso)}`;
}

/** Every revision, newest first, with Restore. Restore appends a new revision; nothing is deleted. */
export function HistorySheet({
  date,
  onClose,
  onRestore,
}: {
  date: string;
  onClose: () => void;
  onRestore: (no: number) => Promise<void>;
}) {
  const [revisions, setRevisions] = useState<JournalRevisionView[] | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState<number | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` is the retry trigger
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    api.journalRevisions(date, controller.signal).then(
      (list) => {
        if (!controller.signal.aborted) setRevisions(list);
      },
      (e: unknown) => {
        if (!controller.signal.aborted) setError(e instanceof Error ? e : new Error(String(e)));
      },
    );
    return () => controller.abort();
  }, [date, tick]);

  return (
    <Sheet title="History" onClose={onClose}>
      {error ? (
        <ErrorBanner error={error} onRetry={() => setTick((t) => t + 1)} title="Could not load the history." />
      ) : revisions === null ? (
        <div aria-busy="true" style={{ display: 'grid', gap: 8 }}>
          <span className="sr-only">Loading</span>
          <Skeleton height={44} />
          <Skeleton height={44} />
          <Skeleton height={44} />
        </div>
      ) : (
        <ul className="jr-hist" aria-label="Revisions">
          {revisions.map((r) => (
            <li key={r.no} className="jr-h">
              <span className="jr-h-t">{whenText(r.at)}</span>
              <span className="jr-h-w">
                <span>{r.label}</span>
                <small className="jr-h-sub">
                  {r.source === 'ai_accepted'
                    ? 'AI'
                    : r.source === 'restore'
                      ? 'Restore'
                      : r.source === 'template'
                        ? 'Template'
                        : 'You'}
                  {' · '}
                  {r.wordCount} {r.wordCount === 1 ? 'word' : 'words'}
                </small>
              </span>
              {r.current ? (
                <span className="jr-cur">Current</span>
              ) : (
                <button
                  type="button"
                  className="btn sm"
                  disabled={busy !== null}
                  onClick={async () => {
                    setBusy(r.no);
                    try {
                      await onRestore(r.no);
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  {busy === r.no ? 'Restoring…' : 'Restore'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="jr-note">
        Every 10 minutes of typing, every template and every restore makes a revision. Restore never deletes; it adds a
        new revision.
      </p>
    </Sheet>
  );
}

/** The four templates. On an empty entry they fill it; on one with text they are appended below. */
export function TemplateSheet({ onClose, onPick }: { onClose: () => void; onPick: (id: TemplateId) => void }) {
  return (
    <Sheet title="Start from a template" onClose={onClose}>
      <div className="jr-tpls">
        {JOURNAL_TEMPLATES.map((t) => (
          <button key={t.id} type="button" className="jr-tpl" onClick={() => onPick(t.id)}>
            <b className="jr-tpl-t">{t.label}</b>
            <span>{t.blurb}</span>
          </button>
        ))}
      </div>
      <p className="jr-note">
        Templates insert headings and prompts into an empty entry. On an entry with text they are appended below.
      </p>
    </Sheet>
  );
}

/** Another device saved this day first. The person decides; nothing is overwritten silently. */
export function ConflictSheet({
  onReload,
  onKeepMine,
}: {
  onReload: () => Promise<void>;
  onKeepMine: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<'reload' | 'keep' | null>(null);
  const run = (which: 'reload' | 'keep', action: () => Promise<void>) => async () => {
    setBusy(which);
    try {
      await action();
    } finally {
      setBusy(null);
    }
  };
  return (
    <Sheet
      title="This entry changed on another device"
      dismissible={false}
      onClose={() => undefined}
      footer={
        <>
          <button type="button" className="btn" disabled={busy !== null} onClick={run('reload', onReload)}>
            {busy === 'reload' ? 'Reloading…' : 'Reload'}
          </button>
          <button type="button" className="btn primary" disabled={busy !== null} onClick={run('keep', onKeepMine)}>
            {busy === 'keep' ? 'Saving…' : 'Keep mine'}
          </button>
        </>
      }
    >
      <p>
        Someone, probably you on another device, saved this day after you opened it here. Nothing was overwritten and
        what you typed is still on this screen and on this phone.
      </p>
      <p>
        <b>Reload</b> shows the other version and drops what you typed here since. <b>Keep mine</b> saves your text over
        the other version.
      </p>
    </Sheet>
  );
}

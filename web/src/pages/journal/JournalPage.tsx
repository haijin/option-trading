import { useCallback, useEffect, useRef, useState } from 'react';
import { useIsMobile } from '../../hooks/useMediaQuery';
import { useRouter } from '../../state/router';
import { useToast } from '../../state/toast';
import '../../styles/journal.css';
import { localDay } from './dates';
import { EntryEditor } from './EntryEditor';
import { EntryList } from './EntryList';

/**
 * True once an entry was opened from inside the app. Then the in-app back arrow can step back in history (the list is
 * the entry before it). After a reload or a link straight to a day there is no such entry, and the arrow goes to the list.
 */
let openedInApp = false;

/** The local calendar day, refreshed when the phone wakes up or the clock passes midnight. */
function useToday(): string {
  const [today, setToday] = useState(() => localDay());
  useEffect(() => {
    const tick = () => setToday(localDay());
    const timer = setInterval(tick, 60_000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, []);
  return today;
}

/**
 * Journal page. A phone shows the list or the editor, one at a time; opening an entry is a history entry
 * (`#/journal/2026-10-13`) so the swipe-back gesture and the Back button return to the list. From 900 px the list sits
 * in a 380 px column beside the editor.
 */
export default function JournalPage() {
  const { route, navigate, replace } = useRouter();
  const mobile = useIsMobile();
  const toast = useToast();
  const today = useToday();
  const date = route.date;
  const [refreshKey, setRefreshKey] = useState(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The phone's own header replaces the app's top bar on this page (journal.css), and the editor reserves room for its toolbar.
  useEffect(() => {
    document.body.classList.add('jr-page');
    return () => document.body.classList.remove('jr-page');
  }, []);
  useEffect(() => {
    document.body.classList.toggle('jr-editing', mobile && date !== undefined);
    return () => document.body.classList.remove('jr-editing');
  }, [mobile, date]);

  // A newly opened entry starts at the top (the scroller is the shell's body, not the window).
  useEffect(() => {
    if (date !== undefined) document.getElementById('main')?.scrollTo(0, 0);
  }, [date]);

  useEffect(
    () => () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    },
    [],
  );

  /** Something changed on the server (a save, a restore, a delete): refetch the lists, but not on every autosave tick. */
  const onChanged = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => setRefreshKey((k) => k + 1), 600);
  }, []);

  const open = useCallback(
    (day: string) => {
      openedInApp = true;
      navigate({ page: 'journal', date: day });
    },
    [navigate],
  );

  const back = useCallback(() => {
    if (openedInApp && window.history.length > 1) window.history.back();
    else replace({ page: 'journal' });
  }, [replace]);

  const onNew = useCallback(
    (exists: boolean) => {
      if (exists) toast.push('Today already has an entry. Opened it.');
      open(today);
    },
    [open, today, toast],
  );

  const onDeleted = useCallback(() => {
    // on desktop the editor is beside the list: just clear the selection
    if (mobile) back();
    else replace({ page: 'journal' });
  }, [mobile, back, replace]);

  const list = <EntryList today={today} selected={date} refreshKey={refreshKey} onOpen={open} onNew={onNew} />;
  const editor =
    date !== undefined ? (
      <EntryEditor key={date} date={date} onBack={back} onDeleted={onDeleted} onChanged={onChanged} />
    ) : null;

  if (mobile) return <div className="jr-page">{editor ?? list}</div>;

  return (
    <div className="jr-page jr-two">
      <aside className="jr-left" aria-label="Journal entries">
        {list}
      </aside>
      <section className="jr-detail" aria-label="Entry">
        {editor ?? (
          <div className="jr-empty-detail">
            <p>Pick an entry on the left, or start today&rsquo;s.</p>
            <button type="button" className="btn primary" onClick={() => onNew(false)}>
              Write today&rsquo;s entry
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

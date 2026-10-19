import { ErrorBanner } from '../../components/Callout';
import { Skeleton } from '../../components/Skeleton';
import { Icon } from '../../layout/Icon';
import { longDate } from './dates';
import { EditorBody } from './EditorBody';
import { useEntryLoad } from './useEntryLoad';

function Header({ date, onBack }: { date: string; onBack: () => void }) {
  return (
    <header className="jr-edtop">
      <div className="jr-row">
        <button type="button" className="jr-back" onClick={onBack}>
          <Icon name="back" size={18} strokeWidth={2.2} />
          Journal
        </button>
        <div className="jr-ttl">
          <b className="jr-date">{longDate(date)}</b>
        </div>
        <span className="jr-more" aria-hidden="true" />
      </div>
    </header>
  );
}

/**
 * The editor for one day. It loads the entry first (404 means an empty day that is not on the server yet), then hands the
 * data to `EditorBody`, which owns the text from there on. Give it `key={date}`: a different day is a different editor.
 */
export function EntryEditor({
  date,
  onBack,
  onDeleted,
  onChanged,
}: {
  date: string;
  onBack: () => void;
  onDeleted: () => void;
  onChanged: () => void;
}) {
  const { load, retry } = useEntryLoad(date);

  if (load.kind === 'loading') {
    return (
      <div className="jr-editorpane" aria-busy="true">
        <Header date={date} onBack={onBack} />
        <div className="jr-meta-wrap">
          <Skeleton height={32} />
          <Skeleton height={40} />
          <Skeleton height={40} />
        </div>
        <Skeleton height={240} style={{ margin: '0 14px' }} />
      </div>
    );
  }
  if (load.kind === 'error') {
    return (
      <div className="jr-editorpane">
        <Header date={date} onBack={onBack} />
        <div className="jr-pad">
          <ErrorBanner error={load.error} onRetry={retry} title="Could not open this entry." />
        </div>
      </div>
    );
  }
  return (
    <EditorBody
      date={date}
      server={load.server}
      local={load.local}
      offline={load.offline}
      onBack={onBack}
      onDeleted={onDeleted}
      onChanged={onChanged}
    />
  );
}

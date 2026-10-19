import { api } from '../../api/endpoints';
import { ErrorBanner } from '../../components/Callout';
import { ListSkeleton } from '../../components/Skeleton';
import { useResource } from '../../hooks/useResource';
import { cardDate } from './dates';

/** Every "Lesson:" paragraph (and bullets from an accepted "Lessons & actions" rewrite), each opening its entry. */
export function LessonsView({ refreshKey, onOpen }: { refreshKey: number; onOpen: (date: string) => void }) {
  const lessons = useResource((signal) => api.journalLessons(60, signal), [], {
    refetchOnWrite: false,
    softDeps: [refreshKey],
  });
  if (lessons.loading) return <ListSkeleton rows={4} />;
  if (lessons.error && !lessons.data) {
    return <ErrorBanner error={lessons.error} onRetry={lessons.refresh} title="Could not load the lessons." />;
  }
  const list = lessons.data?.lessons ?? [];
  if (list.length === 0) {
    return (
      <p className="jr-empty">
        No lessons yet. Start a paragraph with &ldquo;Lesson:&rdquo; (the callout button does it) and it shows up here.
      </p>
    );
  }
  return (
    <div className="jr-entries">
      {list.map((lesson, i) => (
        <button
          // biome-ignore lint/suspicious/noArrayIndexKey: the server may return several lessons of one day with identical text
          key={`${lesson.date}:${i}`}
          type="button"
          className="jr-card jr-lesson"
          onClick={() => onOpen(lesson.date)}
        >
          <span className="jr-q">{lesson.text}</span>
          <span className="jr-src">
            <span>{cardDate(lesson.date)}</span>
            {lesson.mentions.map((m) => (
              <span key={`${m.market}:${m.symbol}`} className="jr-chip jr-tk">
                {m.label}
              </span>
            ))}
            {lesson.source === 'ai' ? <span className="jr-chip ai jr-right">AI extracted</span> : null}
          </span>
        </button>
      ))}
      <p className="jr-note">
        Lessons are every paragraph that starts with &ldquo;Lesson:&rdquo; and, later, the ones the &ldquo;Lessons &amp;
        actions&rdquo; rewrite adds. Tap one to open the entry.
      </p>
    </div>
  );
}

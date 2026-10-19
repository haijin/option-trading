import { api } from '../../api/endpoints';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { useResource } from '../../hooks/useResource';
import { useOverview } from '../../state/overview';
import { hkToday, useReminders } from '../../state/reminders';
import { GlanceBar } from './GlanceBar';
import { LeadersPanel, leadersSummary } from './LeadersPanel';
import { NewsPanel, newsSummary } from './NewsPanel';
import { PutsPanel, putsSummary } from './PutsPanel';
import { RemindersPanel, remindersSummary } from './RemindersPanel';
import { isActive, ResearchPanel, researchSummary } from './ResearchPanel';
import { SessionCard } from './SessionCard';

/** The desktop grid (dashboard.css) starts here: every panel on one screen, each scrolling inside its own box. */
const DESK_QUERY = '(min-width: 1100px)';
const TABLET_QUERY = '(min-width: 700px)';

/**
 * Rows per panel: three on a phone, four on a tablet, and on the desk as many as the box holds before it scrolls. Puts,
 * the tall column, is given more there than the rest.
 */
const useRows = (): { rows: number; putsRows: number } => {
  const desk = useMediaQuery(DESK_QUERY);
  const tablet = useMediaQuery(TABLET_QUERY);
  const rows = desk ? 8 : tablet ? 4 : 3;
  return { rows, putsRows: desk ? 10 : rows };
};

/**
 * Home: the desk you open before each market. The session clock, then every module, each a summary of a page that
 * exists (docs/designs/app-dashboard.md). Home computes nothing of its own. On a laptop the six blocks fill the window
 * with no page scroll; on a phone or tablet a glance bar under the session card carries one figure per module and
 * jumps to its panel.
 */
export function HomePage() {
  const overview = useOverview();
  const scan = useResource((signal) => api.scan(signal), []);
  const leaders = useResource((signal) => api.leaders({}, signal), []);
  const news = useResource((signal) => api.news({ scope: 'shortlist', days: 1, neutral: false }, signal), []);
  const brief = useResource((signal) => api.newsBrief(hkToday(), signal), []);
  const runs = useResource((signal) => api.researchRunsAll(signal), [], {
    pollWhile: (list) => list.some(isActive),
    pollMs: 5000,
  });
  const catalog = useResource((signal) => api.skills(signal), [], { refetchOnWrite: false });
  const reminders = useReminders();
  const { rows, putsRows } = useRows();
  return (
    <div className="page home">
      <SessionCard overview={overview.data} />
      <GlanceBar
        tiles={[
          { id: 'puts', title: 'Puts to sell', summary: putsSummary(scan) },
          { id: 'leaders', title: 'Leaders at support', summary: leadersSummary(leaders) },
          { id: 'news', title: 'Key news', summary: newsSummary(news) },
          { id: 'research', title: 'Research', summary: researchSummary(runs) },
          { id: 'remind', title: 'Reminders', summary: remindersSummary(reminders) },
        ]}
      />
      <PutsPanel scan={scan} limit={putsRows} />
      <LeadersPanel leaders={leaders} limit={rows} />
      <NewsPanel news={news} brief={brief} limit={rows} />
      <ResearchPanel runs={runs} catalog={catalog} limit={rows} />
      <RemindersPanel limit={rows + 1} />
    </div>
  );
}

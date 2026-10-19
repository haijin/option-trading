import type { NewsBriefDayView, NewsGroupView, NewsImpact, NewsItemView, NewsView } from '../../api/types';
import type { Resource } from '../../hooks/useResource';
import { hkTime, hostOf, IMPACT_LABEL } from '../../lib/news';
import { toHash } from '../../lib/route';
import { Empty, HomePanel, PanelState, type PanelSummary } from './HomePanel';

const ORDER: Record<NewsImpact, number> = { blocks: 0, caution: 1, supports: 2, neutral: 3 };

interface Story {
  group: NewsGroupView;
  item: NewsItemView;
  impact: NewsImpact;
}

/** The stories that touch the shortlist and open puts, most consequential first. */
export function rankStories(groups: NewsGroupView[]): Story[] {
  const out: Story[] = [];
  for (const group of groups) {
    for (const item of group.items) {
      if (!item.impact) continue;
      out.push({ group, item, impact: item.impact });
    }
  }
  return out.sort((a, b) => ORDER[a.impact] - ORDER[b.impact] || b.item.publishedAt.localeCompare(a.item.publishedAt));
}

function StoryRow({ story }: { story: Story }) {
  const { group, item, impact } = story;
  return (
    <a className="hm-row nw" href={toHash({ page: 'news' })}>
      <span className="l1">
        <span className={`hm-imp ${impact}`}>{IMPACT_LABEL[impact]}</span>
        <b>{group.symbol}</b>
        <span>{hostOf(item.url) || item.source}</span>
        <span className="t">{hkTime(item.publishedAt)}</span>
      </span>
      <span className="h">{item.title}</span>
      {item.summary ? <span className="w">{item.summary}</span> : null}
    </a>
  );
}

export function newsSummary(news: Resource<NewsView>): PanelSummary {
  if (!news.data) return { count: null, kind: 'quiet', tile: null };
  const stories = rankStories(news.data.groups);
  const blocking = stories.filter((s) => s.impact === 'blocks').length;
  return {
    count: blocking > 0 ? `${blocking} blocking` : String(stories.length),
    kind: blocking > 0 ? 'fail' : stories.length > 0 ? 'ok' : 'quiet',
    tile:
      blocking > 0 ? { value: String(blocking), label: 'Blocking' } : { value: String(stories.length), label: 'News' },
  };
}

/** Key news: the latest market brief, then the stories read against your standing in each name. */
export function NewsPanel({
  news,
  brief,
  limit,
}: {
  news: Resource<NewsView>;
  brief: Resource<NewsBriefDayView>;
  limit: number;
}) {
  const data = news.data;
  const stories = data ? rankStories(data.groups) : [];
  const latest = brief.data?.briefs[brief.data.briefs.length - 1] ?? null;
  const summary = newsSummary(news);
  return (
    <HomePanel
      id="news"
      title="Key news"
      count={summary.count}
      countKind={summary.kind}
      page="news"
      foot={
        data ? (
          <>
            <span>
              {data.total} {data.total === 1 ? 'story' : 'stories'} on {data.groups.length}{' '}
              {data.groups.length === 1 ? 'name' : 'names'} in 24 h
            </span>
            <span className="right">
              {data.status.fetchedAt ? `fetched ${hkTime(data.status.fetchedAt)}` : 'nothing fetched yet'}
            </span>
          </>
        ) : null
      }
    >
      {latest ? (
        <div className="hm-brief">
          <div className="lead">{latest.lead}</div>
          {latest.forPuts ? <div className="fp">{latest.forPuts}</div> : null}
        </div>
      ) : null}
      <PanelState resource={news} title="Could not load the news." />
      {stories.slice(0, limit).map((story) => (
        <StoryRow key={story.item.id} story={story} />
      ))}
      {data && stories.length === 0 ? (
        <Empty>
          {data.counts.shortlist === 0
            ? 'No names on the shortlist yet: the stories for the names the scan recommends appear here.'
            : 'No classified story on your names in the last 24 hours.'}
        </Empty>
      ) : null}
    </HomePanel>
  );
}

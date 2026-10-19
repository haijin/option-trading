import type { NewsGroupView } from '../../api/types';
import { n2, signedPct } from '../../lib/format';
import { tickerLabel } from '../../lib/symbols';
import { NewsItem } from './NewsItem';

/** One card per name: symbol, price, the standing now (coloured by state), then its stories newest first. */
export function StockGroup({
  group,
  date,
  today,
  q,
  openIds,
  onToggle,
}: {
  group: NewsGroupView;
  date: string;
  today: string;
  q: string;
  openIds: ReadonlySet<number>;
  onToggle: (id: number) => void;
}) {
  const chg = group.changePct;
  const tone = chg === null || chg === 0 ? 'faint' : chg > 0 ? 'pos' : 'neg';
  return (
    <article
      className={`news-card news-grp ${group.standing.kind}`}
      aria-label={tickerLabel(group.market, group.symbol)}
    >
      <header className="news-gh">
        <span className="sym">
          {tickerLabel(group.market, group.symbol)}
          {group.name ? <small>{group.name}</small> : null}
        </span>
        <span className="px num">
          {group.price === null ? '–' : n2(group.price)}
          {chg === null ? null : <small className={tone}>{signedPct(chg)}</small>}
        </span>
        <span className="stand">
          {group.standing.label}
          {group.standing.detail ? <span className="m">{group.standing.detail}</span> : null}
          <span className="then">now</span>
        </span>
      </header>
      {group.items.map((item) => (
        <NewsItem
          key={item.id}
          item={item}
          group={group}
          date={date}
          today={today}
          q={q}
          open={openIds.has(item.id)}
          onToggle={() => onToggle(item.id)}
        />
      ))}
    </article>
  );
}

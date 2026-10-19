import type { NewsGroupView, NewsItemView } from '../../api/types';
import { fmtDay, highlightParts, hostOf, IMPACT_LABEL, safeHref, sameStanding, whenLabel } from '../../lib/news';
import { toHash } from '../../lib/route';

const AI_STAGE_TIP = 'coming with AI analysis stage B3';

/** Hong Kong calendar date of an ISO instant, 'YYYY-MM-DD'. */
const hkDate = (iso: string): string => new Date(new Date(iso).getTime() + 8 * 3_600_000).toISOString().slice(0, 10);

function Highlighted({ text, q }: { text: string; q: string }) {
  return (
    <>
      {highlightParts(text, q).map((p, i) =>
        p.hit ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts of one string never reorder
          <mark key={i}>{p.text}</mark>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts of one string never reorder
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

/**
 * One story. The header is the button that expands it; the actions live below it, outside the button. A story the model has
 * not judged yet (no impact) has no badge and says "New": it is never shown as Neutral.
 */
export function NewsItem({
  item,
  group,
  date,
  today,
  q,
  open,
  onToggle,
}: {
  item: NewsItemView;
  group: NewsGroupView;
  date: string;
  today: string;
  q: string;
  open: boolean;
  onToggle: () => void;
}) {
  const impact = item.impact;
  const href = safeHref(item.url);
  const then = item.standingThen;
  const showThen = then !== null && !sameStanding(then, group.standing);
  // The standing is the one the name had when the model judged the story, which is usually the story's own day.
  const thenDay = item.judgedAt ? hkDate(item.judgedAt) : item.day;
  const target = group.hasOpenPosition
    ? { label: 'Positions ›', href: toHash({ page: 'positions' }) }
    : { label: 'Puts ›', href: toHash({ page: 'puts', market: group.market, symbol: group.symbol }) };
  return (
    <div className={`news-item ${impact ?? 'new'}${open ? ' x' : ''}`}>
      <button type="button" className="news-ihead" aria-expanded={open} onClick={onToggle}>
        <span className="ih">
          {impact ? (
            <span className={`news-imp ${impact}`}>
              <span className="dot" />
              {IMPACT_LABEL[impact]}
            </span>
          ) : null}
          <span className="src">{item.source}</span>
          <span className="when">{whenLabel(item, date, today)}</span>
        </span>
        <h3>
          <Highlighted text={item.title} q={q} />
        </h3>
        <span className="so">
          {impact && item.summary ? (
            <>
              <b>{IMPACT_LABEL[impact]}</b>: {item.summary}
            </>
          ) : (
            <b>New</b>
          )}
        </span>
      </button>
      {open ? (
        <div className="news-more">
          {showThen && then ? (
            <span className="news-kv">
              <span className="k then" aria-hidden="true">
                ↺
              </span>
              <span>
                Standing on {fmtDay(thenDay)}: {then.label}
                {then.detail ? ` · ${then.detail}` : ''}. The impact line was written against that.
              </span>
            </span>
          ) : null}
          {item.rules.map((r) => (
            <span className="news-kv" key={`${r.key}-${r.text}`}>
              <span className={`k ${r.key}`}>{r.key.toUpperCase()}</span>
              <span>{r.text}</span>
            </span>
          ))}
          {item.snippet ? <span className="snippet">{item.snippet}</span> : null}
          <span className="cite">
            <span>Source</span>
            <span className="who">{item.source}</span>
            <span>{hostOf(item.url)}</span>
          </span>
          <span className="acts">
            {href ? (
              <a className="btn sm" href={href} target="_blank" rel="noopener noreferrer">
                Source
              </a>
            ) : null}
            <button
              type="button"
              className="btn sm"
              disabled
              title={AI_STAGE_TIP}
              aria-label={`Ask why: ${AI_STAGE_TIP}`}
            >
              Ask why
            </button>
            <a className="btn sm primary" href={target.href}>
              {target.label}
            </a>
          </span>
        </div>
      ) : null}
    </div>
  );
}

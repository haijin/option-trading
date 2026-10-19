import { useState } from 'react';
import type { NewsBriefDayView, NewsBriefView, NewsSessionId } from '../../api/types';
import { Icon } from '../../layout/Icon';
import { fmtDay, hkTime, safeHref } from '../../lib/news';

const SESSION_LABEL: Record<NewsSessionId, string> = { hk_open: 'HK open', us_open: 'US open', manual: 'Refresh' };

function tapeTone(changePct: number | null): string {
  if (changePct === null || changePct === 0) return '';
  return changePct > 0 ? 'up' : 'dn';
}

function noBriefText(day: NewsBriefDayView, date: string, today: string, aiAvailable: boolean): string {
  const d = date === today ? 'today' : fmtDay(date);
  switch (day.none) {
    case 'weekend':
      return `No brief for ${d}: the job runs on trading days only.`;
    case 'holiday':
      return `No brief for ${d}: both markets are closed.`;
    case 'before_start':
      return `No brief was written for ${d}${day.firstBriefDay ? ` (briefs started on ${fmtDay(day.firstBriefDay)})` : ''}.`;
    case 'not_yet':
      return `${d} has not happened yet.`;
    default:
      return aiAvailable
        ? `No brief has been written for ${d} yet. Refresh writes one from the market feeds.`
        : `No brief was written for ${d}: no AI executor is available on this machine.`;
  }
}

/** One session's brief: a lead, the tape, four tagged bullets, the put-selling line and the sources it cites. */
function Brief({ brief, date, today }: { brief: NewsBriefView; date: string; today: string }) {
  const [sources, setSources] = useState(false);
  return (
    <>
      <p className="news-lead">{brief.lead}</p>
      {brief.tape.length > 0 ? (
        <ul className="news-tape" aria-label="Market snapshot">
          {brief.tape.map((t) => (
            <li key={t.key} title={t.asOf ? `as of ${t.asOf}` : undefined}>
              {t.label}
              {t.value ? <b> {t.value}</b> : null}
              {t.changePct !== null ? (
                <b className={tapeTone(t.changePct)}>
                  {' '}
                  {t.changePct > 0 ? '+' : ''}
                  {t.changePct.toFixed(1)}%
                </b>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <ul className="news-pts">
        {brief.bullets.map((b) => (
          <li key={`${b.tag}-${b.text.slice(0, 24)}`}>
            <span className="tag">{b.tag}</span>
            <span>{b.text}</span>
          </li>
        ))}
      </ul>
      <div className="news-forput">
        <Icon name="arrowdown" size={18} />
        <span>For put selling: {brief.forPuts}</span>
      </div>
      <div className="news-srcs">
        <span>
          Written {hkTime(brief.asOf)}
          {date === today ? '' : ` on ${fmtDay(date)}`} from {brief.sources.length}{' '}
          {brief.sources.length === 1 ? 'source' : 'sources'}. Model summary, every line cited.
        </span>
        <button type="button" aria-expanded={sources} onClick={() => setSources((v) => !v)}>
          {sources ? 'Hide sources' : 'Sources ›'}
        </button>
      </div>
      {sources ? (
        <div className="news-srclist">
          {brief.sources.map((s) => (
            <a key={s.url} href={safeHref(s.url)} target="_blank" rel="noopener noreferrer">
              <span>{hkTime(s.publishedAt)}</span>
              <u>{s.source}</u>
              <span>{s.title}</span>
            </a>
          ))}
        </div>
      ) : null}
    </>
  );
}

/** The market brief card. A day with two sessions shows an HK open / US open toggle, the later one first. */
export function BriefCard({
  day,
  date,
  today,
  aiAvailable,
}: {
  day: NewsBriefDayView;
  date: string;
  today: string;
  aiAvailable: boolean;
}) {
  const [picked, setPicked] = useState<number | null>(null);
  if (day.briefs.length === 0) return <p className="news-nob">{noBriefText(day, date, today, aiAvailable)}</p>;
  const idx = Math.min(picked ?? day.briefs.length - 1, day.briefs.length - 1);
  const brief = day.briefs[idx] as NewsBriefView;
  return (
    <>
      {day.briefs.length > 1 ? (
        <div className="news-sess" role="tablist" aria-label="Brief session">
          {day.briefs.map((b, i) => (
            <button
              key={b.id}
              type="button"
              role="tab"
              aria-selected={i === idx}
              className={i === idx ? 'on' : ''}
              onClick={() => setPicked(i)}
            >
              {SESSION_LABEL[b.session]} {hkTime(b.asOf)}
            </button>
          ))}
        </div>
      ) : null}
      <Brief brief={brief} date={date} today={today} />
    </>
  );
}

/** The header summary of a brief section: 'Tue 13 Oct · HK open and US open · 5 sources'. */
export function briefSummary(day: NewsBriefDayView | undefined, date: string): string {
  if (!day || day.briefs.length === 0) return fmtDay(date);
  const last = day.briefs[day.briefs.length - 1] as NewsBriefView;
  const sessions =
    day.briefs.length > 1 ? day.briefs.map((b) => SESSION_LABEL[b.session]).join(' and ') : SESSION_LABEL[last.session];
  return `${fmtDay(date)} · ${sessions} · ${last.sources.length} sources`;
}

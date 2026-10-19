import { useState } from 'react';
import { links } from '../../api/endpoints';
import type { JournalCardView, JournalSummaryLineView } from '../../api/types';
import { cardDate, localTime, monthShort, type WeekDay } from './dates';
import { TEMPLATE_LABEL } from './entryModel';

/** The Markdown excerpt writes names as $NKE; the card shows them as typed in the chips. */
export const plainNames = (text: string): string => text.replace(/\$(?=(?:\d{4,5}\.HK|[A-Z][A-Z0-9.]{0,9})\b)/g, '');

const VIEW_CLASS = { bullish: 'bull', bearish: 'bear', neutral: 'neut' } as const;

/** The 64 x 44 thumbnail of an entry's first image (the 320 px WebP). A thumbnail that will not load is left out. */
function Thumb({ id }: { id: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <img
      className="jr-thumb"
      src={links.journalAssetUrl(id, true)}
      alt=""
      width={64}
      height={44}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

/** One entry in the list: date, chips, title, two lines of text, names, tags and the word count. */
export function EntryCard({
  entry,
  selected,
  onOpen,
}: {
  entry: JournalCardView;
  selected: boolean;
  onOpen: () => void;
}) {
  const draft = entry.status === 'draft';
  return (
    <button
      type="button"
      className={`jr-card jr-ent ${VIEW_CLASS[entry.marketView]}${draft ? ' draft' : ''}${selected ? ' sel' : ''}`}
      aria-current={selected ? 'true' : undefined}
      onClick={onOpen}
    >
      <span className="jr-hd">
        <span className="jr-d">{cardDate(entry.date)}</span>
        {entry.template && entry.template !== 'free' ? (
          <span className="jr-chip">{TEMPLATE_LABEL[entry.template]}</span>
        ) : null}
        {draft ? <span className="jr-chip warn">Draft</span> : null}
        {entry.aiPolished ? <span className="jr-chip ai">AI polished</span> : null}
        <span className="jr-when">{localTime(entry.updatedAt)}</span>
      </span>
      <span className={entry.thumbnailAssetId ? 'jr-body jr-hasthumb' : 'jr-body'}>
        <span className="jr-text">
          <span className={entry.title ? 'jr-h3' : 'jr-h3 jr-untitled'}>{entry.title ?? 'Untitled'}</span>
          {entry.excerpt ? <span className="jr-ex">{plainNames(entry.excerpt)}</span> : null}
        </span>
        {entry.thumbnailAssetId ? <Thumb id={entry.thumbnailAssetId} /> : null}
      </span>
      <span className="jr-with">
        {entry.mentions.map((m) => (
          <span key={`${m.market}:${m.symbol}`} className="jr-chip jr-tk">
            {m.label}
          </span>
        ))}
        {entry.tags.map((t) => (
          <span key={t} className="jr-chip">
            #{t}
          </span>
        ))}
        <span className="jr-n">
          {entry.wordCount} {entry.wordCount === 1 ? 'word' : 'words'}
        </span>
      </span>
    </button>
  );
}

/** The seven days of this week: a dot under days that have an entry, today tinted, tap a day to open or start it. */
export function WeekStrip({
  days,
  today,
  selected,
  has,
  onOpen,
}: {
  days: WeekDay[];
  today: string;
  selected: string | undefined;
  has: ReadonlySet<string>;
  onOpen: (date: string) => void;
}) {
  return (
    <nav className="jr-week" aria-label="This week">
      {days.map((d) => {
        const entry = has.has(d.date);
        const classes = [
          entry ? 'has' : '',
          d.date === today ? 'today' : '',
          d.date === selected ? 'sel' : '',
          d.weekend ? 'wknd' : '',
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <button
            key={d.date}
            type="button"
            className={classes}
            aria-label={`${d.dow} ${d.day}${entry ? ', has an entry' : ', no entry yet'}`}
            aria-current={d.date === today ? 'date' : undefined}
            onClick={() => onOpen(d.date)}
          >
            <span>{d.dow}</span>
            <b>{d.day}</b>
            <i aria-hidden="true" />
          </button>
        );
      })}
    </nav>
  );
}

/** "13 entries in Oct, 5 lessons, 9 names mentioned, 6-day streak". */
export function SummaryLine({ summary }: { summary: JournalSummaryLineView }) {
  return (
    <p className="jr-sumline">
      <span>
        <b>{summary.entries}</b> {summary.entries === 1 ? 'entry' : 'entries'} in {monthShort(summary.month)}
      </span>
      <span>
        <b>{summary.lessons}</b> {summary.lessons === 1 ? 'lesson' : 'lessons'}
      </span>
      <span>
        <b>{summary.names}</b> {summary.names === 1 ? 'name' : 'names'} mentioned
      </span>
      <span>
        <b>{summary.streak}-day</b> streak
      </span>
    </p>
  );
}

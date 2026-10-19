import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { JournalCardView } from '../../api/types';
import { weekOf } from './dates';
import { mergeEntries } from './EntryList';
import { EntryCard, plainNames, SummaryLine, WeekStrip } from './ListParts';

const card = (date: string, extra: Partial<JournalCardView> = {}): JournalCardView => ({
  date,
  title: `Entry ${date}`,
  template: 'evening',
  marketView: 'neutral',
  tags: ['hk'],
  status: 'draft',
  wordCount: 412,
  excerpt: 'Short text',
  mentions: [{ market: 'US', symbol: 'NKE', label: 'NKE', known: true }],
  thumbnailAssetId: null,
  aiPolished: false,
  updatedAt: '2026-10-13T08:42:00.000Z',
  ...extra,
});

const noop = () => undefined;

describe('mergeEntries', () => {
  it('keeps the fresh list first and adds older cards that are not in it', () => {
    const fresh = [card('2026-10-13'), card('2026-10-12')];
    const older = [card('2026-10-12', { title: 'stale' }), card('2026-10-10'), card('2026-10-09')];
    const merged = mergeEntries(fresh, older);
    expect(merged.map((e) => e.date)).toEqual(['2026-10-13', '2026-10-12', '2026-10-10', '2026-10-09']);
    expect(merged[1]?.title).toBe('Entry 2026-10-12');
  });

  it('drops an older card that now sits newer than the end of the fresh page (it was deleted or re-dated)', () => {
    const fresh = [card('2026-10-13'), card('2026-10-10')];
    expect(mergeEntries(fresh, [card('2026-10-11')]).map((e) => e.date)).toEqual(['2026-10-13', '2026-10-10']);
  });

  it('works with an empty fresh page', () => {
    expect(mergeEntries([], [card('2026-10-01')]).map((e) => e.date)).toEqual(['2026-10-01']);
  });
});

describe('plainNames', () => {
  it('removes the $ the Markdown excerpt puts in front of names, not the one in a price', () => {
    expect(plainNames('Sold $NKE and $0700.HK for $5 and $220')).toBe('Sold NKE and 0700.HK for $5 and $220');
  });
});

describe('the entry card', () => {
  it('shows the date, chips, title, excerpt, names, tags and the word count', () => {
    render(<EntryCard entry={card('2026-10-13', { aiPolished: true })} selected={false} onOpen={noop} />);
    expect(screen.getByText('Tue 13 Oct')).toBeInTheDocument();
    expect(screen.getByText('Evening review')).toBeInTheDocument();
    expect(screen.getByText('Draft')).toBeInTheDocument();
    expect(screen.getByText('AI polished')).toBeInTheDocument();
    expect(screen.getByText('Entry 2026-10-13')).toBeInTheDocument();
    expect(screen.getByText('NKE')).toBeInTheDocument();
    expect(screen.getByText('#hk')).toBeInTheDocument();
    expect(screen.getByText('412 words')).toBeInTheDocument();
  });

  it('colours the left border by market view and dashes a draft', () => {
    const { container, rerender } = render(
      <EntryCard
        entry={card('2026-10-13', { marketView: 'bullish', status: 'closed' })}
        selected={false}
        onOpen={noop}
      />,
    );
    const button = container.querySelector('button');
    expect(button).toHaveClass('bull');
    expect(button).not.toHaveClass('draft');
    rerender(<EntryCard entry={card('2026-10-13', { marketView: 'bearish' })} selected onOpen={noop} />);
    expect(container.querySelector('button')).toHaveClass('bear', 'draft', 'sel');
  });

  it('has no template chip for a free entry and says Untitled without a title', () => {
    render(<EntryCard entry={card('2026-10-13', { template: 'free', title: null })} selected={false} onOpen={noop} />);
    expect(screen.queryByText('Free write')).toBeNull();
    expect(screen.getByText('Untitled')).toBeInTheDocument();
  });
});

describe('the card thumbnail', () => {
  const ID = '11111111-1111-4111-8111-111111111111';

  it('shows the first image as a 64 x 44 lazy thumbnail with no alt text when the entry has one', () => {
    const { container } = render(
      <EntryCard entry={card('2026-10-13', { thumbnailAssetId: ID })} selected={false} onOpen={noop} />,
    );
    const img = container.querySelector('img') as HTMLImageElement;
    expect(img).toHaveAttribute('src', `/api/journal/assets/${ID}?thumb=1`);
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).toHaveAttribute('alt', '');
    expect(img).toHaveAttribute('width', '64');
    expect(img).toHaveAttribute('height', '44');
    expect(container.querySelector('.jr-hasthumb')).not.toBeNull();
  });

  it('has no image box without one, and drops a thumbnail that will not load', () => {
    const { container, rerender } = render(<EntryCard entry={card('2026-10-13')} selected={false} onOpen={noop} />);
    expect(container.querySelector('img')).toBeNull();
    rerender(<EntryCard entry={card('2026-10-13', { thumbnailAssetId: ID })} selected={false} onOpen={noop} />);
    fireEvent.error(container.querySelector('img') as HTMLImageElement);
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('the week strip and the summary line', () => {
  it('marks days with an entry and today', () => {
    render(
      <WeekStrip
        days={weekOf('2026-10-13')}
        today="2026-10-13"
        selected={undefined}
        has={new Set(['2026-10-12', '2026-10-13'])}
        onOpen={noop}
      />,
    );
    expect(screen.getByRole('button', { name: 'Mon 12, has an entry' })).toHaveClass('has');
    expect(screen.getByRole('button', { name: 'Tue 13, has an entry' })).toHaveClass('today', 'has');
    expect(screen.getByRole('button', { name: 'Wed 14, no entry yet' })).not.toHaveClass('has');
  });

  it('reads like the prototype', () => {
    const { container } = render(
      <SummaryLine summary={{ month: '2026-10', entries: 13, lessons: 5, names: 9, streak: 6 }} />,
    );
    expect(container.textContent).toBe('13 entries in Oct5 lessons9 names mentioned6-day streak');
  });
});

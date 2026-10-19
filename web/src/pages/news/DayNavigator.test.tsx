import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NewsDaysView, NewsScope } from '../../api/types';
import { DayNavigator } from './DayNavigator';

const newsDays = vi.fn();
vi.mock('../../api/endpoints', () => ({
  api: { newsDays: (...args: unknown[]) => newsDays(...args) },
}));

const TODAY = '2026-10-13';

function daysView(month: string, scope: NewsScope): NewsDaysView {
  return {
    month,
    scope,
    today: TODAY,
    earliest: '2026-09-30',
    days: [
      { day: '2026-10-13', impacts: ['blocks', 'caution', 'supports', 'neutral'], brief: true },
      { day: '2026-10-12', impacts: ['none'], brief: false },
      { day: '2026-10-09', impacts: [], brief: true },
    ],
  };
}

function Harness({
  start = TODAY,
  scope = 'shortlist',
  hideNeutral = false,
  onDate,
  onQuery,
}: {
  start?: string;
  scope?: NewsScope;
  hideNeutral?: boolean;
  onDate?: (d: string) => void;
  onQuery?: (q: string) => void;
}) {
  const [date, setDate] = useState(start);
  const [calOpen, setCalOpen] = useState(false);
  const [month, setMonth] = useState(start.slice(0, 7));
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  return (
    <DayNavigator
      date={date}
      today={TODAY}
      earliest="2026-09-30"
      onDate={(d) => {
        onDate?.(d);
        setDate(d);
      }}
      calendarOpen={calOpen}
      onCalendarOpen={setCalOpen}
      calendarMonth={month}
      onCalendarMonth={setMonth}
      searchOpen={searchOpen}
      onSearchOpen={setSearchOpen}
      query={query}
      onQuery={(q) => {
        onQuery?.(q);
        setQuery(q);
      }}
      scope={scope}
      hideNeutral={hideNeutral}
    />
  );
}

beforeEach(() => {
  newsDays.mockReset();
  newsDays.mockImplementation(async (month: string, scope: NewsScope) => daysView(month, scope));
});

describe('day navigator', () => {
  it('starts on today: full date, no "Back to today", next day disabled', () => {
    render(<Harness />);
    expect(screen.getByRole('button', { name: 'Pick a day' })).toHaveTextContent('Today');
    expect(screen.getByRole('button', { name: 'Pick a day' })).toHaveTextContent('Tue 13 Oct 2026');
    expect(screen.queryByRole('button', { name: 'Back to today' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Next day' })).toBeDisabled();
  });

  it('steps back a day, shows the archive label and a Back to today pill, and returns', async () => {
    const user = userEvent.setup();
    const onDate = vi.fn();
    render(<Harness onDate={onDate} />);
    await user.click(screen.getByRole('button', { name: 'Previous day' }));
    expect(onDate).toHaveBeenLastCalledWith('2026-10-12');
    expect(screen.getByRole('button', { name: 'Pick a day' })).toHaveTextContent('Mon 12 Oct');
    expect(screen.getByRole('button', { name: 'Pick a day' })).toHaveTextContent('2026 · yesterday');
    expect(screen.getByRole('button', { name: 'Next day' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Back to today' }));
    expect(onDate).toHaveBeenLastCalledWith(TODAY);
    expect(screen.getByRole('button', { name: 'Pick a day' })).toHaveTextContent('Today');
    expect(screen.queryByRole('button', { name: 'Back to today' })).toBeNull();
  });

  it('stops going back at the first day with data', async () => {
    render(<Harness start="2026-09-30" />);
    expect(screen.getByRole('button', { name: 'Previous day' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Pick a day' })).toHaveTextContent('13 days ago');
  });
});

describe('calendar', () => {
  it("opens on the selected day's month with the weekday offset, today ringed and the future disabled", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Calendar' }));
    const cal = screen.getByRole('group', { name: 'Calendar, Oct 2026' });
    expect(within(cal).getAllByRole('button', { name: /2026,?/ }).length).toBeGreaterThanOrEqual(31);
    expect(within(cal).getByRole('button', { name: /Tue 13 Oct 2026/ })).toHaveClass('today');
    expect(within(cal).getByRole('button', { name: /Wed 14 Oct 2026/ })).toBeDisabled();
    expect(within(cal).getByRole('button', { name: /Tue 13 Oct 2026/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Calendar' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('draws up to three dots a day, most severe first, a faint one for a brief-only day, and asks for the scope', async () => {
    const user = userEvent.setup();
    render(<Harness scope="positions" hideNeutral />);
    await user.click(screen.getByRole('button', { name: 'Calendar' }));
    await waitFor(() => expect(newsDays).toHaveBeenCalledWith('2026-10', 'positions', false, expect.anything()));
    const cal = screen.getByRole('group', { name: 'Calendar, Oct 2026' });
    const day13 = await within(cal).findByRole('button', { name: /Tue 13 Oct 2026, has news, has a brief/ });
    expect([...day13.querySelectorAll('.dots i')].map((i) => i.className)).toEqual(['blocks', 'caution', 'supports']);
    const day12 = within(cal).getByRole('button', { name: /Mon 12 Oct 2026, has news/ });
    expect([...day12.querySelectorAll('.dots i')].map((i) => i.className)).toEqual(['none']);
    const day9 = within(cal).getByRole('button', { name: /Fri 9 Oct 2026, has a brief/ });
    expect([...day9.querySelectorAll('.dots i')].map((i) => i.className)).toEqual(['brief']);
    expect(
      within(cal)
        .getByRole('button', { name: /Sat 10 Oct 2026$/ })
        .querySelectorAll('.dots i'),
    ).toHaveLength(0);
  });

  it('picking a day loads it and closes the calendar', async () => {
    const user = userEvent.setup();
    const onDate = vi.fn();
    render(<Harness onDate={onDate} />);
    await user.click(screen.getByRole('button', { name: 'Calendar' }));
    await user.click(await screen.findByRole('button', { name: /Fri 9 Oct 2026/ }));
    expect(onDate).toHaveBeenCalledWith('2026-10-09');
    expect(screen.queryByRole('group', { name: /Calendar/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Pick a day' })).toHaveTextContent('Fri 9 Oct');
    expect(screen.getByRole('button', { name: 'Back to today' })).toBeInTheDocument();
  });

  it('month arrows go back as far as the data does and not past the current month', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Calendar' }));
    expect(screen.getByRole('button', { name: 'Next month' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Previous month' }));
    expect(screen.getByRole('group', { name: 'Calendar, Sep 2026' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous month' })).toBeDisabled(); // data starts 30 Sep
    await waitFor(() => expect(newsDays).toHaveBeenCalledWith('2026-09', 'shortlist', true, expect.anything()));
    await user.click(screen.getByRole('button', { name: 'Next month' }));
    expect(screen.getByRole('group', { name: 'Calendar, Oct 2026' })).toBeInTheDocument();
  });

  it("opens on the month of an archive day, not today's", async () => {
    const user = userEvent.setup();
    render(<Harness start="2026-09-30" />);
    await user.click(screen.getByRole('button', { name: 'Calendar' }));
    expect(screen.getByRole('group', { name: 'Calendar, Sep 2026' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Wed 30 Sep 2026/ })).toHaveClass('sel');
  });
});

describe('search', () => {
  it('opens a focused field, reports what is typed, and Clear empties it', async () => {
    const user = userEvent.setup();
    const onQuery = vi.fn();
    render(<Harness onQuery={onQuery} />);
    expect(screen.queryByRole('searchbox')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Search headlines' }));
    const box = screen.getByRole('searchbox', { name: 'Search headlines' });
    expect(box).toHaveFocus();
    await user.type(box, 'buyback');
    expect(onQuery).toHaveBeenLastCalledWith('buyback');
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onQuery).toHaveBeenLastCalledWith('');
    expect(box).toHaveValue('');
  });

  it('closing the search clears the query so the day view returns', async () => {
    const user = userEvent.setup();
    const onQuery = vi.fn();
    render(<Harness onQuery={onQuery} />);
    await user.click(screen.getByRole('button', { name: 'Search headlines' }));
    await user.type(screen.getByRole('searchbox'), 'x');
    await user.click(screen.getByRole('button', { name: 'Search headlines' }));
    expect(onQuery).toHaveBeenLastCalledWith('');
    expect(screen.queryByRole('searchbox')).toBeNull();
  });
});

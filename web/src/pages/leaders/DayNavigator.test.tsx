import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DayNavigator } from './DayNavigator';
import { leadersView } from './testFixtures';

const api = { leadersDays: vi.fn() };
vi.mock('../../api/endpoints', () => ({
  api: { leadersDays: (...a: unknown[]) => api.leadersDays(...a) },
}));

beforeEach(() => {
  api.leadersDays.mockReset();
  api.leadersDays.mockResolvedValue({
    month: '2026-10',
    days: [
      { day: '2026-10-08', setups: 4, watch: 15 },
      { day: '2026-10-09', setups: 6, watch: 14 },
      { day: '2026-10-12', setups: 0, watch: 20 },
      { day: '2026-10-13', setups: 7, watch: 13 },
    ],
    today: '2026-10-13',
    earliest: '2026-10-08',
  });
});

describe('DayNavigator', () => {
  it('shows Today with when each market ran, and steps with the stored previous and next day', async () => {
    const user = userEvent.setup();
    const onDate = vi.fn();
    render(<DayNavigator view={leadersView()} onDate={onDate} />);
    expect(screen.getByRole('button', { name: 'Pick a day' })).toHaveTextContent('Today');
    expect(screen.getByRole('button', { name: 'Pick a day' })).toHaveTextContent(
      'Tue 13 Oct 2026 · HK run 18:45 · US run 06:45 HKT',
    );
    expect(screen.getByRole('button', { name: 'Next day' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Previous day' }));
    expect(onDate).toHaveBeenCalledWith('2026-10-12');
    expect(screen.queryByText(/Archived run for/)).toBeNull();
  });

  it('shows the archive banner with Back to today, and the next day wraps around to today as null', async () => {
    const user = userEvent.setup();
    const onDate = vi.fn();
    const view = leadersView({ asOf: '2026-10-12', isArchive: true, prevDay: '2026-10-09', nextDay: '2026-10-13' });
    render(<DayNavigator view={view} onDate={onDate} />);
    expect(screen.getByRole('button', { name: 'Pick a day' })).toHaveTextContent('Mon 12 Oct');
    expect(screen.getByRole('status')).toHaveTextContent('Archived run for Mon 12 Oct');
    await user.click(screen.getByRole('button', { name: 'Next day' }));
    expect(onDate).toHaveBeenLastCalledWith(null);
    await user.click(screen.getByRole('button', { name: 'Previous day' }));
    expect(onDate).toHaveBeenLastCalledWith('2026-10-09');
    await user.click(screen.getByRole('button', { name: 'Back to today' }));
    expect(onDate).toHaveBeenLastCalledWith(null);
  });

  it('disables both arrows when there is only one stored day', () => {
    render(<DayNavigator view={leadersView({ prevDay: null, nextDay: null })} onDate={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Previous day' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next day' })).toBeDisabled();
  });

  it('draws nothing before the first run', () => {
    const { container } = render(
      <DayNavigator view={leadersView({ asOf: null, today: null, prevDay: null, nextDay: null })} onDate={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('opens a month calendar of the stored runs, marks setups and watch days, and picks a day', async () => {
    const user = userEvent.setup();
    const onDate = vi.fn();
    render(<DayNavigator view={leadersView()} onDate={onDate} />);
    await user.click(screen.getByRole('button', { name: 'Pick a day' }));
    const cal = within(await screen.findByRole('group', { name: 'Calendar, Oct 2026' }));
    expect(api.leadersDays).toHaveBeenCalledWith('2026-10', expect.anything());
    expect(await cal.findByRole('button', { name: 'Fri 9 Oct 2026, 6 setups, 14 watch' })).toBeEnabled();
    expect(cal.getByRole('button', { name: 'Mon 12 Oct 2026, 0 setups, 20 watch' })).toBeEnabled();
    expect(cal.getByRole('button', { name: 'Tue 13 Oct 2026, 7 setups, 13 watch' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // a day without a run, and a day that has not happened, cannot be picked
    expect(cal.getByRole('button', { name: 'Sat 10 Oct 2026, no run' })).toBeDisabled();
    expect(cal.getByRole('button', { name: 'Fri 16 Oct 2026, no run' })).toBeDisabled();
    expect(cal.getByRole('button', { name: 'Next month' })).toBeDisabled();

    await user.click(cal.getByRole('button', { name: 'Fri 9 Oct 2026, 6 setups, 14 watch' }));
    expect(onDate).toHaveBeenCalledWith('2026-10-09');
    expect(screen.queryByRole('group', { name: /Calendar/ })).toBeNull();
  });

  it('picking today from the calendar means null: the latest run', async () => {
    const user = userEvent.setup();
    const onDate = vi.fn();
    render(<DayNavigator view={leadersView({ asOf: '2026-10-12', isArchive: true })} onDate={onDate} />);
    await user.click(screen.getByRole('button', { name: 'Pick a day' }));
    await user.click(await screen.findByRole('button', { name: 'Tue 13 Oct 2026, 7 setups, 13 watch' }));
    expect(onDate).toHaveBeenCalledWith(null);
  });
});

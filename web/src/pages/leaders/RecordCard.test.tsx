import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { extremeText, RecordCard } from './RecordCard';
import { record } from './testFixtures';

const api = { leadersRecord: vi.fn() };
vi.mock('../../api/endpoints', () => ({
  api: { leadersRecord: (...a: unknown[]) => api.leadersRecord(...a) },
}));

beforeEach(() => {
  api.leadersRecord.mockReset();
  api.leadersRecord.mockImplementation(async () => record());
});

describe('extremeText', () => {
  it('writes the R with a real minus sign, the name, the note and the day', () => {
    expect(extremeText({ r: 7.4, symbol: 'CLS', day: '2026-09-02', note: null })).toBe('+7.4R · CLS · 2 Sep');
    expect(extremeText({ r: -1.3, symbol: 'COIN', day: '2026-09-18', note: 'gap through the stop' })).toBe(
      '−1.3R · COIN · gap through the stop · 18 Sep',
    );
    expect(extremeText(null)).toBe('-');
  });
});

describe('RecordCard', () => {
  it('shows the tiles with the shares of Setups that reached 3R, were stopped and are still open', async () => {
    render(<RecordCard />);
    const card = within(screen.getByRole('region', { name: 'How past signals did' }));
    expect(await card.findByText('Setups shown')).toBeInTheDocument();
    expect(card.getByText('84')).toBeInTheDocument();
    expect(card.getByText('Reached 3R first').nextElementSibling).toHaveTextContent('45% 38');
    expect(card.getByText('Stopped first').nextElementSibling).toHaveTextContent('46% 39');
    expect(card.getByText('Still open').nextElementSibling).toHaveTextContent('7');
    expect(card.getByText('Avg R (20 d)').nextElementSibling).toHaveTextContent('+0.62');
    expect(card.getByText('Median days to 3R').nextElementSibling).toHaveTextContent('9');
    expect(card.getByText('+7.4R · CLS · 2 Sep')).toBeInTheDocument();
    expect(card.getByText('−1.3R · COIN · gap through the stop · 18 Sep')).toBeInTheDocument();
  });

  it('says what the numbers are and are not, with the Watch names that later became Setups', async () => {
    render(<RecordCard />);
    const note = await screen.findByText(/Counted from the close of the day a Setup was shown/);
    expect(note).toHaveTextContent('Watch names that later printed a Setup: 31 of 96.');
    expect(note).toHaveTextContent('not a backtest');
    expect(note).toHaveTextContent('Counting since 21 Jul 2026.');
  });

  it('switches between the last 60 days and all time', async () => {
    const user = userEvent.setup();
    api.leadersRecord.mockImplementation(async (w: '60' | 'all') =>
      w === 'all' ? record({ window: 'all', setups: 212, hit3r: 93, stopped: 104, open: 15 }) : record(),
    );
    render(<RecordCard />);
    expect(await screen.findByText('84')).toBeInTheDocument();
    expect(api.leadersRecord).toHaveBeenLastCalledWith('60', expect.anything());
    await user.click(screen.getByRole('button', { name: 'All time' }));
    expect(await screen.findByText('212')).toBeInTheDocument();
    expect(api.leadersRecord).toHaveBeenLastCalledWith('all', expect.anything());
    expect(screen.getByText('Reached 3R first').nextElementSibling).toHaveTextContent('44% 93');
    await user.click(screen.getByRole('button', { name: 'Last 60 days' }));
    expect(await screen.findByText('84')).toBeInTheDocument();
    expect(api.leadersRecord).toHaveBeenLastCalledWith('60', expect.anything());
  });

  it('says there is nothing to count yet instead of dividing by zero', async () => {
    api.leadersRecord.mockResolvedValue(
      record({
        setups: 0,
        hit3r: 0,
        stopped: 0,
        open: 0,
        avgR: null,
        medianDaysTo3r: null,
        best: null,
        worst: null,
        since: null,
      }),
    );
    render(<RecordCard />);
    expect(await screen.findByText(/No Setup has been counted in this window yet/)).toBeInTheDocument();
    expect(screen.queryByText('Reached 3R first')).toBeNull();
    expect(screen.queryByText('NaN%')).toBeNull();
  });

  it('shows a negative average R in red with a minus sign, and a dash when there is none', async () => {
    api.leadersRecord.mockResolvedValue(record({ avgR: -0.35, medianDaysTo3r: null }));
    render(<RecordCard />);
    const avg = (await screen.findByText('Avg R (20 d)')).nextElementSibling as HTMLElement;
    expect(avg).toHaveTextContent('−0.35');
    expect(avg).toHaveClass('dn');
    expect(screen.getByText('Median days to 3R').nextElementSibling).toHaveTextContent('-');
  });

  it('shows an error with a retry when the record cannot be loaded', async () => {
    const user = userEvent.setup();
    api.leadersRecord.mockRejectedValueOnce(new Error('Cannot reach the server.'));
    render(<RecordCard />);
    expect(await screen.findByText('Cannot reach the server.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('84')).toBeInTheDocument();
  });
});

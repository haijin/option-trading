import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LeaderStage, LeadersView } from '../../api/types';
import { DataVersionProvider } from '../../state/dataVersion';
import { RouterProvider } from '../../state/router';
import { ToastProvider } from '../../state/toast';
import { LeadersPage } from './LeadersPage';
import { candidate, catalog, hkCandidate, leadersView, plan, record, TODAY, watchCandidate } from './testFixtures';

const api = {
  leaders: vi.fn(),
  leadersDays: vi.fn(),
  leadersRecord: vi.fn(),
  refreshLeaders: vi.fn(),
  muteLeader: vi.fn(),
  unmuteLeader: vi.fn(),
  watchLeader: vi.fn(),
  skills: vi.fn(),
  startResearch: vi.fn(),
};
vi.mock('../../api/endpoints', () => ({
  api: {
    leaders: (...a: unknown[]) => api.leaders(...a),
    leadersDays: (...a: unknown[]) => api.leadersDays(...a),
    leadersRecord: (...a: unknown[]) => api.leadersRecord(...a),
    refreshLeaders: (...a: unknown[]) => api.refreshLeaders(...a),
    muteLeader: (...a: unknown[]) => api.muteLeader(...a),
    unmuteLeader: (...a: unknown[]) => api.unmuteLeader(...a),
    watchLeader: (...a: unknown[]) => api.watchLeader(...a),
    skills: (...a: unknown[]) => api.skills(...a),
    startResearch: (...a: unknown[]) => api.startResearch(...a),
  },
}));

function renderPage() {
  return render(
    <ToastProvider>
      <DataVersionProvider>
        <RouterProvider>
          <LeadersPage />
        </RouterProvider>
      </DataVersionProvider>
    </ToastProvider>,
  );
}

type User = ReturnType<typeof userEvent.setup>;

// The shortlist stage is a table: each name is one row whose symbol cell holds the button (aria-label "VRT Vertiv Holdings")
// that opens its inline detail, a region named "VRT Vertiv Holdings details". The other funnel stages still render cards.
const cards = () => screen.getAllByRole('article').map((a) => a.getAttribute('aria-label'));
const card = (name: string) => screen.getByRole('article', { name });
const rowButtons = () =>
  within(screen.getByRole('table', { name: 'Shortlist' }))
    .getAllByRole('button')
    .filter((b) => b.hasAttribute('aria-expanded'));
const rows = () => rowButtons().map((b) => b.getAttribute('aria-label'));
const rowButton = (name: string) => screen.getByRole('button', { name });
const row = (name: string) => within(rowButton(name).closest('tr') as HTMLElement);
const shown = (name: string) => screen.findByRole('button', { name });
const detailRegion = (name: string) => screen.getByRole('region', { name: `${name} details` });
/** Opens the name's detail and returns queries scoped to it. */
async function expand(user: User, name: string) {
  await user.click(rowButton(name));
  return within(detailRegion(name));
}

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
  window.location.hash = '';
  api.leaders.mockImplementation(async () => leadersView());
  api.leadersRecord.mockImplementation(async (w: '60' | 'all') =>
    record({ window: w, setups: w === 'all' ? 212 : 84 }),
  );
  api.leadersDays.mockResolvedValue({ month: '2026-10', days: [], today: TODAY, earliest: '2026-10-08' });
  api.skills.mockResolvedValue(catalog());
});

describe('LeadersPage', () => {
  it('shows the run, the regime with its posture, the funnel and one row per name', async () => {
    renderPage();
    expect(await screen.findByText('Tue 13 Oct · after US close · 06:45 HKT')).toBeInTheDocument();
    expect(screen.getByText('Bull · calm · VIX 17.2 · SPY and HSI above 200d')).toBeInTheDocument();
    expect(screen.getByText('· Entries allowed')).toBeInTheDocument();
    expect(rows()).toEqual(['VRT Vertiv Holdings', '0700 Tencent', 'PLTR Palantir']);
    const funnel = screen.getByRole('region', { name: 'Funnel' });
    expect(within(funnel).getByRole('button', { name: /1,312 screened/ })).toBeInTheDocument();
    expect(within(funnel).getByRole('button', { name: '3 shortlist' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(funnel).getByText('shortlisted').parentElement).toHaveTextContent('3 shortlisted');
    expect(within(funnel).getByText('new today').parentElement).toHaveTextContent('1 new today');
  });

  it('renders the watch-only posture in the amber variant', async () => {
    api.leaders.mockResolvedValue(
      leadersView({
        regime: {
          label: 'Panic',
          line: 'Panic · VIX 38.4',
          posture: 'watch_only',
          postureText: 'Watch only: pullback entries off',
        },
      }),
    );
    renderPage();
    const line = (await screen.findByText('Panic · VIX 38.4')).closest('.ld-regime');
    expect(line).toHaveClass('off');
    expect(line).toHaveTextContent('Watch only: pullback entries off');
  });

  it('filters by market and by state, and sorts by stop width, all over the names already returned', async () => {
    const user = userEvent.setup();
    renderPage();
    await shown('VRT Vertiv Holdings');

    await user.click(within(screen.getByRole('group', { name: 'Market' })).getByRole('button', { name: 'HK' }));
    expect(rows()).toEqual(['0700 Tencent']);
    await user.click(within(screen.getByRole('group', { name: 'Market' })).getByRole('button', { name: 'US' }));
    expect(rows()).toEqual(['VRT Vertiv Holdings', 'PLTR Palantir']);
    await user.click(within(screen.getByRole('group', { name: 'State' })).getByRole('button', { name: 'Watch' }));
    expect(rows()).toEqual(['PLTR Palantir']);
    await user.click(within(screen.getByRole('group', { name: 'State' })).getByRole('button', { name: 'Setup' }));
    expect(rows()).toEqual(['VRT Vertiv Holdings']);
    await user.click(within(screen.getByRole('group', { name: 'Market' })).getByRole('button', { name: 'All' }));
    await user.click(within(screen.getByRole('group', { name: 'State' })).getByRole('button', { name: 'All' }));

    await user.selectOptions(screen.getByRole('combobox', { name: 'Sort' }), 'stop');
    expect(rows()).toEqual(['0700 Tencent', 'VRT Vertiv Holdings', 'PLTR Palantir']);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Sort' }), 'r3');
    expect(rows()).toEqual(['VRT Vertiv Holdings', '0700 Tencent', 'PLTR Palantir']);
    // the server was asked once for the day: the filters never went back to it
    expect(api.leaders).toHaveBeenCalledTimes(1);
  });

  it('says so when the filters leave nothing', async () => {
    const user = userEvent.setup();
    renderPage();
    await shown('VRT Vertiv Holdings');
    await user.click(within(screen.getByRole('group', { name: 'Market' })).getByRole('button', { name: 'HK' }));
    await user.click(within(screen.getByRole('group', { name: 'State' })).getByRole('button', { name: 'Watch' }));
    expect(screen.getByText('Nothing matches these filters.')).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Shortlist' })).toBeNull();
  });

  it('expands a row to its plan and support map and collapses it again', async () => {
    const user = userEvent.setup();
    renderPage();
    const header = await shown('VRT Vertiv Holdings');
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('region', { name: 'VRT Vertiv Holdings details' })).toBeNull();
    expect(screen.queryByText('Entry (close)')).toBeNull();

    await user.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'true');
    const vrt = within(detailRegion('VRT Vertiv Holdings'));
    expect(vrt.getByText('Entry (close)')).toBeVisible();
    expect(vrt.getByText('US$164.36')).toBeVisible();
    expect(vrt.getByText('318')).toBeVisible();
    expect(vrt.getByText('Base low · in play')).toBeVisible();
    expect(vrt.getByRole('link', { name: /Chart VRT on TradingView/ })).toHaveAttribute(
      'href',
      'https://www.tradingview.com/chart/?symbol=VRT',
    );
    // only the tapped name opens
    expect(screen.getAllByRole('region', { name: / details$/ })).toHaveLength(1);

    await user.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('region', { name: 'VRT Vertiv Holdings details' })).toBeNull();
    expect(screen.queryByText('Entry (close)')).toBeNull();
  });

  it('opens from anywhere on the row with a mouse, and from the symbol button with the keyboard, once per press', async () => {
    const user = userEvent.setup();
    renderPage();
    const header = await shown('PLTR Palantir');

    await user.click(row('PLTR Palantir').getByText('-0.8%'));
    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(detailRegion('PLTR Palantir')).toBeInTheDocument();
    await user.click(row('PLTR Palantir').getByText('-0.8%'));
    expect(header).toHaveAttribute('aria-expanded', 'false');

    header.focus();
    await user.keyboard('{Enter}');
    expect(header).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard(' ');
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('region', { name: 'PLTR Palantir details' })).toBeNull();
  });

  it('shows the KPIs in the row, then the percentiles, the three reasons with their icons, and the flags, as text', async () => {
    const user = userEvent.setup();
    renderPage();
    await shown('VRT Vertiv Holdings');
    const line = row('VRT Vertiv Holdings');
    expect(line.getByText('+71.0%')).toBeInTheDocument();
    expect(line.getByText('US$1.4b')).toBeInTheDocument();

    const vrt = await expand(user, 'VRT Vertiv Holdings');
    expect(vrt.getByText('+71.0%')).toBeInTheDocument();
    expect(vrt.getByText('p94')).toBeInTheDocument();
    expect(vrt.getByText('62%')).toBeInTheDocument();
    expect(vrt.getByText('US$1.4b')).toBeInTheDocument();
    expect(vrt.getByText('Top 6% on 3m (+71%)')).toBeInTheDocument();
    expect(vrt.getByText('Earnings in 16 d')).toBeInTheDocument();
    expect(vrt.getByText('On watchlist')).toBeInTheDocument();
    // the support map is a list too: count the reasons in their own list
    expect(
      within(vrt.getByText('Top 6% on 3m (+71%)').closest('ul') as HTMLElement).getAllByRole('listitem'),
    ).toHaveLength(3);
  });

  it('renders model text as plain text, never as markup', async () => {
    const user = userEvent.setup();
    api.leaders.mockResolvedValue(
      leadersView({
        candidates: [candidate({ brief: '<img src=x onerror=alert(1)> <b>bold</b>' })],
        brief: { lead: '<a href="https://evil.example">click</a>', model: 'claude-haiku-5-5' },
      }),
    );
    const { container } = renderPage();
    await shown('VRT Vertiv Holdings');
    const vrt = await expand(user, 'VRT Vertiv Holdings');
    expect(vrt.getByText(/<img src=x onerror=alert\(1\)> <b>bold<\/b>/)).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText(/<a href="https:\/\/evil.example">click<\/a>/)).toBeInTheDocument();
    expect(document.querySelector('a[href="https://evil.example"]')).toBeNull();
  });

  it('shows no plan on a Watch: it says why, and the too-wide stop when there is one', async () => {
    const user = userEvent.setup();
    api.leaders.mockResolvedValue(
      leadersView({ candidates: [watchCandidate({ stopPct: 3.6, earningsInDays: 5, symbol: 'BYD', name: 'BYD' })] }),
    );
    renderPage();
    await shown('BYD BYD');
    const byd = await expand(user, 'BYD BYD');
    expect(byd.getByText(/Watch names have no plan/)).toBeVisible();
    expect(byd.getByText(/needed a 3.6% stop, above the 3% cap/)).toBeVisible();
    expect(byd.getByText(/Earnings inside the 7-day blackout/)).toBeVisible();
    expect(byd.queryByText('Entry (close)')).toBeNull();
    expect(byd.queryByText('Stop-buy alt.')).toBeNull();
  });

  it('keeps the chart and numbers but leaves the sizing blank when equity is not set', async () => {
    const user = userEvent.setup();
    api.leaders.mockResolvedValue(
      leadersView({
        candidates: [
          candidate({
            plan: plan({ shares: null, riskBudget: null, riskAtStop: null, positionValue: null, pctOfEquity: null }),
          }),
        ],
        status: { ...leadersView().status, equityMissing: true },
      }),
    );
    renderPage();
    await shown('VRT Vertiv Holdings');
    expect(screen.getByText('Equity is not set.')).toBeInTheDocument();
    const vrt = await expand(user, 'VRT Vertiv Holdings');
    expect(vrt.getByText(/Set equity in Settings to size this/)).toBeVisible();
    expect(vrt.getByRole('link', { name: 'Open Settings ›' })).toHaveAttribute('href', '#/settings');
    expect(vrt.getByText('Shares').nextElementSibling).toHaveTextContent('-');
    expect(vrt.getByText('Risk at stop').nextElementSibling).toHaveTextContent('-');
    expect(vrt.getByText('Position').nextElementSibling).toHaveTextContent('-');
    // the levels do not need equity
    expect(vrt.getByText('US$180.52')).toBeVisible();
  });

  it('shows the board lot on a Hong Kong plan and says when it is only assumed', async () => {
    const user = userEvent.setup();
    api.leaders.mockResolvedValue(leadersView({ candidates: [hkCandidate()] }));
    renderPage();
    await shown('0700 Tencent');
    const hk = await expand(user, '0700 Tencent');
    expect(hk.getByText('Shares (lot 100)')).toBeVisible();
    expect(hk.getByText('HK$412.00')).toBeVisible();
    expect(hk.getByText(/board lot of 100 shares is a default/)).toBeVisible();
  });

  it('shows the put angle and the research link only when there is something to say', async () => {
    const user = userEvent.setup();
    api.leaders.mockResolvedValue(
      leadersView({
        candidates: [
          candidate({
            put: { expiry: '2026-11-21', strike: 160, delta: 0.21, rocPct: 1.6, belowStopPct: 1.1 },
            researchReports: 3,
          }),
          watchCandidate({ researchReports: 0 }),
        ],
      }),
    );
    renderPage();
    await shown('VRT Vertiv Holdings');
    const vrt = await expand(user, 'VRT Vertiv Holdings');
    const pltr = await expand(user, 'PLTR Palantir');
    expect(vrt.getByText('Put angle: 21 Nov 160P · delta .21 · 1.6% ROC · strike 1.1% under the stop')).toBeVisible();
    expect(vrt.getByRole('link', { name: 'Research: 3 reports ›' })).toHaveAttribute('href', '#/research/US/VRT');
    expect(pltr.queryByText(/Put angle/)).toBeNull();
    expect(pltr.queryByRole('link', { name: /Research:/ })).toBeNull();
  });

  it('asks the server for the stage that was tapped and lists the names that stopped there', async () => {
    const user = userEvent.setup();
    api.leaders.mockImplementation(async (q: { stage?: LeaderStage }): Promise<LeadersView> => {
      if (q.stage === 'leaders') {
        return leadersView({
          stage: 'leaders',
          candidates: [
            candidate({
              id: 101,
              rank: null,
              symbol: 'COIN',
              name: 'Coinbase',
              state: 'extended',
              why: [],
              plan: null,
              levels: [],
              reason: 'Extended: 12% above the 21-EMA',
            }),
          ],
        });
      }
      if (q.stage === 'screened') {
        return leadersView({
          stage: 'screened',
          candidates: [],
          stageNote: 'Names that were not leaders are not stored.',
        });
      }
      return leadersView();
    });
    renderPage();
    await shown('VRT Vertiv Holdings');
    expect(api.leaders).toHaveBeenLastCalledWith({ date: undefined, stage: 'shortlist' }, expect.anything());

    const funnel = screen.getByRole('region', { name: 'Funnel' });
    await user.click(within(funnel).getByRole('button', { name: '61 leaders' }));
    await screen.findByRole('article', { name: 'COIN Coinbase' });
    expect(api.leaders).toHaveBeenLastCalledWith({ date: undefined, stage: 'leaders' }, expect.anything());
    expect(within(funnel).getByRole('button', { name: '61 leaders' })).toHaveAttribute('aria-pressed', 'true');
    expect(cards()).toEqual(['COIN Coinbase']);
    expect(screen.queryByRole('table', { name: 'Shortlist' })).toBeNull();
    expect(within(card('COIN Coinbase')).getByText('Extended: 12% above the 21-EMA')).toBeInTheDocument();
    expect(within(card('COIN Coinbase')).getByText('EXTENDED')).toBeInTheDocument();
    // a name that stopped early has no score or plan: its card says where it stopped and offers More, not Plan & levels
    expect(within(card('COIN Coinbase')).queryByText('Score')).toBeNull();
    expect(within(card('COIN Coinbase')).getByRole('button', { name: 'More' })).toBeInTheDocument();
    expect(within(card('COIN Coinbase')).queryByText(/Trade plan/)).toBeNull();
    // the Setup / Watch filter only means something on the shortlist
    expect(screen.queryByRole('group', { name: 'State' })).toBeNull();

    await user.click(within(funnel).getByRole('button', { name: /1,312 screened/ }));
    expect(await screen.findByText('Names that were not leaders are not stored.')).toBeInTheDocument();
    expect(screen.queryAllByRole('article')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Back to the shortlist' }));
    await shown('VRT Vertiv Holdings');
    expect(screen.queryAllByRole('article')).toHaveLength(0);
    expect(api.leaders).toHaveBeenLastCalledWith({ date: undefined, stage: 'shortlist' }, expect.anything());
  });

  it('mutes a name for ten trading days, takes the row off, and Undo asks the server to unmute', async () => {
    const user = userEvent.setup();
    api.muteLeader.mockResolvedValue({ days: 10, until: '2026-10-27', reason: 'Muted from the Leaders page' });
    api.unmuteLeader.mockResolvedValue({ ok: true });
    renderPage();
    await shown('VRT Vertiv Holdings');
    const vrt = await expand(user, 'VRT Vertiv Holdings');

    await user.click(vrt.getByRole('button', { name: 'Dismiss' }));
    expect(api.muteLeader).toHaveBeenCalledWith(1, { days: 10 });
    expect(await screen.findByText('VRT muted for 10 trading days')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'VRT Vertiv Holdings' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'VRT Vertiv Holdings details' })).toBeNull();
    expect(rows()).toEqual(['0700 Tencent', 'PLTR Palantir']);

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(api.unmuteLeader).toHaveBeenCalledWith(1);
    expect(await shown('VRT Vertiv Holdings')).toBeInTheDocument();
  });

  it('keeps the row when the mute fails', async () => {
    const user = userEvent.setup();
    api.muteLeader.mockRejectedValue(new Error('Server said no'));
    renderPage();
    await shown('VRT Vertiv Holdings');
    const vrt = await expand(user, 'VRT Vertiv Holdings');
    await user.click(vrt.getByRole('button', { name: 'Dismiss' }));
    expect(await screen.findByText('Server said no')).toBeInTheDocument();
    expect(rowButton('VRT Vertiv Holdings')).toBeInTheDocument();
  });

  it('adds a name to the watchlist and shows On watchlist once the list is fetched again', async () => {
    const user = userEvent.setup();
    let watched = false;
    api.leaders.mockImplementation(async () => leadersView({ candidates: [watchCandidate({ id: 2, watched })] }));
    api.watchLeader.mockImplementation(async () => {
      watched = true;
      return { ok: true, market: 'US', symbol: 'PLTR' };
    });
    renderPage();
    await shown('PLTR Palantir');
    const pltr = await expand(user, 'PLTR Palantir');
    expect(pltr.queryByText('On watchlist')).toBeNull();

    await user.click(pltr.getByRole('button', { name: 'Add to watchlist' }));
    expect(api.watchLeader).toHaveBeenCalledWith(2);
    expect(await screen.findByText('PLTR added to the watchlist')).toBeInTheDocument();
    await waitFor(() => expect(within(detailRegion('PLTR Palantir')).getByText('On watchlist')).toBeInTheDocument());
    expect(within(detailRegion('PLTR Palantir')).queryByRole('button', { name: 'Add to watchlist' })).toBeNull();
  });

  it('opens the Investigate sheet for the name it was pressed on', async () => {
    const user = userEvent.setup();
    renderPage();
    await shown('PLTR Palantir');
    const pltr = await expand(user, 'PLTR Palantir');
    await user.click(pltr.getByRole('button', { name: 'Investigate' }));
    expect(await screen.findByRole('dialog', { name: 'Investigate PLTR · Palantir' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('steps back a day, shows the archive banner and the outcome, and goes back to today', async () => {
    const user = userEvent.setup();
    api.leaders.mockImplementation(async (q: { date?: string }) =>
      q.date === '2026-10-12'
        ? leadersView({
            asOf: '2026-10-12',
            isArchive: true,
            prevDay: '2026-10-09',
            nextDay: TODAY,
            candidates: [
              candidate({
                outcome: {
                  fwd5Pct: 3.2,
                  fwd10Pct: 6.1,
                  fwd20Pct: null,
                  hit3r: true,
                  stopped: false,
                  maxR: 3.4,
                  daysTo3r: 7,
                  asOf: TODAY,
                },
              }),
            ],
          })
        : leadersView(),
    );
    renderPage();
    await shown('VRT Vertiv Holdings');
    expect(screen.getByRole('button', { name: 'Next day' })).toBeDisabled();
    expect(screen.queryByText(/Archived run for/)).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Previous day' }));
    expect(await screen.findByText(/Archived run for/)).toHaveTextContent('Archived run for Mon 12 Oct');
    expect(api.leaders).toHaveBeenLastCalledWith({ date: '2026-10-12', stage: 'shortlist' }, expect.anything());
    expect(screen.getByText('Archive · Mon 12 Oct')).toBeInTheDocument();
    // the outcome sits in the detail of the name it was measured for
    const vrt = await expand(user, 'VRT Vertiv Holdings');
    expect(vrt.getByText('Reached 3R in 7 d · max 3.4R')).toBeInTheDocument();
    expect(vrt.getByText('After 5 d +3.2% · 10 d +6.1%')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next day' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Back to today' }));
    await waitFor(() => expect(screen.queryByText(/Archived run for/)).toBeNull());
    expect(api.leaders).toHaveBeenLastCalledWith({ date: undefined, stage: 'shortlist' }, expect.anything());
  });

  it('disables the day arrows at the ends of the stored runs', async () => {
    api.leaders.mockResolvedValue(leadersView({ prevDay: null }));
    renderPage();
    await shown('VRT Vertiv Holdings');
    expect(screen.getByRole('button', { name: 'Previous day' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next day' })).toBeDisabled();
  });

  it('loads the record for 60 days and for all time', async () => {
    const user = userEvent.setup();
    renderPage();
    const rec = within(await screen.findByRole('region', { name: 'How past signals did' }));
    expect(await rec.findByText('84')).toBeInTheDocument();
    expect(api.leadersRecord).toHaveBeenLastCalledWith('60', expect.anything());
    expect(rec.getByRole('button', { name: 'Last 60 days' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(rec.getByRole('button', { name: 'All time' }));
    expect(await rec.findByText('212')).toBeInTheDocument();
    expect(api.leadersRecord).toHaveBeenLastCalledWith('all', expect.anything());
    expect(rec.getByRole('button', { name: 'All time' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('lists what dropped off', async () => {
    renderPage();
    const dropped = within(await screen.findByRole('region', { name: 'Dropped names' }));
    expect(dropped.getByText('Dropped since yesterday')).toBeInTheDocument();
    expect(dropped.getByText('Extended: 12% above the 21-EMA')).toBeInTheDocument();
    expect(dropped.getByText('9618')).toBeInTheDocument();
  });

  it('says there is no scan yet, with how to run one', async () => {
    api.leaders.mockResolvedValue(
      leadersView({ asOf: null, today: null, runs: { US: null, HK: null }, regime: null, candidates: [], dropped: [] }),
    );
    renderPage();
    expect(await screen.findByText('No scan yet.')).toBeInTheDocument();
    expect(screen.getByText('pnpm cli leaders scan')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Funnel' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Refresh leaders' })).toBeEnabled();
  });

  it('warns when the newest run is old and when a scan failed', async () => {
    const view = leadersView();
    api.leaders.mockResolvedValue(
      leadersView({
        status: { ...view.status, stale: true, lastRunAt: '2026-10-09T22:45:00.000Z' },
        runs: { ...view.runs, HK: view.runs.HK && { ...view.runs.HK, status: 'failed' } },
      }),
    );
    renderPage();
    expect(await screen.findByText('This list is out of date.')).toBeInTheDocument();
    expect(screen.getByText(/finished Sat 10 Oct 06:45 HKT/)).toBeInTheDocument();
    expect(screen.getByText('The HK scan failed.')).toBeInTheDocument();
    expect(screen.getByText(/466 of 470 names had a bar/)).toBeInTheDocument();
  });

  it('shows the error with a retry when the list cannot be loaded', async () => {
    const user = userEvent.setup();
    api.leaders.mockRejectedValueOnce(new Error('Cannot reach the server.'));
    renderPage();
    expect(await screen.findByText('Cannot reach the server.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await shown('VRT Vertiv Holdings')).toBeInTheDocument();
  });

  it('asks for a refresh and tells the user what the server said', async () => {
    const user = userEvent.setup();
    api.refreshLeaders.mockResolvedValue({ queued: true, message: 'Scan queued for both markets.' });
    renderPage();
    await shown('VRT Vertiv Holdings');
    await user.click(screen.getByRole('button', { name: 'Refresh leaders' }));
    expect(api.refreshLeaders).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Scan queued for both markets.')).toBeInTheDocument();
  });

  it('asks again while a refresh is running, and the Refresh button waits for it', async () => {
    const running = leadersView({ status: { ...leadersView().status, refreshing: true } });
    api.leaders.mockResolvedValueOnce(running).mockResolvedValue(leadersView());
    renderPage();
    await shown('VRT Vertiv Holdings');
    expect(screen.getByRole('button', { name: 'Refreshing leaders' })).toBeDisabled();
    expect(api.leaders).toHaveBeenCalledTimes(1);
    // the page polls every 3 s while the server says it is scanning
    await waitFor(() => expect(api.leaders).toHaveBeenCalledTimes(2), { timeout: 5000 });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh leaders' })).toBeEnabled());
  }, 12_000);
});

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WatchBoardRow, WatchBoardView, WatchEntryView } from '../../api/types';
import { DataVersionProvider } from '../../state/dataVersion';
import { RouterProvider } from '../../state/router';
import { ToastProvider } from '../../state/toast';
import { boardView, entryFor, pausedEntry, sampleRows } from './testFixtures';
import { WatchlistPage } from './WatchlistPage';

const api = {
  watchlistBoard: vi.fn(),
  watchlist: vi.fn(),
  watchlistPatch: vi.fn(),
  watchlistPreview: vi.fn(),
  watchlistAdd: vi.fn(),
  watchlistPaste: vi.fn(),
  startIngest: vi.fn(),
  settings: vi.fn(),
};
vi.mock('../../api/endpoints', () => ({
  api: {
    watchlistBoard: (...a: unknown[]) => api.watchlistBoard(...a),
    watchlist: (...a: unknown[]) => api.watchlist(...a),
    watchlistPatch: (...a: unknown[]) => api.watchlistPatch(...a),
    watchlistPreview: (...a: unknown[]) => api.watchlistPreview(...a),
    watchlistAdd: (...a: unknown[]) => api.watchlistAdd(...a),
    watchlistPaste: (...a: unknown[]) => api.watchlistPaste(...a),
    startIngest: (...a: unknown[]) => api.startIngest(...a),
    settings: (...a: unknown[]) => api.settings(...a),
  },
  links: { watchlistCsv: '/api/watchlist/export.csv' },
}));

/** A tiny server: the board and the list answer from the same flags, and a PATCH flips them. */
let active: Record<string, boolean>;
let rows: WatchBoardRow[];
let extra: WatchEntryView[];
let boardOver: Partial<WatchBoardView>;
const keyOf = (r: { market: string; symbol: string }) => `${r.market}:${r.symbol}`;

function entries(): WatchEntryView[] {
  return [
    ...rows.map((r) => entryFor(r, { active: active[keyOf(r)] ?? true })),
    ...extra.map((e) => ({ ...e, active: active[keyOf(e)] ?? e.active })),
  ];
}

function renderPage(hash = '#/watchlist') {
  window.location.hash = hash;
  return render(
    <ToastProvider>
      <DataVersionProvider>
        <RouterProvider>
          <WatchlistPage />
        </RouterProvider>
      </DataVersionProvider>
    </ToastProvider>,
  );
}

const table = () => screen.getByRole('table', { name: 'Watched stocks' });
const bodyRows = () => within(table()).getAllByRole('row').slice(1);
const shownSymbols = () => bodyRows().map((r) => within(r).getAllByRole('button')[0]?.querySelector('b')?.textContent);
const rowOf = (symbol: string) => {
  const found = bodyRows().find((r) => r.textContent?.startsWith(symbol));
  if (!found) throw new Error(`no row for ${symbol}`);
  return found;
};

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
  rows = sampleRows();
  extra = [];
  active = {};
  boardOver = {};
  api.watchlistBoard.mockImplementation(async () =>
    boardView(
      rows.filter((r) => active[keyOf(r)] ?? true),
      boardOver,
    ),
  );
  api.watchlist.mockImplementation(async () => entries());
  api.watchlistPatch.mockImplementation(async (market: string, symbol: string, patch: { active?: boolean }) => {
    if (patch.active !== undefined) active[`${market}:${symbol}`] = patch.active;
    return entries().find((e) => e.market === market && e.symbol === symbol);
  });
  api.settings.mockResolvedValue({ perNameCapPct: 5 });
});

describe('WatchlistPage', () => {
  it('lists every watched stock in a table, best recommendation first', async () => {
    renderPage();
    await screen.findByRole('table', { name: 'Watched stocks' });
    expect(shownSymbols()).toEqual(['0700', 'NVDA', 'JPM', 'XOM', 'KO', 'AAPL']);
    expect(screen.getByText('Scored as of 2026-10-09')).toBeInTheDocument();
  });

  it('a row carries the price, the KPIs, the highlight and the recommendation with its put', async () => {
    renderPage();
    await screen.findByRole('table', { name: 'Watched stocks' });
    const nvda = within(rowOf('NVDA'));
    expect(nvda.getByText('120.50')).toBeInTheDocument();
    expect(nvda.getByText('+1.25%')).toHaveClass('pos');
    expect(nvda.getByText('Up')).toBeInTheDocument();
    expect(nvda.getByText('4.2% above support')).toBeInTheDocument();
    expect(nvda.getByText('42')).toBeInTheDocument();
    expect(nvda.getByText('31.2%')).toBeInTheDocument();
    expect(nvda.getByText('4.5%')).toBeInTheDocument();
    expect(nvda.getByText('28.1x')).toBeInTheDocument();
    expect(nvda.getByText('20% below IV')).toBeInTheDocument();
    expect(nvda.getByText('IV 150.00')).toBeInTheDocument();
    expect(nvda.getByText('Top US idea')).toBeInTheDocument();
    expect(nvda.getByText('Sell put')).toBeInTheDocument();
    expect(nvda.getByText('24.9% a year, 6.2% cushion')).toBeInTheDocument();
    expect(nvda.getByText('110P 13 Nov')).toBeInTheDocument();
    expect(nvda.getByText(/35d · delta 0\.20 · premium 2\.40/)).toBeInTheDocument();
    expect(nvda.getByRole('img', { name: /NVDA last 6 closes/ })).toBeInTheDocument();
  });

  it('shows a missing number as a dash and a stock with no prices as "no price yet"', async () => {
    renderPage();
    await screen.findByRole('table', { name: 'Watched stocks' });
    const aapl = within(rowOf('AAPL'));
    expect(aapl.getByText('no price yet')).toBeInTheDocument();
    expect(aapl.getByText('Needs data')).toBeInTheDocument();
    expect(aapl.getByText('Nothing stands out')).toBeInTheDocument();
    expect(aapl.getByText('unknown')).toBeInTheDocument();
    expect(aapl.getAllByText('-').length).toBeGreaterThanOrEqual(5);
    // a bank has no free-cash-flow yield and a loss-maker no P/E: a dash, never zero
    expect(within(rowOf('JPM')).queryByText('0.0%')).not.toBeInTheDocument();
    expect(within(rowOf('XOM')).queryByText(/0\.0x/)).not.toBeInTheDocument();
  });

  it('flags results within two weeks in red, with the date and the days', async () => {
    renderPage();
    await screen.findByRole('table', { name: 'Watched stocks' });
    const jpm = within(rowOf('JPM'));
    expect(jpm.getByText('13 Oct')).toHaveClass('neg');
    expect(jpm.getByText('in 4 days')).toHaveClass('neg');
    expect(within(rowOf('0700')).getByText(/in 40 days \(est\.\)/)).toBeInTheDocument();
  });

  it('summarises the whole list in four tiles with the names behind them', async () => {
    renderPage();
    await screen.findByRole('table', { name: 'Watched stocks' });
    const tiles = within(screen.getByRole('region', { name: 'Watchlist summary' }));
    expect(tiles.getByText('Watching').parentElement).toHaveTextContent('6US 5 · HK 1 · 1 need data');
    expect(tiles.getByText('Sell a put').parentElement).toHaveTextContent('2Best: NVDA 24.9% a year');
    expect(tiles.getByText('Results within 14 days').parentElement).toHaveTextContent('1JPM 4d');
    expect(tiles.getByText('Below intrinsic value').parentElement).toHaveTextContent('3');
    expect(tiles.getByText('Below intrinsic value').parentElement).toHaveTextContent('0700 -35%');
  });

  it('filters by recommendation, market and search, and the chip counts follow the market and search', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: 'Watched stocks' });
    const show = within(screen.getByRole('group', { name: 'Show' }));

    await user.click(show.getByRole('button', { name: /Sell put/ }));
    expect(shownSymbols()).toEqual(['0700', 'NVDA']);
    expect(show.getByRole('button', { name: /Sell put/ })).toHaveAttribute('aria-pressed', 'true');

    await user.click(within(screen.getByRole('group', { name: 'Market' })).getByRole('button', { name: 'US' }));
    expect(shownSymbols()).toEqual(['NVDA']);
    expect(show.getByRole('button', { name: /^All/ })).toHaveTextContent('5');

    await user.click(show.getByRole('button', { name: /^All/ }));
    await user.click(within(screen.getByRole('group', { name: 'Market' })).getByRole('button', { name: 'All' }));
    await user.type(screen.getByRole('searchbox', { name: 'Find a stock' }), 'exx');
    expect(shownSymbols()).toEqual(['XOM']);
  });

  it('says so when nothing matches, and one click shows everything again', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: 'Watched stocks' });
    await user.type(screen.getByRole('searchbox', { name: 'Find a stock' }), 'zzzz');
    expect(screen.queryByRole('table', { name: 'Watched stocks' })).not.toBeInTheDocument();
    expect(screen.getByText(/No stock matches/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show all 6' }));
    expect(shownSymbols()).toHaveLength(6);
    expect(screen.getByRole('searchbox', { name: 'Find a stock' })).toHaveValue('');
  });

  it('sorts by a column header, flips on a second click, and marks the column for assistive tech', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: 'Watched stocks' });
    await user.click(screen.getByRole('button', { name: 'Sort by ROE' }));
    expect(shownSymbols().slice(0, 3)).toEqual(['KO', 'NVDA', '0700']);
    expect(screen.getByRole('columnheader', { name: /ROE/ })).toHaveAttribute('aria-sort', 'descending');
    await user.click(screen.getByRole('button', { name: 'Sort by ROE' }));
    expect(shownSymbols()[0]).toBe('XOM');
    expect(screen.getByRole('columnheader', { name: /ROE/ })).toHaveAttribute('aria-sort', 'ascending');
    // missing values stay last
    expect(shownSymbols().at(-1)).toBe('AAPL');
  });

  it('the sort menu (the phone has no header row) sorts too', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: 'Watched stocks' });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Sort' }), 'earnings');
    expect(shownSymbols()[0]).toBe('JPM');
  });

  it('stopping a stock removes its row at once and lists it under "Not watching"', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: 'Watched stocks' });
    await user.click(within(rowOf('JPM')).getByRole('switch', { name: 'Watching JPM' }));
    expect(api.watchlistPatch).toHaveBeenCalledWith('US', 'JPM', { active: false });
    await waitFor(() => expect(shownSymbols()).not.toContain('JPM'));
    const paused = await screen.findByRole('heading', { name: /Not watching/ });
    expect(paused.closest('section')).toHaveTextContent('JPM');
    expect(screen.getByRole('region', { name: 'Watchlist summary' })).toHaveTextContent('5');
  });

  it('puts the row back if stopping fails', async () => {
    const user = userEvent.setup();
    api.watchlistPatch.mockRejectedValue(new Error('server down'));
    renderPage();
    await screen.findByRole('table', { name: 'Watched stocks' });
    await user.click(within(rowOf('JPM')).getByRole('switch', { name: 'Watching JPM' }));
    await waitFor(() => expect(api.watchlistPatch).toHaveBeenCalled());
    await waitFor(() => expect(shownSymbols()).toContain('JPM'));
  });

  it('a stopped stock can be resumed; until the board has scored it, it waits under "Being scored"', async () => {
    const user = userEvent.setup();
    extra = [pausedEntry('IBM')];
    renderPage();
    await screen.findByRole('table', { name: 'Watched stocks' });
    const paused = (await screen.findByRole('heading', { name: /Not watching/ })).closest('section') as HTMLElement;
    expect(paused).toHaveTextContent('IBM');
    await user.click(within(paused).getByRole('switch', { name: 'Watching IBM' }));
    expect(api.watchlistPatch).toHaveBeenCalledWith('US', 'IBM', { active: true });
    // the board has no row for it (it was never scored): it is neither lost nor listed as stopped
    const scoring = (await screen.findByRole('heading', { name: /Being scored/ })).closest('section') as HTMLElement;
    expect(scoring).toHaveTextContent('IBM');
    expect(screen.queryByRole('heading', { name: /Not watching/ })).not.toBeInTheDocument();
  });

  it('a click on a stock opens its settings in a dialog; Escape closes it', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: 'Watched stocks' });
    await user.click(within(rowOf('NVDA')).getByRole('button', { name: /NVDA/ }));
    const dialog = await screen.findByRole('dialog', { name: 'NVDA · NVIDIA' });
    expect(window.location.hash).toBe('#/watchlist/US/NVDA');
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(window.location.hash).toBe('#/watchlist');
  });

  it('a click on the row itself, away from a control, opens the dialog too', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: 'Watched stocks' });
    await user.click(within(rowOf('KO')).getByText('Open put', { selector: '.chip' }));
    expect(await screen.findByRole('dialog', { name: 'KO · Coca-Cola' })).toBeInTheDocument();
  });

  it('a link to a stock opens its dialog straight away', async () => {
    renderPage('#/watchlist/HK/0700');
    expect(await screen.findByRole('dialog', { name: '0700 · Tencent' })).toBeInTheDocument();
  });

  it('"+ Add stocks" opens the add panel and "Close" hides it', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: 'Watched stocks' });
    expect(screen.queryByRole('heading', { name: 'Add stocks' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '+ Add stocks' }));
    expect(screen.getByRole('heading', { name: 'Add stocks' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Paste a list' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('heading', { name: 'Add stocks' })).not.toBeInTheDocument();
  });

  it('with nothing watched it opens the add panel by itself and shows no table', async () => {
    rows = [];
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Add stocks' })).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Watched stocks' })).not.toBeInTheDocument();
  });

  it('says the scan has not run when nothing is scored', async () => {
    boardOver = { scored: false };
    renderPage();
    await screen.findByRole('table', { name: 'Watched stocks' });
    expect(screen.getByText(/The scan has not run/)).toBeInTheDocument();
  });

  it('shows an error with a retry when the board cannot be built', async () => {
    const user = userEvent.setup();
    api.watchlistBoard.mockRejectedValueOnce(new Error('boom'));
    renderPage();
    expect(await screen.findByText('Could not score the watchlist.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('table', { name: 'Watched stocks' });
  });

  it('keeps the export link and the explanation of "watching"', async () => {
    renderPage();
    await screen.findByRole('table', { name: 'Watched stocks' });
    expect(screen.getByRole('link', { name: 'Export CSV' })).toHaveAttribute('href', '/api/watchlist/export.csv');
    expect(screen.getByText(/What does .watching. mean/)).toBeInTheDocument();
  });
});

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JournalCardView, JournalListView } from '../../api/types';
import { RouterProvider } from '../../state/router';
import { ToastProvider } from '../../state/toast';
import { localDay } from './dates';
import JournalPage from './JournalPage';

const TODAY = localDay();

const card = (date: string): JournalCardView => ({
  date,
  title: `Entry for ${date}`,
  template: 'evening',
  marketView: 'bullish',
  tags: [],
  status: 'closed',
  wordCount: 120,
  excerpt: 'Some words',
  mentions: [],
  thumbnailAssetId: null,
  aiPolished: false,
  updatedAt: new Date().toISOString(),
});

const list = (entries: JournalCardView[]): JournalListView => ({
  entries,
  total: entries.length,
  page: 1,
  pageSize: 20,
  summary: { month: TODAY.slice(0, 7), entries: entries.length, lessons: 2, names: 3, streak: 1 },
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function stubApi(entries: JournalCardView[]) {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(url);
      const path = url.split('?')[0] ?? '';
      if (path === '/api/journal/entries') return json(list(entries));
      if (path === '/api/journal/calendar')
        return json({ month: TODAY.slice(0, 7), days: [], entries: 0, bullish: 0, bearish: 0 });
      if (path === '/api/journal/lessons') return json({ lessons: [] });
      // any single day: not on the server yet
      return json({ error: { code: 'entry_not_found', message: 'none' } }, 404);
    }),
  );
  return urls;
}

/** The phone layout (max-width 899 px) or the desktop one. */
function viewport(mobile: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('max-width: 899px') ? mobile : false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

function mount() {
  return render(
    <ToastProvider>
      <RouterProvider>
        <JournalPage />
      </RouterProvider>
    </ToastProvider>,
  );
}

beforeEach(() => {
  window.location.hash = '#/journal';
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  window.location.hash = '';
});

describe('the journal page on a phone', () => {
  it('shows the list with its header, search, week strip, summary and segments', async () => {
    viewport(true);
    stubApi([card('2026-10-13')]);
    mount();
    expect(screen.getByRole('heading', { name: 'Journal' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ New entry' })).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search entries' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'This week' })).toBeInTheDocument();
    expect(await screen.findByText('Entry for 2026-10-13')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Entries' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /Month/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Lessons/ })).toBeInTheDocument();
    // the editor is not on screen until an entry is opened
    expect(screen.queryByLabelText('Title')).toBeNull();
    expect(document.body).toHaveClass('jr-page');
  });

  it('opens today with + New entry, as a history entry, and the back arrow returns to the list', async () => {
    viewport(true);
    stubApi([]);
    mount();
    expect(await screen.findByText(/No entries yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '+ New entry' }));
    await waitFor(() => expect(window.location.hash).toBe(`#/journal/${TODAY}`));
    expect(await screen.findByLabelText('Title')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ New entry' })).toBeNull();
    expect(document.body).toHaveClass('jr-editing');
    // a link straight to a day has no list in history behind it: the arrow goes to the list
    fireEvent.click(screen.getByRole('button', { name: 'Journal' }));
    await waitFor(() => expect(window.location.hash).toBe('#/journal'));
    expect(await screen.findByRole('button', { name: '+ New entry' })).toBeInTheDocument();
  });

  it('opens a day that is in the URL, and falls back to the list for an impossible date', async () => {
    viewport(true);
    stubApi([]);
    window.location.hash = '#/journal/2026-10-13';
    const { unmount } = mount();
    // (the date is also in the header that shows while the day loads, so wait for the editor itself)
    await screen.findByLabelText('Title');
    expect(screen.getByText('Tue 13 Oct 2026')).toBeInTheDocument();
    unmount();
    window.location.hash = '#/journal/2026-02-30';
    mount();
    expect(await screen.findByRole('button', { name: '+ New entry' })).toBeInTheDocument();
  });

  it('removes its body classes when it goes away', () => {
    viewport(true);
    stubApi([]);
    const { unmount } = mount();
    expect(document.body).toHaveClass('jr-page');
    unmount();
    expect(document.body).not.toHaveClass('jr-page');
    expect(document.body).not.toHaveClass('jr-editing');
  });
});

describe('the journal page on desktop', () => {
  it('shows the list beside an empty editor pane, and opens an entry next to the list', async () => {
    viewport(false);
    stubApi([card('2026-10-13')]);
    mount();
    expect(screen.getByText(/Pick an entry on the left/)).toBeInTheDocument();
    fireEvent.click(await screen.findByText('Entry for 2026-10-13'));
    await waitFor(() => expect(window.location.hash).toBe('#/journal/2026-10-13'));
    expect(await screen.findByLabelText('Title')).toBeInTheDocument();
    // the list is still there
    expect(screen.getByText('Entry for 2026-10-13')).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search entries' })).toBeInTheDocument();
  });
});

describe('searching', () => {
  it('sends words, a symbol and a tag to the server as separate parameters, after a pause', async () => {
    viewport(true);
    const urls = stubApi([]);
    mount();
    await screen.findByText(/No entries yet/);
    const box = screen.getByRole('searchbox', { name: 'Search entries' });
    fireEvent.change(box, { target: { value: 'premium $NKE #breach' } });
    await waitFor(() => expect(urls.some((u) => u.includes('symbol=NKE'))).toBe(true), { timeout: 2000 });
    const searched = urls.find((u) => u.includes('symbol=NKE')) as string;
    expect(searched).toContain('q=premium');
    expect(searched).toContain('tag=breach');
    expect(searched).toContain('page=1');
    expect(searched).toMatch(/today=\d{4}-\d{2}-\d{2}/);
    expect(await screen.findByText(/No entry matches/)).toBeInTheDocument();
  });
});

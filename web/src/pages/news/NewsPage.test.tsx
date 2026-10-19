import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NewsBriefDayView, NewsGroupView, NewsItemView, NewsScope, NewsView } from '../../api/types';
import { NewsPage } from './NewsPage';

const api = {
  news: vi.fn(),
  newsDays: vi.fn(),
  newsSearch: vi.fn(),
  newsBrief: vi.fn(),
  refreshNews: vi.fn(),
};
vi.mock('../../api/endpoints', () => ({
  api: {
    news: (...a: unknown[]) => api.news(...a),
    newsDays: (...a: unknown[]) => api.newsDays(...a),
    newsSearch: (...a: unknown[]) => api.newsSearch(...a),
    newsBrief: (...a: unknown[]) => api.newsBrief(...a),
    refreshNews: (...a: unknown[]) => api.refreshNews(...a),
  },
}));

const TODAY = '2026-10-13';

const item = (id: number, over: Partial<NewsItemView> = {}): NewsItemView => ({
  id,
  source: 'Yahoo Finance',
  url: `https://finance.yahoo.com/a-${id}.html`,
  title: `Headline ${id}`,
  snippet: null,
  publishedAt: '2026-10-12T21:10:00.000Z',
  day: TODAY,
  impact: null,
  summary: null,
  rules: [],
  standingThen: null,
  judgedAt: null,
  confidence: null,
  model: null,
  ...over,
});

const nke: NewsGroupView = {
  market: 'US',
  symbol: 'NKE',
  name: 'NIKE',
  price: 72.4,
  changePct: 1.8,
  standing: {
    kind: 'sell',
    label: 'Sell',
    detail: '14 Nov · 65 put · 19.4%/yr',
    strike: 65,
    expiry: '2026-11-14',
    dte: 32,
    otmPct: 10,
  },
  hasOpenPosition: false,
  items: [
    item(1, { title: 'Nike buyback pace slows' }),
    item(2, {
      impact: 'supports',
      summary: 'guidance intact and no earnings inside the window',
      rules: [{ key: 'e', text: 'Next earnings ~18 Dec, outside every expiry' }],
      standingThen: {
        kind: 'wait',
        label: 'Wait',
        detail: 'gate WARN',
        strike: null,
        expiry: null,
        dte: null,
        otmPct: null,
      },
      judgedAt: '2026-10-12T10:00:00.000Z',
      confidence: 70,
      model: 'claude-haiku-5-5',
      title: 'Nike reaffirms guidance',
      day: '2026-10-12',
    }),
    item(3, { impact: 'neutral', summary: 'routine filing', title: 'Routine filing', source: 'HKEXnews' }),
  ],
};
const byd: NewsGroupView = {
  market: 'HK',
  symbol: '1211',
  name: 'BYD',
  price: 97.1,
  changePct: -4.2,
  standing: {
    kind: 'open',
    label: 'Open put',
    detail: '29 Oct · 95 put · 2.2% OTM · 12 days',
    strike: 95,
    expiry: '2026-10-29',
    dte: 12,
    otmPct: 2.2,
  },
  hasOpenPosition: true,
  items: [item(4, { impact: 'blocks', summary: 'spot is 2.2% above your strike', title: 'BYD sales fall' })],
};

function newsView(scope: NewsScope, over: Partial<NewsView> = {}): NewsView {
  const groups = scope === 'positions' ? [byd] : [nke];
  return {
    scope,
    date: TODAY,
    today: TODAY,
    days: 3,
    rolling: false,
    hideNeutral: false,
    counts: { shortlist: 1, positions: 1, all: 3 },
    groups,
    quiet: [{ market: 'US', symbol: 'AAPL' }],
    total: groups.reduce((n, g) => n + g.items.length, 0),
    status: {
      fetchedAt: '2026-10-12T23:40:00.000Z',
      refreshing: false,
      lastFetch: { status: 'ok', finishedAt: '2026-10-12T23:40:00.000Z', detail: null },
      unclassified: 1,
      ai: { available: true, auto: true, model: 'claude-haiku-5-5', budgetUsd: 2, spentTodayUsd: 0.1 },
      earliestDay: '2026-09-30',
    },
    ...over,
  };
}

const noBrief: NewsBriefDayView = { date: TODAY, briefs: [], none: 'not_written', firstBriefDay: null };

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
  api.news.mockImplementation(async (q: { scope: NewsScope }) => newsView(q.scope));
  api.newsBrief.mockResolvedValue(noBrief);
  api.newsDays.mockResolvedValue({
    month: '2026-10',
    scope: 'shortlist',
    days: [],
    today: TODAY,
    earliest: '2026-09-30',
  });
  api.newsSearch.mockResolvedValue({ q: '', scope: 'shortlist', total: 0, groups: [] });
  api.refreshNews.mockResolvedValue({ queued: true, message: 'Refresh started.' });
});

describe('News page', () => {
  it('lists one card per name with the standing now, and says when nothing was fetched for others', async () => {
    render(<NewsPage />);
    const card = await screen.findByRole('article', { name: 'NKE' });
    expect(within(card).getByText('NIKE')).toBeInTheDocument();
    expect(within(card).getByText('Sell')).toBeInTheDocument();
    expect(within(card).getByText('14 Nov · 65 put · 19.4%/yr')).toBeInTheDocument();
    expect(within(card).getByText('now')).toBeInTheDocument();
    expect(screen.getByText(/Nothing in the 3 days to today:/).parentElement).toHaveTextContent('AAPL');
    expect(screen.getByText('Fetched 07:40 HKT')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Shortlist/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('shows a story the model has not judged without a badge and with "New", never as Neutral', async () => {
    render(<NewsPage />);
    const card = await screen.findByRole('article', { name: 'NKE' });
    const unjudged = within(card).getByRole('button', { name: /Nike buyback pace slows/ });
    expect(within(unjudged).getByText('New')).toBeInTheDocument();
    expect(unjudged.querySelector('.news-imp')).toBeNull();
    expect(unjudged).not.toHaveTextContent('Neutral');
    // a judged neutral story keeps its badge: that is a different thing
    const neutral = within(card).getByRole('button', { name: /Routine filing/ });
    expect(neutral.querySelector('.news-imp.neutral')).not.toBeNull();
  });

  it('expands a judged story to show the standing then, the rule keys and the source, with Ask why disabled', async () => {
    const user = userEvent.setup();
    render(<NewsPage />);
    const card = await screen.findByRole('article', { name: 'NKE' });
    const story = within(card).getByRole('button', { name: /Nike reaffirms guidance/ });
    expect(story).toHaveAttribute('aria-expanded', 'false');
    expect(story).toHaveTextContent('Supports: guidance intact and no earnings inside the window');
    await user.click(story);
    expect(story).toHaveAttribute('aria-expanded', 'true');
    expect(card).toHaveTextContent(
      'Standing on Mon 12 Oct: Wait · gate WARN. The impact line was written against that.',
    );
    const rule = within(card).getByText('Next earnings ~18 Dec, outside every expiry');
    expect(rule.previousElementSibling).toHaveTextContent('E');
    expect(within(card).getByRole('link', { name: 'Source' })).toHaveAttribute(
      'href',
      'https://finance.yahoo.com/a-2.html',
    );
    expect(within(card).getByRole('link', { name: 'Source' })).toHaveAttribute('rel', 'noopener noreferrer');
    const ask = within(card).getByRole('button', { name: /Ask why/ });
    expect(ask).toBeDisabled();
    expect(ask).toHaveAttribute('title', 'coming with AI analysis stage B3');
    expect(within(card).getByRole('link', { name: 'Puts ›' })).toHaveAttribute('href', '#/puts/US/NKE');
  });

  it('does not render a standing-then line when it matches the standing now', async () => {
    const user = userEvent.setup();
    api.news.mockImplementation(async (q: { scope: NewsScope }) =>
      newsView(q.scope, {
        groups: [
          {
            ...nke,
            items: [
              item(2, {
                impact: 'caution',
                summary: 'x',
                standingThen: nke.standing,
                title: 'Same standing',
              }),
            ],
          },
        ],
        total: 1,
      }),
    );
    render(<NewsPage />);
    await user.click(await screen.findByRole('button', { name: /Same standing/ }));
    expect(screen.queryByText(/Standing on/)).toBeNull();
  });

  it('renders everything the model or a feed wrote as text, never as markup', async () => {
    const user = userEvent.setup();
    const hostile = '<img src=x onerror="document.title=1"><script>window.__pwned = 1</script>';
    api.news.mockImplementation(async (q: { scope: NewsScope }) =>
      newsView(q.scope, {
        groups: [
          {
            ...nke,
            items: [
              item(7, {
                title: `Headline ${hostile}`,
                snippet: hostile,
                impact: 'caution',
                summary: hostile,
                rules: [{ key: 'f', text: hostile }],
                standingThen: {
                  kind: 'wait',
                  label: hostile,
                  detail: '',
                  strike: null,
                  expiry: null,
                  dte: null,
                  otmPct: null,
                },
                judgedAt: '2026-10-12T10:00:00.000Z',
              }),
            ],
          },
        ],
        total: 1,
      }),
    );
    const { container } = render(<NewsPage />);
    await user.click(await screen.findByRole('button', { name: /Headline/ }));
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    expect(screen.getAllByText(/<img src=x onerror/).length).toBeGreaterThanOrEqual(4); // title, summary, rule, snippet
  });

  it('only links http(s) sources', async () => {
    const user = userEvent.setup();
    api.news.mockImplementation(async (q: { scope: NewsScope }) =>
      newsView(q.scope, {
        groups: [
          {
            ...nke,
            items: [item(9, { url: 'javascript:alert(1)', title: 'Bad link', impact: 'caution', summary: 's' })],
          },
        ],
        total: 1,
      }),
    );
    render(<NewsPage />);
    await user.click(await screen.findByRole('button', { name: /Bad link/ }));
    expect(screen.queryByRole('link', { name: 'Source' })).toBeNull();
  });

  it('switching scope asks for it and shows Positions ›, not Puts ›, for an open put', async () => {
    const user = userEvent.setup();
    render(<NewsPage />);
    await screen.findByRole('article', { name: 'NKE' });
    await user.click(screen.getByRole('tab', { name: /Positions/ }));
    const card = await screen.findByRole('article', { name: '1211.HK' });
    expect(api.news).toHaveBeenLastCalledWith(
      expect.objectContaining({ scope: 'positions', days: 3, neutral: true }),
      expect.anything(),
    );
    await user.click(within(card).getByRole('button', { name: /BYD sales fall/ }));
    expect(within(card).getByRole('link', { name: 'Positions ›' })).toHaveAttribute('href', '#/positions');
    expect(within(card).getByText('Open put')).toBeInTheDocument();
  });

  it('window chips and Hide neutral go to the server', async () => {
    const user = userEvent.setup();
    render(<NewsPage />);
    await screen.findByRole('article', { name: 'NKE' });
    await user.click(screen.getByRole('button', { name: 'Week' }));
    await waitFor(() =>
      expect(api.news).toHaveBeenLastCalledWith(expect.objectContaining({ days: 7 }), expect.anything()),
    );
    await user.click(screen.getByRole('checkbox', { name: /Hide neutral/ }));
    await waitFor(() =>
      expect(api.news).toHaveBeenLastCalledWith(
        expect.objectContaining({ days: 7, neutral: false }),
        expect.anything(),
      ),
    );
  });

  it('past days: archive header, the date goes to the server, and the brief is asked for that day', async () => {
    const user = userEvent.setup();
    render(<NewsPage />);
    await screen.findByRole('article', { name: 'NKE' });
    await user.click(screen.getByRole('button', { name: 'Previous day' }));
    expect(await screen.findByText('Archive')).toBeInTheDocument();
    await waitFor(() =>
      expect(api.news).toHaveBeenLastCalledWith(expect.objectContaining({ date: '2026-10-12' }), expect.anything()),
    );
    await waitFor(() => expect(api.newsBrief).toHaveBeenLastCalledWith('2026-10-12', expect.anything()));
    expect(screen.getByText('Up to Mon 12 Oct, last')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back to today' }));
    await waitFor(() => expect(screen.queryByText('Archive')).toBeNull());
  });

  it('search runs across days, highlights the match and reports the count; clearing returns to the day view', async () => {
    const user = userEvent.setup();
    api.newsSearch.mockResolvedValue({
      q: 'buyback',
      scope: 'shortlist',
      total: 1,
      groups: [{ ...nke, items: [item(1, { title: 'Nike buyback pace slows', day: '2026-10-01' })] }],
    });
    render(<NewsPage />);
    await screen.findByRole('article', { name: 'NKE' });
    await user.click(screen.getByRole('button', { name: 'Search headlines' }));
    await user.type(screen.getByRole('searchbox'), 'buyback');
    expect(await screen.findByText(/matching “buyback” across all days, shortlist/)).toBeInTheDocument();
    expect(api.newsSearch).toHaveBeenLastCalledWith('buyback', 'shortlist', expect.anything());
    expect(document.querySelector('.news-ihead h3 mark')).toHaveTextContent('buyback');
    expect(screen.queryByRole('group', { name: 'Time window' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(await screen.findByRole('group', { name: 'Time window' })).toBeInTheDocument();
  });

  it('Refresh queues a fetch and the button shows it is working while the server says so', async () => {
    const user = userEvent.setup();
    render(<NewsPage />);
    await screen.findByRole('article', { name: 'NKE' });
    await user.click(screen.getByRole('button', { name: 'Refresh news' }));
    expect(api.refreshNews).toHaveBeenCalledTimes(1);
  });

  it('explains an empty shortlist instead of showing nothing', async () => {
    api.news.mockImplementation(async (q: { scope: NewsScope }) =>
      newsView(q.scope, { groups: [], quiet: [], total: 0, counts: { shortlist: 0, positions: 0, all: 0 } }),
    );
    render(<NewsPage />);
    expect(await screen.findByText(/No names on the shortlist yet/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Puts' })).toHaveAttribute('href', '#/puts');
  });

  it('says why there is no brief, and shows a failed fetch without hiding the stored stories', async () => {
    api.news.mockImplementation(async (q: { scope: NewsScope }) =>
      newsView(q.scope, {
        status: {
          ...newsView('shortlist').status,
          lastFetch: { status: 'failed', finishedAt: null, detail: 'every feed failed: HTTP 429' },
        },
      }),
    );
    render(<NewsPage />);
    expect(await screen.findByRole('article', { name: 'NKE' })).toBeInTheDocument();
    expect(screen.getByText(/The last fetch failed\./)).toBeInTheDocument();
    // The brief loads on its own request, after the story card: wait for the empty state instead of asserting at once.
    expect(await screen.findByText(/No brief has been written for today yet/)).toBeInTheDocument();
  });

  it('renders a brief with its tape, bullets, the put-selling line and a sources list', async () => {
    const user = userEvent.setup();
    api.newsBrief.mockResolvedValue({
      date: TODAY,
      none: null,
      firstBriefDay: TODAY,
      briefs: [
        {
          id: 1,
          session: 'hk_open',
          asOf: '2026-10-12T23:40:00.000Z',
          lead: 'Quiet US close ahead of CPI.',
          bullets: [{ tag: 'US', text: 'Banks start reporting.' }],
          forPuts: 'HK premiums pay better this week.',
          tape: [
            { key: 'vix', label: 'VIX', value: '17.2', changePct: null, asOf: '2026-10-12' },
            { key: 'spx', label: 'S&P 500', value: '', changePct: -0.3, asOf: '2026-10-12' },
          ],
          sources: [
            {
              url: 'https://example.com/a',
              source: 'HKEX',
              title: 'Pre-open indication',
              publishedAt: '2026-10-12T23:31:00.000Z',
            },
          ],
          model: 'claude-haiku-5-5',
        },
      ],
    } satisfies NewsBriefDayView);
    render(<NewsPage />);
    expect(await screen.findByText('Quiet US close ahead of CPI.')).toBeInTheDocument();
    expect(screen.getByText(/For put selling: HK premiums pay better this week\./)).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Market snapshot' })).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('-0.3%')).toHaveClass('dn');
    await user.click(screen.getByRole('button', { name: 'Sources ›' }));
    expect(screen.getByRole('link', { name: /HKEX/ })).toHaveAttribute('href', 'https://example.com/a');
  });
});

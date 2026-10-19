import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WatchPreviewView } from '../../api/types';
import { AddOnePanel, PREVIEW_DEBOUNCE_MS } from './AddOnePanel';

const preview = (over: Partial<WatchPreviewView>): WatchPreviewView => ({
  ok: true,
  error: null,
  raw: '0700',
  market: 'HK',
  symbol: '0700',
  yahooSymbol: '0700.HK',
  name: 'Tencent Holdings',
  boardLot: 100,
  lotSource: 'seed_file',
  duplicate: null,
  ...over,
});

interface Call {
  url: string;
  method: string;
  body: unknown;
}

let calls: Call[];
let previews: Record<string, WatchPreviewView>;

function installFetch() {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const method = init.method ?? 'GET';
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, body });
      const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
      if (url.startsWith('/api/watchlist/preview')) {
        const raw = new URL(url, 'http://x').searchParams.get('raw') ?? '';
        return json(
          previews[raw] ?? preview({ ok: false, error: `invalid symbol "${raw}"`, symbol: null, market: null }),
        );
      }
      if (url === '/api/watchlist' && method === 'POST') return json({ symbol: body.symbol, market: body.market });
      if (url.startsWith('/api/watchlist/') && method === 'PATCH') return json({ ok: true });
      if (url === '/api/ingest') return json({ id: 'job1' });
      return json({});
    }),
  );
}

const typeSymbol = (text: string) => fireEvent.change(screen.getByLabelText('Symbol'), { target: { value: text } });
const settle = (ms = PREVIEW_DEBOUNCE_MS) => act(async () => vi.advanceTimersByTimeAsync(ms));
const previewCalls = () => calls.filter((c) => c.url.startsWith('/api/watchlist/preview'));

beforeEach(() => {
  vi.useFakeTimers();
  previews = { '0700': preview({}) };
  installFetch();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Watchlist add: one symbol', () => {
  it('waits 250 ms after the last keystroke and then asks for one preview', async () => {
    render(<AddOnePanel onAdded={() => undefined} />);
    typeSymbol('0');
    await settle(100);
    typeSymbol('07');
    await settle(100);
    typeSymbol('0700');
    await settle(PREVIEW_DEBOUNCE_MS - 10);
    expect(previewCalls()).toHaveLength(0);
    await settle(20);
    expect(previewCalls()).toHaveLength(1);
    expect(previewCalls()[0]?.url).toBe('/api/watchlist/preview?raw=0700');
    expect(screen.getByTestId('preview-card')).toHaveTextContent('0700');
    expect(screen.getByTestId('preview-card')).toHaveTextContent('Tencent Holdings');
    expect(screen.getByTestId('preview-card')).toHaveTextContent('Yahoo symbol 0700.HK');
  });

  it('passes the chosen market', async () => {
    render(<AddOnePanel onAdded={() => undefined} />);
    fireEvent.change(screen.getByLabelText('Market'), { target: { value: 'HK' } });
    typeSymbol('0700');
    await settle();
    expect(previewCalls()[0]?.url).toBe('/api/watchlist/preview?raw=0700&market=HK');
  });

  it('shows the server error for an invalid symbol and keeps Add disabled', async () => {
    render(<AddOnePanel onAdded={() => undefined} />);
    typeSymbol('$$$');
    await settle();
    expect(screen.getByRole('alert')).toHaveTextContent('invalid symbol "$$$"');
    expect(screen.getByRole('button', { name: 'Add to watchlist' })).toBeDisabled();
  });

  it('explains a stock that is already watched and blocks adding it again', async () => {
    previews['0700'] = preview({ duplicate: 'watching', lotSource: 'existing' });
    render(<AddOnePanel onAdded={() => undefined} />);
    typeSymbol('0700');
    await settle();
    expect(screen.getByText('Already on your list and being watched.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resume watching' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Add to watchlist' })).toBeDisabled();
  });

  it('offers Resume for a paused duplicate and resumes through PATCH', async () => {
    previews['0700'] = preview({ duplicate: 'paused', lotSource: 'existing' });
    render(<AddOnePanel onAdded={() => undefined} />);
    typeSymbol('0700');
    await settle();
    expect(screen.getByText(/Already on your list but paused/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add to watchlist' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Resume watching' }));
    await settle(0);
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.url).toBe('/api/watchlist/HK/0700');
    expect(patch?.body).toEqual({ active: true });
  });

  it('requires a board lot when an HK name is not in the lot file', async () => {
    previews['9999'] = preview({
      symbol: '9999',
      raw: '9999',
      yahooSymbol: '9999.HK',
      name: null,
      boardLot: null,
      lotSource: 'missing',
    });
    render(<AddOnePanel onAdded={() => undefined} />);
    typeSymbol('9999');
    await settle();
    expect(screen.getByText(/Not in data\/hk-board-lots.csv/)).toBeInTheDocument();
    expect(screen.getByText('name filled at first ingest')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add to watchlist' }));
    await settle(0);
    expect(screen.getByRole('alert')).toHaveTextContent('Enter the board lot for 9999');
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/watchlist')).toBe(false);

    fireEvent.change(screen.getByLabelText('Board lot (multiplier)'), { target: { value: '500' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to watchlist' }));
    await settle(0);
    const post = calls.find((c) => c.method === 'POST' && c.url === '/api/watchlist');
    expect(post?.body).toEqual({ symbol: '9999', market: 'HK', boardLot: 500 });
  });

  it('adds a name from the lot file without sending a lot, then offers to fetch its data', async () => {
    const added = vi.fn();
    render(<AddOnePanel onAdded={added} />);
    typeSymbol('0700');
    await settle();
    expect(screen.getByLabelText('Board lot (multiplier)')).toHaveValue('100');
    fireEvent.change(screen.getByLabelText('Conviction (1-5)'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to watchlist' }));
    await settle(0);
    const post = calls.find((c) => c.method === 'POST' && c.url === '/api/watchlist');
    expect(post?.body).toEqual({ symbol: '0700', market: 'HK', conviction: 4 });
    expect(added).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Fetch data now' }));
    await settle(0);
    const ingest = calls.find((c) => c.url === '/api/ingest');
    expect(ingest?.method).toBe('POST');
    expect(ingest?.body).toEqual({ only: [{ market: 'HK', symbol: '0700' }] });
  });

  it('sends an edited lot even when the file supplied one', async () => {
    render(<AddOnePanel onAdded={() => undefined} />);
    typeSymbol('0700');
    await settle();
    fireEvent.change(screen.getByLabelText('Board lot (multiplier)'), { target: { value: '200' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to watchlist' }));
    await settle(0);
    const post = calls.find((c) => c.method === 'POST' && c.url === '/api/watchlist');
    expect(post?.body).toMatchObject({ boardLot: 200 });
  });
});

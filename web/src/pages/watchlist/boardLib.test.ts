import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SORT,
  filterCounts,
  filterRows,
  headlines,
  nextSort,
  sortFor,
  sortRows,
  summarizeRows,
} from './boardLib';
import { boardRow, sampleRows } from './testFixtures';

const symbols = (rows: { symbol: string }[]) => rows.map((r) => r.symbol);
const none = { filter: 'all', market: 'all', query: '' } as const;

describe('filterRows', () => {
  const rows = sampleRows();

  it('narrows by action, market and search together', () => {
    expect(symbols(filterRows(rows, { ...none, filter: 'sell_put' }))).toEqual(['NVDA', '0700']);
    expect(symbols(filterRows(rows, { ...none, filter: 'sell_put', market: 'HK' }))).toEqual(['0700']);
    expect(symbols(filterRows(rows, { ...none, query: 'coca' }))).toEqual(['KO']);
    expect(symbols(filterRows(rows, { ...none, query: ' nv ' }))).toEqual(['NVDA']);
    expect(symbols(filterRows(rows, { ...none, query: 'zzz' }))).toEqual([]);
  });

  it('the two highlight filters use the same thresholds as the tiles', () => {
    expect(symbols(filterRows(rows, { ...none, filter: 'results_soon' }))).toEqual(['JPM']);
    // priceRatio 0.8 is the edge and counts; 0.65 counts; 1.2 and 2.1 do not
    expect(symbols(filterRows(rows, { ...none, filter: 'below_iv' }))).toEqual(['NVDA', '0700', 'KO']);
  });

  it('counts every chip over the rows it is given', () => {
    const counts = filterCounts(rows);
    expect(counts).toMatchObject({
      all: 6,
      sell_put: 2,
      wait: 1,
      avoid: 1,
      hold: 1,
      needs_data: 1,
      results_soon: 1,
      below_iv: 3,
    });
  });
});

describe('sortRows', () => {
  const rows = sampleRows();

  it('the default order is the recommendation: sell ideas by rank, then wait, avoid, open put, needs data', () => {
    expect(symbols(sortRows(rows, DEFAULT_SORT))).toEqual(['0700', 'NVDA', 'JPM', 'XOM', 'KO', 'AAPL']);
  });

  it('sorts a numeric column both ways and always puts missing values last', () => {
    expect(symbols(sortRows(rows, { key: 'ivRank', dir: 'desc' }))).toEqual([
      '0700',
      'KO',
      'NVDA',
      'XOM',
      'JPM',
      'AAPL',
    ]);
    expect(symbols(sortRows(rows, { key: 'ivRank', dir: 'asc' }))).toEqual([
      'JPM',
      'XOM',
      'KO',
      'NVDA',
      '0700',
      'AAPL',
    ]);
  });

  it('a loss-making name (no P/E) sorts last on P/E, whichever way', () => {
    const asc = symbols(sortRows(rows, { key: 'pe', dir: 'asc' }));
    const desc = symbols(sortRows(rows, { key: 'pe', dir: 'desc' }));
    expect(asc.slice(-2)).toEqual(expect.arrayContaining(['XOM', 'AAPL']));
    expect(desc.slice(-2)).toEqual(expect.arrayContaining(['XOM', 'AAPL']));
    expect(asc[0]).toBe('0700');
  });

  it('price vs IV starts with the cheapest; results starts with the soonest', () => {
    expect(symbols(sortRows(rows, sortFor('value')))[0]).toBe('0700');
    expect(symbols(sortRows(rows, sortFor('earnings')))[0]).toBe('JPM');
  });

  it('sorts the stock column alphabetically and breaks ties by market then symbol', () => {
    expect(symbols(sortRows(rows, { key: 'stock', dir: 'asc' }))).toEqual(['0700', 'AAPL', 'JPM', 'KO', 'NVDA', 'XOM']);
    const tied = [boardRow({ symbol: 'B', ivRank: 50 }), boardRow({ symbol: 'A', ivRank: 50 })];
    expect(symbols(sortRows(tied, { key: 'ivRank', dir: 'desc' }))).toEqual(['A', 'B']);
  });

  it('does not change the rows it is given', () => {
    const copy = [...rows];
    sortRows(rows, { key: 'roe', dir: 'desc' });
    expect(rows).toEqual(copy);
  });
});

describe('nextSort', () => {
  it('a new column starts best first; the same column flips', () => {
    expect(nextSort(DEFAULT_SORT, 'roe')).toEqual({ key: 'roe', dir: 'desc' });
    expect(nextSort(DEFAULT_SORT, 'pe')).toEqual({ key: 'pe', dir: 'asc' });
    expect(nextSort({ key: 'roe', dir: 'desc' }, 'roe')).toEqual({ key: 'roe', dir: 'asc' });
    expect(nextSort({ key: 'roe', dir: 'asc' }, 'roe')).toEqual({ key: 'roe', dir: 'desc' });
  });
});

describe('summary and headlines', () => {
  const rows = sampleRows();

  it('counts what is on screen', () => {
    expect(summarizeRows(rows)).toEqual({
      watching: 6,
      us: 5,
      hk: 1,
      sellPut: 2,
      wait: 1,
      avoid: 1,
      hold: 1,
      needsData: 1,
      earningsSoon: 1,
      undervalued: 3,
    });
    expect(summarizeRows([]).watching).toBe(0);
  });

  it('names the best idea by composite, the nearest results and the cheapest names', () => {
    const h = headlines(rows);
    expect(h.best?.symbol).toBe('NVDA');
    expect(symbols(h.soon)).toEqual(['JPM']);
    expect(symbols(h.cheap)).toEqual(['0700', 'NVDA', 'KO']);
    expect(headlines([]).best).toBeNull();
  });
});

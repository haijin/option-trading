import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseBoardLotsCsv, parseIndexCsv } from '../../src/providers/seed-files';
import { fetchStooqBars, parseStooqCsv, stooqSymbol, stooqUrl } from '../../src/providers/stooq';

const fx = (name: string) => readFileSync(new URL(`../fixtures/stooq/${name}`, import.meta.url), 'utf8');

describe('T15: Stooq bar fallback', () => {
  it('parses a recorded CSV into bars (no adjusted close: adjClose = close)', () => {
    const bars = parseStooqCsv(fx('aapl.us.csv'), 'AAPL');
    expect(bars).toHaveLength(4);
    expect(bars[0]).toMatchObject({
      day: '2026-10-06',
      open: 330.1,
      close: 333.4,
      volume: 41022000,
      source: 'stooq',
      adjClose: 333.4,
    });
    expect(bars[3]?.day).toBe('2026-10-09');
  });

  it('symbol and URL mapping for both markets', () => {
    expect(stooqSymbol('US', 'AAPL')).toBe('aapl.us');
    expect(stooqSymbol('US', 'BRK.B')).toBe('brk-b.us');
    expect(stooqSymbol('HK', '0700')).toBe('0700.hk');
    expect(stooqUrl('US', 'AAPL', '2026-10-01', '2026-10-10')).toBe(
      'https://stooq.com/q/d/l/?s=aapl.us&d1=20261001&d2=20261010&i=d',
    );
  });

  it('recognises the JavaScript browser-verification page and refuses to treat it as data (no bypass attempted)', () => {
    expect(() => parseStooqCsv(fx('challenge.html'), 'AAPL')).toThrowError(/browser-verification/);
    try {
      parseStooqCsv(fx('challenge.html'), 'AAPL');
    } catch (e) {
      expect((e as { code: string }).code).toBe('challenge');
    }
  });

  it.each([
    ['no-data.txt', 'no_data'],
    ['limit.txt', 'rate_limit'],
  ])('%s fails with code %s', (file, code) => {
    try {
      parseStooqCsv(fx(file), 'AAPL');
      expect.unreachable();
    } catch (e) {
      expect((e as { code: string }).code).toBe(code);
    }
  });

  it('a malformed header or an all-garbage body is bad_format', () => {
    expect(() => parseStooqCsv('foo,bar\n1,2', 'AAPL')).toThrowError(/unexpected header/);
    expect(() => parseStooqCsv('Date,Open,High,Low,Close,Volume\nnot-a-date,x,y,z,w,1', 'AAPL')).toThrowError(
      /no usable rows/,
    );
  });

  it('fetchStooqBars goes through the injected fetch (HTTP 403 and challenge pages both fail cleanly)', async () => {
    const ok = await fetchStooqBars(
      async () => new Response(fx('aapl.us.csv'), { status: 200 }),
      'US',
      'AAPL',
      '2026-10-01',
      '2026-10-10',
    );
    expect(ok).toHaveLength(4);
    await expect(
      fetchStooqBars(async () => new Response('Forbidden', { status: 403 }), 'US', 'AAPL', '2026-10-01', '2026-10-10'),
    ).rejects.toMatchObject({ code: 'bad_format' });
    await expect(
      fetchStooqBars(
        async () => new Response(fx('challenge.html'), { status: 200 }),
        'US',
        'AAPL',
        '2026-10-01',
        '2026-10-10',
      ),
    ).rejects.toMatchObject({ code: 'challenge' });
  });
});

describe('seed CSV loaders', () => {
  it('board-lot CSV: canonical symbols, comments and header skipped, bad rows ignored', () => {
    const m = parseBoardLotsCsv(
      '# c\nsymbol,lot,name\n700,100,Tencent\n0005,400,HSBC\nabc,5,x\n0016,0,bad\n9988,100\n',
    );
    expect([...m.entries()]).toEqual([
      ['0700', 100],
      ['0005', 400],
      ['9988', 100],
    ]);
  });

  it('the shipped seed has the lots the e2e watchlist relies on', () => {
    const m = parseBoardLotsCsv(readFileSync(new URL('../../data/hk-board-lots.csv', import.meta.url), 'utf8'));
    expect(m.get('0700')).toBe(100);
    expect(m.get('0005')).toBe(400);
    expect(m.get('0941')).toBe(500);
    expect(m.get('0016')).toBe(500);
    expect(m.get('2318')).toBe(500);
  });

  it('vol-index CSV accepts date,close with ISO or DD/MM/YYYY dates', () => {
    const bars = parseIndexCsv('Date,Close\n2026-10-08,24.1\n09/10/2026,25.3\nbad,1\n');
    expect(bars.map((b) => [b.day, b.close])).toEqual([
      ['2026-10-08', 24.1],
      ['2026-10-09', 25.3],
    ]);
  });
});

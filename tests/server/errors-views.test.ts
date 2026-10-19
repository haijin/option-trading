import { describe, expect, it } from 'vitest';
import { UserError } from '../../src/core/util';
import { ApiError, badRequest, toErrorResponse } from '../../src/server/errors';
import { inferMarket, parseMarketSymbol } from '../../src/server/services/watch-service';
import { groupOf, reasonView, regimeView } from '../../src/server/views';

describe('error mapping', () => {
  it('keeps the status and code of API errors', () => {
    const r = toErrorResponse(new ApiError(409, 'ingest_running', 'busy'));
    expect(r).toEqual({ status: 409, body: { error: { code: 'ingest_running', message: 'busy' } } });
    expect(toErrorResponse(badRequest('x', 'y', { a: 1 })).body.error.details).toEqual({ a: 1 });
  });

  it('turns the CLI user errors into 400s with stable codes', () => {
    expect(toErrorResponse(new UserError('equity is not set: run something')).body.error.code).toBe('equity_not_set');
    expect(toErrorResponse(new UserError('the watchlist is empty: add names')).body.error.code).toBe('watchlist_empty');
    const other = toErrorResponse(new UserError('some other rule broke'));
    expect(other).toMatchObject({ status: 400, body: { error: { code: 'user_error' } } });
  });

  it('passes framework 4xx errors through and hides the details of bugs', () => {
    const f = Object.assign(new Error('payload too large'), { statusCode: 413, code: 'FST_ERR_CTP_BODY_TOO_LARGE' });
    expect(toErrorResponse(f)).toMatchObject({ status: 413, body: { error: { code: 'FST_ERR_CTP_BODY_TOO_LARGE' } } });
    const bug = toErrorResponse(new TypeError('cannot read properties of undefined (secret path C:\\x)'));
    expect(bug.status).toBe(500);
    expect(JSON.stringify(bug.body)).not.toMatch(/secret|C:/);
  });
});

describe('view helpers', () => {
  it('groups reasons for the UI', () => {
    expect(groupOf('fundamental.gate', 'events.earningsWindow')).toBe('Events');
    expect(groupOf('fundamental.gate', 'quality.fcfYield')).toBe('Quality gate');
    expect(groupOf('market.regime', 'regime.noVolIndex')).toBe('Market');
    expect(groupOf('size.position', 'size.perNameCap')).toBe('Sizing');
    expect(groupOf('option.select', 'data.stale')).toBe('Freshness');
    expect(groupOf('something.new', 'x')).toBe('Other');
  });

  it('derives a level when a reason has none', () => {
    expect(reasonView({ rule: 'a', value: 1, passed: true }, 'market.regime').level).toBe('PASS');
    expect(reasonView({ rule: 'a', value: 1, passed: false }, 'market.regime').level).toBe('WARN');
    expect(
      reasonView(
        { rule: 'a', value: 1, passed: false, level: 'FAIL', kind: 'rule', note: 'n', threshold: '>= 2' },
        'technical.timing',
      ),
    ).toMatchObject({
      level: 'FAIL',
      kind: 'rule',
      note: 'n',
      threshold: '>= 2',
      group: 'Timing',
    });
  });

  it('describes a regime in words, with percentages as percentages', () => {
    const v = regimeView('HK', {
      regime: 'bear_calm',
      deployCapPct: 0.3,
      deltaCap: 0.2,
      indexVsSma200Pct: -4.2,
      volIndex: null,
      indexSymbol: '2800.HK',
      volIndexSymbol: null,
      usedVolIndex: false,
      indexClose: 20,
      overrideCrashGuard: false,
    });
    expect(v).toMatchObject({ label: 'bear-calm', deployCapPct: 30, deltaCap: 0.2, usedVolIndex: false });
    expect(v.note).toMatch(/4\.2% below its 200-day average; no vol index/);
  });
});

describe('symbol parsing for the watchlist', () => {
  it('infers the market like the command line does', () => {
    expect(inferMarket('700')).toBe('HK');
    expect(inferMarket('0700.HK')).toBe('HK');
    expect(inferMarket('AAPL')).toBe('US');
    expect(inferMarket('BRK.B')).toBe('US');
  });

  it('canonicalises and honours prefixes and explicit markets', () => {
    expect(parseMarketSymbol('700')).toEqual({ market: 'HK', symbol: '0700' });
    expect(parseMarketSymbol('hk:5')).toEqual({ market: 'HK', symbol: '0005' });
    expect(parseMarketSymbol('US:msft')).toEqual({ market: 'US', symbol: 'MSFT' });
    expect(parseMarketSymbol('brk-b')).toEqual({ market: 'US', symbol: 'BRK.B' });
    expect(parseMarketSymbol('0005', 'HK')).toEqual({ market: 'HK', symbol: '0005' });
    expect(() => parseMarketSymbol('AAPL', 'HK')).toThrow(/invalid HK symbol/);
    expect(() => parseMarketSymbol('12abc')).toThrow(/invalid US symbol/);
    expect(() => parseMarketSymbol('1234567')).toThrow(/invalid US symbol/);
  });
});

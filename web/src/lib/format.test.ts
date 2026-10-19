import { describe, expect, it } from 'vitest';
import {
  contractLabel,
  elapsed,
  money,
  num,
  parseNumber,
  pct,
  plural,
  priceOfIvText,
  ratioPct,
  shortDate,
  signedMoney,
  signedPct,
  strikeText,
  todayIso,
} from './format';

describe('format', () => {
  it('formats numbers with en-US grouping', () => {
    expect(num(1234567.891, 2)).toBe('1,234,567.89');
    expect(num(0.5, 0, 2)).toBe('0.5');
    expect(num(Number.NaN)).toBe('-');
  });

  it('treats percent fields as percentages and ratios as fractions', () => {
    expect(pct(12.345)).toBe('12.3%');
    expect(pct(5, 0)).toBe('5%');
    expect(pct(null)).toBe('-');
    expect(signedPct(4.5)).toBe('+4.5%');
    expect(signedPct(-0.25, 2)).toBe('-0.25%');
    expect(ratioPct(0.93)).toBe('93%');
    expect(ratioPct(undefined)).toBe('-');
  });

  it('writes money with US$ and HK$ prefixes', () => {
    expect(money(1234, 'USD')).toBe('US$1,234');
    expect(money(-4150, 'HKD')).toBe('-HK$4,150');
    expect(money(0.78, 'USD', 2)).toBe('US$0.78');
    expect(signedMoney(128400, 'HKD')).toBe('+HK$128,400');
    expect(signedMoney(-4150, 'USD')).toBe('-US$4,150');
  });

  it('formats dates without a timezone shift', () => {
    expect(shortDate('2026-11-13')).toBe('13 Nov');
    expect(shortDate('2026-01-05')).toBe('5 Jan');
    expect(shortDate('not a date')).toBe('not a date');
    expect(contractLabel('2026-11-13', 64)).toBe('13 Nov 64P');
    expect(contractLabel('2026-10-29', 60.5)).toBe('29 Oct 60.5P');
    expect(strikeText(395)).toBe('395');
    expect(todayIso(new Date(2026, 9, 11))).toBe('2026-10-11');
  });

  it('formats elapsed time and plurals', () => {
    expect(elapsed(12_400)).toBe('12s');
    expect(elapsed(65_000)).toBe('1m 05s');
    expect(elapsed(-5)).toBe('0s');
    expect(plural(1, 'put')).toBe('1 put');
    expect(plural(3, 'put')).toBe('3 puts');
    expect(priceOfIvText(0.834)).toBe('price 83% of IV');
  });

  it('parses user-typed numbers strictly', () => {
    expect(parseNumber('1,200')).toBe(1200);
    expect(parseNumber(' 3.5 ')).toBe(3.5);
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('abc')).toBeNull();
    expect(parseNumber('1e999')).toBeNull();
  });
});

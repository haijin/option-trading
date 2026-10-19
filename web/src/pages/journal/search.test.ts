import { describe, expect, it } from 'vitest';
import { isFiltering, parseSearch } from './search';

describe('journal search box', () => {
  it('keeps plain words', () => {
    expect(parseSearch('roll rule')).toEqual({ q: 'roll rule' });
    expect(parseSearch('  ')).toEqual({ q: '' });
    expect(isFiltering(parseSearch(''))).toBe(false);
  });

  it('turns $NAME into a symbol the server understands', () => {
    expect(parseSearch('$NKE')).toEqual({ q: '', symbol: 'NKE' });
    expect(parseSearch('$nke')).toEqual({ q: '', symbol: 'NKE' });
    expect(parseSearch('$0700.HK')).toEqual({ q: '', symbol: '0700.HK' });
    expect(parseSearch('$700.hk')).toEqual({ q: '', symbol: '0700.HK' });
  });

  it('turns #tag into a tag without the hash', () => {
    expect(parseSearch('#breach')).toEqual({ q: '', tag: 'breach' });
    expect(parseSearch('#Roll-Rule')).toEqual({ q: '', tag: 'roll-rule' });
  });

  it('mixes words, a symbol and a tag', () => {
    expect(parseSearch('premium $NKE floor #lesson')).toEqual({ q: 'premium floor', symbol: 'NKE', tag: 'lesson' });
  });

  it('ignores a lone $ or # while the person is still typing', () => {
    expect(parseSearch('$')).toEqual({ q: '' });
    expect(parseSearch('#')).toEqual({ q: '' });
    expect(parseSearch('roll #')).toEqual({ q: 'roll' });
  });

  it('keeps $something that is not a stock name as a word, and extra symbols or tags as words', () => {
    expect(parseSearch('$12')).toEqual({ q: '12' });
    expect(parseSearch('$NKE $KO')).toEqual({ q: 'KO', symbol: 'NKE' });
    expect(parseSearch('#a #b')).toEqual({ q: 'b', tag: 'a' });
    expect(isFiltering(parseSearch('#a'))).toBe(true);
  });
});

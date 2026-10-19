import { describe, expect, it } from 'vitest';
import type { IdeaView } from '../api/types';
import { noSizeFits, prefillContracts, splitNarrativeLine, ticketText } from './ticket';

const idea = {
  symbol: 'KO',
  contract: { expiry: '2026-11-13', strike: 64, premium: 0.78, priceSource: 'yahoo' },
  sizing: { contracts: 2 },
} as unknown as IdeaView;

describe('ticket', () => {
  it('writes the one-line ticket', () => {
    expect(ticketText(idea)).toBe('SELL 2 x KO 2026-11-13 64 PUT @ ~0.78 (yahoo)');
  });

  it('shows ? when sizing produced no quantity', () => {
    expect(ticketText({ ...idea, sizing: null })).toBe('SELL ? x KO 2026-11-13 64 PUT @ ~0.78 (yahoo)');
  });

  it('knows when no whole contract fits the limits', () => {
    expect(noSizeFits({ ...idea, sizing: { contracts: 0 } } as unknown as IdeaView)).toBe(true);
    expect(noSizeFits(idea)).toBe(false);
    expect(noSizeFits({ ...idea, sizing: null })).toBe(false);
  });

  it('prefills the fill form only with a positive sized quantity', () => {
    expect(prefillContracts(idea)).toBe(2);
    expect(prefillContracts({ ...idea, sizing: { contracts: 0 } } as unknown as IdeaView)).toBeUndefined();
    expect(prefillContracts({ ...idea, sizing: null })).toBeUndefined();
  });

  it('splits "Label: text" narrative lines', () => {
    expect(splitNarrativeLine('Quality: F-score 7/9')).toEqual({ label: 'Quality', text: 'F-score 7/9' });
    const long = 'No label here, just a sentence: with a colon later on in a long line';
    expect(splitNarrativeLine(long)).toEqual({ label: null, text: long });
  });
});

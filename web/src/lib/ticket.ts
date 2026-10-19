import type { IdeaView } from '../api/types';
import { n2, strikeText } from './format';

/** Contracts to show on the ticket: the sized quantity, or "?" when the sizing skill produced none. */
export function ticketContracts(idea: IdeaView): string {
  return idea.sizing ? String(idea.sizing.contracts) : '?';
}

/** True when the sizing skill ran and no whole contract fits the limits (the idea stays listed as a warning). */
export function noSizeFits(idea: IdeaView): boolean {
  return idea.sizing !== null && idea.sizing.contracts === 0;
}

/** Contracts to prefill when logging a fill: the sized quantity, nothing when it is 0 or unknown (the form then asks). */
export function prefillContracts(idea: IdeaView): number | undefined {
  return idea.sizing && idea.sizing.contracts > 0 ? idea.sizing.contracts : undefined;
}

/** `SELL <contracts> x <symbol> <expiry> <strike> PUT @ ~<premium> (<priceSource>)` (no currency, one line). */
export function ticketText(idea: IdeaView): string {
  const { contract } = idea;
  return `SELL ${ticketContracts(idea)} x ${idea.symbol} ${contract.expiry} ${strikeText(contract.strike)} PUT @ ~${n2(contract.premium)} (${contract.priceSource})`;
}

/** Splits a narrative line such as "Quality: F-score 7/9" into a label and text; lines without a short label stay whole. */
export function splitNarrativeLine(line: string): { label: string | null; text: string } {
  const match = /^([A-Za-z][A-Za-z ]{1,13}):\s+(.*)$/.exec(line);
  return match ? { label: match[1] as string, text: match[2] as string } : { label: null, text: line };
}

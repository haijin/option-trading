import type { Db } from '../../src/db/client';
import { loadParams } from '../../src/db/repos';
import { recommendations, scanRuns } from '../../src/db/schema';

/** A stored live scan run with one 14 Nov style recommendation per instrument (rank in the order given). */
export async function seedScanRun(db: Db, asOf: string, instrumentIds: number[], startedAt: string): Promise<string> {
  const { id: paramsId } = await loadParams(db);
  const [run] = await db
    .insert(scanRuns)
    .values({
      asOf,
      paramsId,
      mode: 'live',
      status: 'done',
      startedAt: new Date(startedAt),
      finishedAt: new Date(startedAt),
    })
    .returning({ id: scanRuns.id });
  const scanRunId = (run as { id: string }).id;
  for (const [i, instrumentId] of instrumentIds.entries()) {
    await db.insert(recommendations).values({
      scanRunId,
      instrumentId,
      asOf,
      rank: i + 1,
      underlyingPrice: '72.40',
      strike: '65',
      expiry: '2026-11-13',
      dte: 35,
      creditPerContract: '120',
      collateralPerContract: '6500',
      collateralBaseCcy: '6500',
      roc: '0.0184',
      annualizedRoc: '0.194',
      breakeven: '63.8',
      cushionPct: '0.12',
      composite: '71',
      reasons: [],
      dataTier: 'real',
    });
  }
  return scanRunId;
}

/** The fenced json block a well-behaved model answers with. */
export function judgement(
  over: Partial<{ impact: string; summary: string; rules: { key: string; text: string }[]; confidence: number }> = {},
): string {
  const body = {
    impact: 'supports',
    summary: 'guidance looks intact and the put stays clear of the dated event',
    rules: [{ key: 't', text: 'the trend is unchanged' }],
    confidence: 70,
    ...over,
  };
  return `Here is my judgement.\n\n\`\`\`json\n${JSON.stringify(body)}\n\`\`\`\n`;
}

/** True for the market-brief prompt (the story-judgement prompt is a different template). */
export const isBriefPrompt = (prompt: string): boolean => prompt.includes('You write the market brief');

/** A well-behaved model's brief answer: two bullets citing stories S1 and S2, no numbers beyond what the input carries. */
export function briefAnswer(
  over: Partial<{
    lead: string;
    bullets: { tag: string; text: string; cites: string[] }[];
    for_puts: string;
    cites: string[];
  }> = {},
): string {
  const body = {
    lead: 'Banks start reporting while Asian shares slip on higher yields.',
    bullets: [
      { tag: 'US', text: 'Big banks open the earnings season.', cites: ['S1'] },
      { tag: 'HK·CN', text: 'Asian shares fall as yields rise.', cites: ['S2'] },
    ],
    for_puts: 'Hong Kong looks richer this week; keep clear of the dated events.',
    ...over,
  };
  return `Here is the brief.\n\n\`\`\`json\n${JSON.stringify(body)}\n\`\`\`\n`;
}

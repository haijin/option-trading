/**
 * The prompt of one Ask run and the check on what comes back. Pure: the service gathers the grounding, this file lays it
 * out. Layout: rules, the matched pitfalls only, the Hong Kong notes when the name is HK, the grounding (the app's own
 * numbers), the earlier turns of the thread, the question.
 */
import type { KnowledgeDoc } from './knowledge';

export interface AskGroundingSection {
  heading: string;
  body: string;
}

export interface AskTurn {
  question: string;
  answer: string;
}

export interface AskPromptInput {
  rules: string;
  today: string;
  /** One line naming what the question is about ("Idea: SNOW (US), the 2026-11-20 180 put"). */
  target: string;
  pitfalls: KnowledgeDoc[];
  notes: KnowledgeDoc[];
  grounding: AskGroundingSection[];
  thread: AskTurn[];
  question: string;
}

/** The largest answer kept; longer ones are refused as not an answer for a phone. */
export const ANSWER_MAX_CHARS = 8000;

export function buildAskPrompt(i: AskPromptInput): string {
  const parts: string[] = [
    `You are the Ask box of a personal put-selling decision-support app. Today is ${i.today}. The question is about: ${i.target}.`,
    'You have no tools. Do not create, edit or save any file. Answer from the text below only.',
    '',
    '=== RULES ===',
    i.rules.trim(),
    '',
    '=== PITFALLS (the ones that match this question; cite them by number) ===',
  ];
  for (const p of i.pitfalls) parts.push(`--- pitfall ${p.id}: ${p.title} ---`, p.body.trim(), '');
  if (i.notes.length > 0) {
    parts.push('=== HONG KONG NOTES ===');
    for (const n of i.notes) parts.push(`--- ${n.title} ---`, n.body.trim(), '');
  }
  parts.push("=== GROUNDING (the app's own numbers; these are the numbers) ===");
  for (const g of i.grounding) parts.push(`### ${g.heading}`, g.body.trim(), '');
  if (i.thread.length > 0) {
    parts.push(
      '=== THREAD (earlier questions about the same target, oldest first; the user may push back on them) ===',
    );
    for (const t of i.thread) parts.push(`Q: ${t.question.trim()}`, `A: ${t.answer.trim()}`, '');
  }
  parts.push(
    '=== QUESTION ===',
    i.question.trim(),
    '',
    'Answer now, in the language of the question, in plain Markdown, 120 to 250 words, opening with the one-line answer.',
  );
  return parts.join('\n');
}

/** The model was asked for Markdown only; if it wrapped the whole answer in a code fence anyway, take the fence off. */
export function unfence(text: string): string {
  const t = text.replace(/\r\n/g, '\n').trim();
  const m = /^```(?:markdown|md)?\n([\s\S]*?)\n```$/.exec(t);
  return (m ? (m[1] as string) : t).trim();
}

/** Plain Markdown or nothing: empty, tiny, huge and HTML-bearing answers are refused and the run fails with the reason. */
export function validateAnswer(raw: string): { ok: true; markdown: string } | { ok: false; problem: string } {
  const markdown = unfence(raw);
  if (markdown.length === 0) return { ok: false, problem: 'the model returned an empty answer' };
  if (markdown.length < 20) return { ok: false, problem: 'the model returned a fragment, not an answer' };
  if (markdown.length > ANSWER_MAX_CHARS) return { ok: false, problem: 'the answer was too long for the phone' };
  if (/<\/?[a-z][a-z0-9-]*(?:\s[^>]*)?>/i.test(markdown)) return { ok: false, problem: 'the answer contained HTML' };
  return { ok: true, markdown };
}

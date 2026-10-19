import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { askConfig } from '../../src/server/research/ask-config';
import { buildAskPrompt, unfence, validateAnswer } from '../../src/server/research/ask-prompt';
import {
  ALL_PITFALL_IDS,
  DEFAULT_PITFALLS,
  HK_NOTE_FILES,
  hkNotes,
  MAX_PITFALLS,
  matchPitfalls,
  matchSituations,
  PITFALL_FILES,
  pitfallDoc,
  rulesText,
  SITUATIONS,
} from '../../src/server/research/knowledge';

const DIR = resolve(__dirname, '..', '..', 'src', 'server', 'research', 'knowledge');

describe('knowledge bundle files', () => {
  it('ships the ten pitfalls the design names, the two HK notes, the rules and the licence note', () => {
    expect([...ALL_PITFALL_IDS].sort((a, b) => a - b)).toEqual([4, 7, 13, 19, 21, 24, 30, 31, 36, 37]);
    for (const f of Object.values(PITFALL_FILES)) expect(existsSync(join(DIR, 'pitfalls', f)), f).toBe(true);
    for (const f of HK_NOTE_FILES) expect(existsSync(join(DIR, 'hk', f)), f).toBe(true);
    expect(existsSync(join(DIR, 'rules.md'))).toBe(true);
    expect(existsSync(join(DIR, 'LICENSE.md'))).toBe(true);
  });

  it('parses every pitfall: id and title from the frontmatter, a body in this app vocabulary with a how-to-apply list', () => {
    for (const id of ALL_PITFALL_IDS) {
      const d = pitfallDoc(id);
      expect(d.id).toBe(String(id));
      expect(d.title.length).toBeGreaterThan(20);
      expect(d.body).not.toMatch(/^---/);
      expect(d.body).toMatch(/How to apply/);
      expect(d.body.length).toBeLessThan(3500);
      // the adaptation: no paid-data recipes and no case-study tickers from the source repository
      expect(d.body).not.toMatch(/Unusual Whales|Funda|TradingView|\bNBIS\b|\bSNOW 2026|\bNOK\b|\bAPP\b|\bMNQ\b/);
    }
    expect(pitfallDoc(36).title).toMatch(/variance risk premium/i);
    expect(pitfallDoc(36).body).toContain('`vol.vrpForward`');
    expect(pitfallDoc(36).body).toContain('`option.lossProbRv`');
    expect(pitfallDoc(7).body).toContain('`events.earningsWindow`');
    expect(pitfallDoc(30).body).toMatch(/board lot/);
    expect(pitfallDoc(13).body).toContain('`profit50`');
  });

  it('has two Hong Kong notes: the multiplier against the board lot and the expiry rule', () => {
    const notes = hkNotes();
    expect(notes.map((n) => n.id)).toEqual(['hk-multiplier', 'hk-expiry']);
    expect(notes[0]?.body).toMatch(/board lot/);
    expect(notes[0]?.body).toMatch(/SMIC 2500/);
    expect(notes[1]?.body).toMatch(/business day before the last business day/);
  });

  it('has a rules header that forbids sizing and strikes, demands the app numbers and the question language', () => {
    const r = rulesText();
    expect(r).toMatch(/Never size a trade and never pick a strike/);
    expect(r).toMatch(/The app's numbers are the numbers/);
    expect(r).toMatch(/language of the question/);
    expect(r).toMatch(/base, bull, bear/);
    expect(r).toMatch(/self-critical, not suggestible/);
    expect(r).toMatch(/say what changed/);
  });
});

describe('situation map', () => {
  it('routes the four examples of the design', () => {
    expect(matchPitfalls('Should I sell this put? IV looks high', 'idea')).toEqual([36, 19, 7, 21]);
    expect(matchPitfalls('这个可以收租吗？想卖put', 'idea')).toEqual([36, 19, 7, 21]);
    expect(matchPitfalls('Results are next month, is that a problem?', 'idea')).toEqual([7, 21, 37]);
    expect(matchPitfalls('业绩前安全吗', 'idea')).toEqual([7, 21, 37]);
    expect(matchPitfalls('What size makes sense, and how do I cap the drawdown?', 'idea')).toEqual([30, 31]);
    expect(matchPitfalls('仓位多少合适，回撤怎么控制', 'idea')).toEqual([30, 31]);
    expect(matchPitfalls('Roll it or close at 50%?', 'position')).toEqual([13, 4]);
    expect(matchPitfalls('展期还是止盈？', 'position')).toEqual([13, 4]);
  });

  it('merges situations in map order without duplicates and caps the list', () => {
    expect(matchPitfalls('Sell before results?', 'idea')).toEqual([36, 19, 7, 21, 37]);
    const all = matchPitfalls('sell results size roll wait bullish', 'idea');
    expect(all).toHaveLength(MAX_PITFALLS);
    expect(all).toEqual([36, 19, 7, 21, 37, 30]);
    expect(new Set(all).size).toBe(all.length);
  });

  it('falls back by target kind when nothing matches', () => {
    expect(matchPitfalls('Why WARN?', 'idea')).toEqual([...DEFAULT_PITFALLS.idea]);
    expect(matchPitfalls('What now?', 'position')).toEqual([...DEFAULT_PITFALLS.position]);
    expect(matchSituations('为什么是黄色警告')).toEqual([]);
  });

  it('matches ASCII keywords on word boundaries and is case-insensitive', () => {
    expect(matchSituations('my payroll is late').map((s) => s.name)).toEqual([]);
    expect(matchSituations('I want to hedge').map((s) => s.name)).toEqual([]);
    expect(matchSituations('SELL IT?').map((s) => s.name)).toEqual(['sell']);
    expect(matchSituations('close at 50%').map((s) => s.name)).toEqual(['manage']);
  });

  it('every situation points at pitfalls that exist', () => {
    for (const s of SITUATIONS) for (const p of s.pitfalls) expect(ALL_PITFALL_IDS, s.name).toContain(p);
  });
});

describe('prompt builder', () => {
  const base = {
    rules: rulesText(),
    today: '2026-10-19',
    target: 'Idea: SNOW (US), the 2026-11-20 180 put',
    pitfalls: [pitfallDoc(36), pitfallDoc(19)],
    notes: [],
    grounding: [
      { heading: 'The idea', body: '- spot 200; cushion 9.9%' },
      { heading: 'Reasons JSON', body: '{"rule":"vol.vrpForward","level":"INFO","value":"unmeasured"}' },
    ],
    thread: [],
    question: 'Is the IV worth selling?',
  };

  it('lays out rules, the matched pitfalls only, the grounding and the question, in that order', () => {
    const p = buildAskPrompt(base);
    const at = (s: string) => {
      const i = p.indexOf(s);
      expect(i, s).toBeGreaterThanOrEqual(0);
      return i;
    };
    expect(at('=== RULES ===')).toBeLessThan(at('--- pitfall 36:'));
    expect(at('--- pitfall 36:')).toBeLessThan(at('--- pitfall 19:'));
    expect(at('--- pitfall 19:')).toBeLessThan(at('=== GROUNDING'));
    expect(at('### Reasons JSON')).toBeLessThan(at('=== QUESTION ==='));
    expect(at('=== QUESTION ===')).toBeLessThan(at('Is the IV worth selling?'));
    expect(p).not.toContain('--- pitfall 13:');
    expect(p).not.toContain('HONG KONG NOTES');
    expect(p).not.toContain('=== THREAD');
    expect(p).toContain('Today is 2026-10-19');
    expect(p).toContain('"rule":"vol.vrpForward"');
    expect(p).toMatch(/Do not create, edit or save any file/);
    expect(p).toMatch(/in the language of the question/);
  });

  it('adds the Hong Kong notes and the earlier turns when given', () => {
    const p = buildAskPrompt({
      ...base,
      notes: hkNotes(),
      thread: [{ question: 'Why this put?', answer: 'Because the cushion is 9.9%.' }],
    });
    expect(p).toContain('=== HONG KONG NOTES ===');
    expect(p).toMatch(/board lot/);
    expect(p.indexOf('=== THREAD')).toBeLessThan(p.indexOf('=== QUESTION ==='));
    expect(p).toContain('Q: Why this put?');
    expect(p).toContain('A: Because the cushion is 9.9%.');
  });
});

describe('answer validation', () => {
  it('takes a whole-answer code fence off and keeps plain Markdown', () => {
    expect(unfence('```markdown\n**Short answer:** yes, with a caveat.\n```')).toBe(
      '**Short answer:** yes, with a caveat.',
    );
    const ok = validateAnswer('**Short answer:** the cushion is 9.9% and `vol.vrpForward` is unmeasured.');
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.markdown).toMatch(/^\*\*Short answer/);
  });

  it('refuses empty, fragment, HTML and oversized answers with a reason', () => {
    expect(validateAnswer('   ')).toEqual({ ok: false, problem: 'the model returned an empty answer' });
    expect(validateAnswer('Yes.')).toMatchObject({ ok: false, problem: expect.stringMatching(/fragment/) });
    expect(validateAnswer('<b>Short answer</b>: sell it, the numbers are fine.')).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/HTML/),
    });
    expect(validateAnswer('x'.repeat(8001))).toMatchObject({ ok: false, problem: expect.stringMatching(/too long/) });
    // an inline "<" comparison is not HTML
    expect(validateAnswer('P(S_T < breakeven) is 21% at realised vol, 25% at implied.').ok).toBe(true);
  });
});

describe('ask config', () => {
  it('reads the environment with sane defaults and lets overrides win', () => {
    expect(askConfig({})).toEqual({
      model: 'claude-sonnet-5-5',
      maxBudgetUsd: 0.25,
      dailyBudgetUsd: 2,
      timeoutMs: 150_000,
    });
    expect(
      askConfig({
        OT_ASK_MODEL: ' claude-opus-5-5 ',
        OT_ASK_MAX_BUDGET_USD: '0.5',
        OT_ASK_DAILY_BUDGET_USD: 'nope',
        OT_ASK_TIMEOUT_MS: '-3',
      }),
    ).toEqual({ model: 'claude-opus-5-5', maxBudgetUsd: 0.5, dailyBudgetUsd: 2, timeoutMs: 150_000 });
    expect(askConfig({ OT_ASK_MAX_BUDGET_USD: '0.5' }, { maxBudgetUsd: 0.1, timeoutMs: 1000 })).toMatchObject({
      maxBudgetUsd: 0.1,
      timeoutMs: 1000,
    });
  });
});

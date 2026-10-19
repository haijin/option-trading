import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KPI_HELP, kpiHelp, RULE_HELP, ruleHelp } from '../web/src/lib/glossary';

const ROOT = resolve(__dirname, '..');

/** Rule ids the skills can emit: the first argument of pass/fail/info/warnRule/warnData and `rule: '...'` literals. */
function emittedRules(): Set<string> {
  const dir = join(ROOT, 'src', 'skills');
  const out = new Set<string>();
  for (const file of readdirSync(dir).filter((f) => /^s\d-.*\.ts$/.test(f))) {
    const text = readFileSync(join(dir, file), 'utf8');
    for (const m of text.matchAll(/(?:pass|fail|info|warnRule|warnData)\(\s*'([a-z]+\.[A-Za-z0-9]+)'/g))
      out.add(m[1] as string);
    for (const m of text.matchAll(/rule:\s*'([a-z]+\.[A-Za-z0-9]+)'/g)) out.add(m[1] as string);
  }
  return out;
}

function kpiKeys(): string[] {
  const text = readFileSync(join(ROOT, 'src', 'valuation', 'kpi.ts'), 'utf8');
  return [...text.matchAll(/row\(\s*'[A-Za-z ]+',\s*'([a-z0-9_]+)'/g)].map((m) => m[1] as string);
}

describe('glossary', () => {
  it('explains every rule a skill can emit (add an entry when you add a rule)', () => {
    const missing = [...emittedRules()].filter((r) => !(r in RULE_HELP)).sort();
    expect(missing).toEqual([]);
  });

  it('explains every financial KPI', () => {
    const keys = kpiKeys();
    expect(keys.length).toBeGreaterThanOrEqual(20);
    expect(keys.filter((k) => !(k in KPI_HELP))).toEqual([]);
  });

  it('has no entry for a rule or KPI that no longer exists', () => {
    const rules = emittedRules();
    const stale = Object.keys(RULE_HELP).filter((r) => !rules.has(r));
    // emitted through shared lists or outside the s0-s7 files, so not visible as literals: valuation.* (a table in s1),
    // the option-select stages, the freshness gate and the runner
    const indirect = new Set(['delta.band', 'liquidity.bid', 'data.stale', 'skill.error']);
    expect(stale.filter((r) => !r.startsWith('valuation.') && !indirect.has(r))).toEqual([]);
    expect(Object.keys(KPI_HELP).filter((k) => !kpiKeys().includes(k))).toEqual([]);
  });

  it('gives every entry all three answers in full sentences', () => {
    for (const [id, help] of [...Object.entries(RULE_HELP), ...Object.entries(KPI_HELP)]) {
      for (const part of [help.what, help.why, help.read]) {
        expect(part.length, id).toBeGreaterThan(9);
        expect(part, id).toMatch(/[.)]$/);
      }
    }
  });

  it('looks entries up by id and returns null for an unknown one', () => {
    expect(ruleHelp('vol.ivRank')?.what).toMatch(/implied volatility/i);
    expect(kpiHelp('fcf_yield')?.read).toMatch(/4%/);
    expect(ruleHelp('nope.nothing')).toBeNull();
  });
});

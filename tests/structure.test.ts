/**
 * Architecture guard (docs/02 section 1): module boundaries and skill purity, enforced by a test as well as by biome's
 * noRestrictedImports, so a lint-config edit cannot silently remove the rule.
 *   skills may import core and indicators only; only cli imports providers; skills never read the clock or env.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve('src');

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
  );
}

const moduleOf = (file: string): string => relative(SRC, file).split(sep)[0] as string;

function importsOf(file: string): { spec: string; target: string | null }[] {
  const text = readFileSync(file, 'utf8');
  const out: { spec: string; target: string | null }[] = [];
  for (const m of text.matchAll(
    /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g,
  )) {
    const spec = (m[1] ?? m[2] ?? m[3]) as string;
    if (spec.startsWith('.')) out.push({ spec, target: moduleOf(resolve(file, '..', spec)) });
    else out.push({ spec, target: null });
  }
  return out;
}

const all = files(SRC).map((f) => ({ file: f, mod: moduleOf(f), imports: importsOf(f) }));

describe('module boundaries', () => {
  it('skills import only core, indicators and themselves; no database driver or ORM', () => {
    const bad: string[] = [];
    for (const f of all.filter((x) => x.mod === 'skills')) {
      for (const i of f.imports) {
        if (i.target !== null && !['skills', 'core', 'indicators'].includes(i.target))
          bad.push(`${relative(SRC, f.file)} -> ${i.spec}`);
        if (i.target === null && /^(pg|drizzle-orm|yahoo-finance2|commander|csv-parse)(\/|$)/.test(i.spec))
          bad.push(`${relative(SRC, f.file)} -> ${i.spec}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('core and indicators depend on nothing above them', () => {
    const bad: string[] = [];
    for (const f of all.filter((x) => x.mod === 'core' || x.mod === 'indicators')) {
      for (const i of f.imports)
        if (i.target !== null && !['core', 'indicators'].includes(i.target))
          bad.push(`${relative(SRC, f.file)} -> ${i.spec}`);
    }
    expect(bad).toEqual([]);
  });

  it('valuation is pure: it imports only core, indicators and itself, no driver, ORM or provider client', () => {
    const bad: string[] = [];
    for (const f of all.filter((x) => x.mod === 'valuation')) {
      for (const i of f.imports) {
        if (i.target !== null && !['valuation', 'core', 'indicators'].includes(i.target))
          bad.push(`${relative(SRC, f.file)} -> ${i.spec}`);
        if (i.target === null && /^(pg|drizzle-orm|yahoo-finance2|commander|csv-parse|fastify)(\/|$)/.test(i.spec))
          bad.push(`${relative(SRC, f.file)} -> ${i.spec}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('only cli, server and jobs import providers; nothing but the server imports server', () => {
    const bad: string[] = [];
    // jobs is an application layer like cli and server (docs/02 section 1: the API process owns the scheduled jobs)
    for (const f of all.filter((x) => !['cli', 'server', 'providers', 'jobs'].includes(x.mod))) {
      for (const i of f.imports) if (i.target === 'providers') bad.push(`${relative(SRC, f.file)} -> ${i.spec}`);
    }
    for (const f of all.filter((x) => x.mod !== 'server')) {
      for (const i of f.imports) if (i.target === 'server') bad.push(`${relative(SRC, f.file)} -> ${i.spec}`);
    }
    expect(bad).toEqual([]);
  });

  it('db never imports providers or cli; providers never import skills or cli', () => {
    const bad: string[] = [];
    for (const f of all) {
      for (const i of f.imports) {
        if (f.mod === 'db' && (i.target === 'providers' || i.target === 'cli'))
          bad.push(`${relative(SRC, f.file)} -> ${i.spec}`);
        if (f.mod === 'providers' && (i.target === 'skills' || i.target === 'cli'))
          bad.push(`${relative(SRC, f.file)} -> ${i.spec}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('skills and indicators are pure', () => {
  it('no clock, randomness or environment access in src/skills, src/indicators or src/valuation', () => {
    const forbidden =
      /\bDate\.now\s*\(|new Date\(\s*\)|performance\.now\s*\(|Math\.random\s*\(|process\.env|\bfetch\s*\(/;
    const bad: string[] = [];
    for (const f of all.filter((x) => x.mod === 'skills' || x.mod === 'indicators' || x.mod === 'valuation')) {
      const code = readFileSync(f.file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      if (forbidden.test(code)) bad.push(relative(SRC, f.file));
    }
    expect(bad).toEqual([]);
  });

  it('the app never touches a broker trading API: no order/execution vocabulary in src', () => {
    const bad: string[] = [];
    for (const f of all) {
      const code = readFileSync(f.file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      if (/\b(placeOrder|submitOrder|createOrder|sendOrder|cancelOrder)\b|\/orders?\b/i.test(code))
        bad.push(relative(SRC, f.file));
    }
    expect(bad).toEqual([]);
  });
});

describe("the journal is the user's own notes", () => {
  const stripComments = (file: string): string =>
    readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

  it('the journal tables are touched only by their schema and repository: no skill, scanner, backtest or DataAccess reads them', () => {
    const tables =
      /\bjournalEntries\b|\bjournalRevisions\b|\bjournalEntryInstruments\b|\bjournalAssets\b|\bjournalAiRuns\b|\bjournal_(entries|revisions|entry_instruments|assets|ai_runs)\b/;
    const allowed = new Set(['db/schema.ts', 'db/journal.ts']);
    const bad: string[] = [];
    for (const f of all) {
      const rel = relative(SRC, f.file).split(sep).join('/');
      if (allowed.has(rel)) continue;
      if (tables.test(stripComments(f.file))) bad.push(rel);
    }
    expect(bad).toEqual([]);
  });

  it('src/journal is a pure document model: it imports nothing from the rest of src, only itself and the editor packages', () => {
    const bad: string[] = [];
    for (const f of all.filter((x) => x.mod === 'journal')) {
      for (const i of f.imports) {
        if (i.target !== null && i.target !== 'journal') bad.push(`${relative(SRC, f.file)} -> ${i.spec}`);
        if (i.target === null && !/^(@tiptap\/|markdown-it$)/.test(i.spec))
          bad.push(`${relative(SRC, f.file)} -> ${i.spec}`);
      }
      if (/process\.env|\bfetch\s*\(|Date\.now\s*\(|new Date\(\s*\)|Math\.random\s*\(/.test(stripComments(f.file)))
        bad.push(`${relative(SRC, f.file)} reads the clock, randomness, the environment or the network`);
    }
    expect(bad).toEqual([]);
  });

  it('no skill, indicator, valuation, backtest, provider or CLI code imports the journal model or its repository', () => {
    const journalModel = join(SRC, 'journal');
    const journalRepo = join(SRC, 'db', 'journal');
    const bad: string[] = [];
    for (const f of all) {
      if (['server', 'db', 'journal', 'jobs'].includes(f.mod)) continue;
      for (const i of f.imports) {
        if (!i.spec.startsWith('.')) continue;
        const target = resolve(f.file, '..', i.spec);
        if (target === journalModel || target.startsWith(journalModel + sep) || target === journalRepo)
          bad.push(`${relative(SRC, f.file)} -> ${i.spec}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('the news tables are display-only (docs/designs/latest-news.md)', () => {
  const code = (f: string): string =>
    readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

  it('no skill, indicator, valuation or backtest code reads or names the news tables', () => {
    const bad: string[] = [];
    for (const f of all.filter((x) => ['skills', 'indicators', 'valuation', 'backtest'].includes(x.mod)))
      if (/news_items|news_briefs|newsItems|newsBriefs|db\/news|core\/news/.test(code(f.file)))
        bad.push(relative(SRC, f.file));
    expect(bad).toEqual([]);
  });

  it('the news code never writes to a table a skill reads or to events, verdicts or recommendations', () => {
    const protectedTables =
      'corporateEvents|researchRuns|researchVerdicts|recommendations|skillRuns|fundamentalStatements|instruments|priceBars|positions|watchlist|marketRegime|optionQuotes|ivDaily|fxRates';
    const write = new RegExp(String.raw`\.(insert|update|delete)\(\s*(${protectedTables})\b`);
    const newsFiles = all.filter((x) => relative(SRC, x.file).includes('news'));
    expect(newsFiles.length).toBeGreaterThan(5);
    const bad: string[] = [];
    for (const f of newsFiles) if (write.test(code(f.file))) bad.push(relative(SRC, f.file));
    expect(bad).toEqual([]);
    // the guard itself works: a write to a protected table is caught
    expect(write.test('await db.update(corporateEvents).set({})')).toBe(true);
    expect(write.test('await db.update(newsItems).set({})')).toBe(false);
  });

  it('no model call inside the scan path: cli scan and the pipeline never reach the news model code', () => {
    const bad: string[] = [];
    for (const f of all.filter((x) => x.mod === 'cli'))
      for (const i of f.imports) if (/news/.test(i.spec)) bad.push(`${relative(SRC, f.file)} -> ${i.spec}`);
    expect(bad).toEqual([]);
  });
});

describe('the Leaders page is display-only (docs/designs/leaders-pullback.md)', () => {
  const code = (f: string): string =>
    readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
  const rel = (f: string): string => relative(SRC, f).split(sep).join('/');

  it('only the schema and the two repositories name the leaders and universe tables', () => {
    const tables =
      /\bleadersRuns\b|\bleadersCandidates\b|\bleadersMutes\b|\buniverseMembers\b|\b(leaders_(runs|candidates|mutes)|universe_members)\b/;
    const allowed = new Set(['db/schema.ts', 'db/leaders.ts', 'db/universe.ts']);
    const bad: string[] = [];
    for (const f of all) if (!allowed.has(rel(f.file)) && tables.test(code(f.file))) bad.push(rel(f.file));
    expect(bad).toEqual([]);
  });

  it('no skill, indicator, valuation, backtest or core code imports the leaders or universe repositories or modules', () => {
    const bad: string[] = [];
    for (const f of all.filter((x) => ['skills', 'indicators', 'valuation', 'backtest', 'core'].includes(x.mod)))
      for (const i of f.imports)
        if (
          /(^|\/)(db\/(leaders|universe)|leaders\/|jobs\/(leaders|universe))/.test(i.spec) ||
          (/\/leaders$/.test(i.spec) && !/core\/leaders$/.test(i.spec))
        )
          bad.push(`${rel(f.file)} -> ${i.spec}`);
    // core/leaders is the shared vocabulary (types and pure rules); the skill itself is the one file in skills named for the feature
    expect(bad).toEqual([]);
    for (const f of all.filter((x) => ['skills', 'backtest'].includes(x.mod))) {
      if (
        rel(f.file) === 'skills/s8-leaders-pullback.ts' ||
        rel(f.file) === 'skills/registry.ts' ||
        rel(f.file) === 'skills/index.ts'
      )
        continue;
      expect(/leaders_|leadersRuns|leadersCandidates|universeMembers/.test(code(f.file)), rel(f.file)).toBe(false);
    }
  });

  it('the sell-put pipeline never runs the leaders skill: the runner does not name it and the registry keeps it out of SKILLS', () => {
    expect(/leaders|s8-/.test(code(join(SRC, 'skills', 'runner.ts')))).toBe(false);
    expect(/leaders|s8-/.test(code(join(SRC, 'cli', 'pipeline.ts')))).toBe(false);
    const registry = code(join(SRC, 'skills', 'registry.ts'));
    const skillsList = /export const SKILLS[\s\S]*?\] as AnalysisSkill\[\]/.exec(registry)?.[0] ?? '';
    expect(skillsList.length).toBeGreaterThan(50);
    expect(/leadersPullback/.test(skillsList)).toBe(false);
  });

  it('the leaders and universe code never writes to recommendations, positions, research verdicts or corporate events', () => {
    const protectedTables = 'recommendations|positions|researchVerdicts|corporateEvents';
    const write = new RegExp(String.raw`\.(insert|update|delete)\(\s*(${protectedTables})\b`);
    const mine = all.filter((x) => /leaders|universe/.test(rel(x.file)) && !rel(x.file).startsWith('skills/'));
    expect(mine.length).toBeGreaterThan(8);
    const bad: string[] = [];
    for (const f of mine) if (write.test(code(f.file))) bad.push(rel(f.file));
    expect(bad).toEqual([]);
    expect(write.test('await db.update(corporateEvents).set({})')).toBe(true);
    expect(write.test('await db.insert(leadersRuns).values({})')).toBe(false);
  });

  it('no model call inside the CLI scan path: the cli leaders command never imports the server, an executor or a prompt', () => {
    const bad: string[] = [];
    for (const f of all.filter((x) => x.mod === 'cli'))
      for (const i of f.imports)
        if (/research\/executor|server\/leaders|services\/leaders|prompts\//.test(i.spec))
          bad.push(`${rel(f.file)} -> ${i.spec}`);
    expect(bad).toEqual([]);
    // the job that scans is model-free too: only the brief step takes a port, supplied by the server
    expect(/executor|SkillExecutor|claude/i.test(code(join(SRC, 'jobs', 'leaders-scan.ts')))).toBe(false);
  });
});

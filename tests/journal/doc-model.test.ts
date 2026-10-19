import { describe, expect, it } from 'vitest';
import {
  applyTemplate,
  cleanTitle,
  countWords,
  deriveFromDoc,
  EMPTY_DOC,
  excerptOf,
  extractLessons,
  isEmptyDoc,
  JOURNAL_LIMITS,
  JOURNAL_TEMPLATES,
  type JournalDocJson,
  lessonsOf,
  mentionLabel,
  mentionsOfMarkdown,
  normaliseTag,
  normaliseTags,
  parseMention,
  parseTagInput,
  snippetFor,
  validateJournalDoc,
} from '../../src/journal';
import { KITCHEN_SINK } from './fixtures';

const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const doc = (...content: unknown[]): JournalDocJson => ({ type: 'doc', content }) as JournalDocJson;
const rejected = (input: unknown): string => {
  const r = validateJournalDoc(input);
  expect(r.ok, 'expected the document to be rejected').toBe(false);
  return r.ok ? '' : r.issues.map((i) => `${i.path}: ${i.message}`).join(' | ');
};

describe('validateJournalDoc: what the server accepts', () => {
  it('accepts the empty document, every template and a document with every node and mark', () => {
    expect(validateJournalDoc(EMPTY_DOC).ok).toBe(true);
    for (const t of JOURNAL_TEMPLATES) expect(validateJournalDoc(t.doc).ok, t.id).toBe(true);
    expect(validateJournalDoc(KITCHEN_SINK).ok).toBe(true);
  });

  it('returns a canonical document that validates to itself', () => {
    const first = validateJournalDoc(KITCHEN_SINK);
    if (!first.ok) throw new Error('kitchen sink rejected');
    const second = validateJournalDoc(first.doc);
    expect(second.ok && second.doc).toEqual(first.doc);
  });

  it('collects the asset ids of figures (a figure itself is allowed in the schema)', () => {
    const id = '0b9a8f0e-6b8c-4f9e-8a53-5a6d6c1b9a11';
    const r = validateJournalDoc(doc({ type: 'figure', attrs: { assetId: id, caption: 'chart' } }));
    expect(r.ok && r.assetIds).toEqual([id]);
  });
});

describe('validateJournalDoc: what it rejects (never silently drops)', () => {
  it('rejects an unknown node type and an img node', () => {
    expect(rejected(doc({ type: 'script' }))).toContain('node "script" is not allowed');
    expect(rejected(doc({ type: 'img', attrs: { src: 'https://evil.example/x.png' } }))).toContain(
      'node "img" is not allowed',
    );
    expect(rejected(doc({ type: 'paragraph', content: [{ type: 'img', attrs: { src: 'x' } }] }))).toContain('"img"');
  });

  it('rejects an unknown attribute on any node, even a harmless-looking one', () => {
    expect(rejected(doc({ type: 'paragraph', attrs: { class: 'x' }, content: [] }))).toContain(
      'has no attribute "class"',
    );
    expect(
      rejected(doc({ type: 'heading', attrs: { level: 2, id: 'a' }, content: [{ type: 'text', text: 'x' }] })),
    ).toContain('"id"');
    const id = '0b9a8f0e-6b8c-4f9e-8a53-5a6d6c1b9a11';
    expect(rejected(doc({ type: 'figure', attrs: { assetId: id, onerror: 'alert(1)' } }))).toContain('"onerror"');
    expect(rejected(doc({ type: 'figure', attrs: { assetId: id, src: 'https://evil.example/x.png' } }))).toContain(
      '"src"',
    );
  });

  it('rejects a mark on a table cell, on a paragraph and on a figure (marks belong to text)', () => {
    const cellWithMark = doc({
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [{ type: 'tableCell', marks: [{ type: 'bold' }], content: [para('x')] }],
        },
      ],
    });
    expect(rejected(cellWithMark)).toContain('cannot carry marks');
    expect(rejected(doc({ type: 'paragraph', marks: [{ type: 'bold' }], content: [] }))).toContain(
      'cannot carry marks',
    );
  });

  it('rejects marks and mark attributes that are not in the schema', () => {
    const text = (marks: unknown[]) => doc({ type: 'paragraph', content: [{ type: 'text', text: 'x', marks }] });
    expect(rejected(text([{ type: 'link', attrs: { href: 'https://evil.example' } }]))).toContain(
      'mark "link" is not allowed',
    );
    expect(rejected(text([{ type: 'bold', attrs: { x: 1 } }]))).toContain('no attribute "x"');
    expect(rejected(text([{ type: 'bold' }, { type: 'bold' }]))).toContain('repeated');
    expect(rejected(text([{ type: 'stockMention', attrs: { market: 'JP', symbol: 'NKE' } }]))).toContain('US or HK');
    expect(rejected(text([{ type: 'stockMention', attrs: { market: 'US', symbol: 'nke; drop' } }]))).toContain(
      'stock symbol',
    );
  });

  it('rejects headings other than level 2, and properties a node does not have', () => {
    expect(rejected(doc({ type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'x' }] }))).toContain(
      'level 2 only',
    );
    expect(rejected(doc({ type: 'paragraph', html: '<b>x</b>' }))).toContain('no property "html"');
    expect(rejected(doc({ type: 'paragraph', text: 'loose' }))).toContain('has no text');
  });

  it('rejects HTML, a non-doc root and non-objects', () => {
    expect(rejected('<p>hello</p>')).toContain('doc node');
    expect(rejected({ type: 'paragraph' })).toContain('doc node');
    expect(rejected(null)).toContain('doc node');
    expect(rejected(doc({ type: 'doc', content: [] }))).toContain('cannot be nested');
  });

  it('rejects an own __proto__ key smuggled in through JSON', () => {
    const hostile = JSON.parse('{"type":"doc","__proto__":{"polluted":true},"content":[{"type":"paragraph"}]}');
    expect(rejected(hostile)).toContain('__proto__');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('rejects structure the schema does not allow, even when every node type is allowed', () => {
    expect(rejected(doc({ type: 'listItem', content: [para('x')] }))).toContain('structure');
    expect(
      rejected(doc({ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'bulletList' }] }] })),
    ).toContain('structure');
    expect(rejected(doc({ type: 'table', content: [para('not a row')] }))).toContain('structure');
    const nestedTable = {
      type: 'table',
      content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'bulletList', content: [] }] }] }],
    };
    expect(rejected(doc(nestedTable))).toBeTruthy();
    expect(rejected(doc({ type: 'paragraph', content: [{ type: 'text', text: '' }] }))).toContain('non-empty text');
  });

  it('rejects an invalid figure and an invalid snapshot', () => {
    expect(rejected(doc({ type: 'figure', attrs: { assetId: 'not-a-uuid' } }))).toContain('asset id');
    const snap = (attrs: Record<string, unknown>) => doc({ type: 'snapshot', attrs });
    expect(rejected(snap({ kind: 'positions', asOf: 'yesterday' }))).toContain('must be a date');
    expect(rejected(snap({ kind: 'weather', asOf: '2026-10-13' }))).toContain('positions or scan');
    expect(rejected(snap({ kind: 'scan', asOf: '2026-10-13', rows: [[1, 2]] }))).toContain('short string');
    expect(
      rejected(snap({ kind: 'scan', asOf: '2026-10-13', rows: Array.from({ length: 101 }, () => ['x']) })),
    ).toContain('at most 100 rows');
  });

  it('rejects a document that is too large, too deep or has too many nodes', () => {
    const big = doc(para('x'.repeat(JOURNAL_LIMITS.docBytes)));
    expect(rejected(big)).toContain('KB');
    let nested: unknown = para('x');
    for (let i = 0; i < 30; i++) nested = { type: 'blockquote', content: [nested] };
    expect(rejected(doc(nested))).toContain('nested too deeply');
    const many = doc(...Array.from({ length: JOURNAL_LIMITS.maxNodes + 1 }, () => ({ type: 'paragraph' })));
    expect(rejected(many)).toContain('too many nodes');
  });

  it('allows list nesting a person can reach on a phone (six levels)', () => {
    let list: unknown = { type: 'bulletList', content: [{ type: 'listItem', content: [para('deep')] }] };
    for (let i = 0; i < 5; i++)
      list = { type: 'bulletList', content: [{ type: 'listItem', content: [para('level'), list] }] };
    expect(validateJournalDoc(doc(list)).ok).toBe(true);
  });

  it('never throws: keys like __proto__, constructor and valueOf are not attributes, nodes or marks', () => {
    for (const bad of [
      doc({ type: 'paragraph', attrs: JSON.parse('{"__proto__":1}') }),
      doc({ type: 'paragraph', attrs: { valueOf: 1 } }),
      doc({ type: 'constructor', attrs: { a: 1 } }),
      doc({ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'toString' }] }] }),
    ])
      expect(() => validateJournalDoc(bad)).not.toThrow();
    expect(rejected(doc({ type: 'constructor' }))).toContain('is not allowed');
    expect(rejected(doc({ type: 'paragraph', attrs: { valueOf: 1 } }))).toContain('no attribute');
    // A document nested far beyond what JSON.stringify can walk is refused, not a crash.
    let deep: unknown = para('x');
    for (let i = 0; i < 20_000; i++) deep = { type: 'blockquote', content: [deep] };
    expect(() => validateJournalDoc(doc(deep))).not.toThrow();
    expect(validateJournalDoc(doc(deep)).ok).toBe(false);
  });

  it('refuses text Postgres cannot store: NUL and lone surrogates (they would fail every autosave)', () => {
    expect(rejected(doc(para('a\u0000b')))).toContain('cannot be stored');
    expect(rejected(doc(para('a\ud800b')))).toContain('cannot be stored');
    expect(validateJournalDoc(doc(para('emoji 😀 and 中文 are fine'))).ok).toBe(true);
    const id = '0b9a8f0e-6b8c-4f9e-8a53-5a6d6c1b9a11';
    expect(rejected(doc({ type: 'figure', attrs: { assetId: id, caption: 'x\u0000' } }))).toContain('characters');
  });

  it('stores a heading without a level as level 2, and an image id in lower case', () => {
    const h = validateJournalDoc(doc({ type: 'heading', content: [{ type: 'text', text: 'Plan' }] }));
    expect(h.ok && h.doc.content?.[0]?.attrs).toEqual({ level: 2 });
    const id = '0B9A8F0E-6B8C-4F9E-8A53-5A6D6C1B9A11';
    const f = validateJournalDoc(doc({ type: 'figure', attrs: { assetId: id, caption: null } }));
    expect(f.ok && f.doc.content?.[0]?.attrs?.assetId).toBe(id.toLowerCase());
    expect(f.ok && f.assetIds).toEqual([id.toLowerCase()]);
    expect(f.ok && deriveFromDoc(f.doc).markdown).toBe(`![](asset:${id.toLowerCase()})`);
  });
});

describe('deriveFromDoc', () => {
  const validated = (d: JournalDocJson): JournalDocJson => {
    const r = validateJournalDoc(d);
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    return r.doc;
  };

  it('renders Markdown deterministically (golden)', () => {
    const expected = [
      '## Market',
      '',
      'HK open weak, $0700.HK held 600. **Not selling** and *maybe later* or ~~never~~.',
      '',
      String.raw`**$NKE** results \* tonight\_ \[x\]`,
      '',
      'first line  ',
      'second line',
      '',
      String.raw`\- not a list`,
      '',
      '- one',
      '  - nested',
      '- two',
      '',
      '3. third',
      '4. fourth',
      '',
      '- [ ] roll NKE',
      '- [x] update note',
      '',
      '> Lesson: stop checking the price every 10 min.',
      '',
      '| Name | Strike |',
      '| --- | --- |',
      String.raw`| NKE | 65 \| 62.5 |`,
      '',
      '<!-- snapshot:positions:2026-10-13T16:05 -->',
      '**Open positions**',
      '',
      '| Name | Put | P&L |',
      '| --- | ---: | ---: |',
      '| NKE | 65 | +$210 |',
      '| KO | 60 | +$95 |',
    ].join('\n');
    expect(deriveFromDoc(validated(KITCHEN_SINK)).markdown).toBe(expected);
    // Same document, same bytes, however often it is rendered.
    expect(deriveFromDoc(validated(KITCHEN_SINK)).markdown).toBe(expected);
  });

  it('writes a figure as an asset link and finds its asset', () => {
    const id = '0b9a8f0e-6b8c-4f9e-8a53-5a6d6c1b9a11';
    const d = deriveFromDoc(validated(doc({ type: 'figure', attrs: { assetId: id, caption: 'Tencent [1D] 16:05' } })));
    expect(d.markdown).toBe(`![Tencent 1D 16:05](asset:${id})`);
    expect(d.assetIds).toEqual([id]);
    expect(d.plain).toBe('Tencent [1D] 16:05');
  });

  it('keeps a table row on one line of search text and does not count a snapshot as words', () => {
    const d = deriveFromDoc(validated(KITCHEN_SINK));
    expect(d.plain).toContain('NKE 65 | 62.5');
    expect(d.plain).toContain('Open positions Name Put P&L NKE 65 +$210 KO 60 +$95');
    const withoutSnapshot = {
      ...KITCHEN_SINK,
      content: (KITCHEN_SINK.content ?? []).filter((n) => n.type !== 'snapshot'),
    };
    expect(d.wordCount).toBe(deriveFromDoc(validated(withoutSnapshot as JournalDocJson)).wordCount);
  });

  it('counts English words and Chinese characters', () => {
    expect(countWords('Evening review: HSI -1.2% at the open')).toBe(7);
    expect(countWords('港股再度低开，恒指开盘跌')).toBeGreaterThanOrEqual(6);
    expect(countWords('')).toBe(0);
  });

  it('finds stock mentions from marks and from bare $SYMBOL text, canonical, without duplicates', () => {
    const d = deriveFromDoc(
      validated(
        doc(
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'Tencent',
                marks: [{ type: 'stockMention', attrs: { market: 'HK', symbol: '00700' } }],
              },
              { type: 'text', text: ' vs $NKE and $0700.HK, $KO. Also $100 of cash, US$5, x$AB and $nke.' },
            ],
          },
          para('again $NKE'),
        ),
      ),
    );
    expect(d.mentions).toEqual([
      { market: 'HK', symbol: '0700' },
      { market: 'US', symbol: 'NKE' },
      { market: 'US', symbol: 'KO' },
    ]);
    expect(d.mentions.map(mentionLabel)).toEqual(['0700.HK', 'NKE', 'KO']);
  });

  it('parses what a person types into a name', () => {
    expect(parseMention('$nke')).toEqual({ market: 'US', symbol: 'NKE' });
    expect(parseMention('700.HK')).toEqual({ market: 'HK', symbol: '0700' });
    expect(parseMention('BRK.B')).toEqual({ market: 'US', symbol: 'BRK.B' });
    expect(parseMention('hello world')).toBeNull();
    expect(parseMention('12345')).toBeNull();
    expect(mentionsOfMarkdown('a $NKE b $0700.HK c')).toEqual([
      { market: 'US', symbol: 'NKE' },
      { market: 'HK', symbol: '0700' },
    ]);
  });
});

describe('list helpers', () => {
  it('builds an excerpt from prose only', () => {
    const md = '## Market\n\n| a | b |\n| - | - |\n\nHK open weak, **HSI** down. \\* odd\n\n- second point';
    expect(excerptOf(md)).toBe('HK open weak, HSI down. * odd second point');
    expect(excerptOf('x'.repeat(300), 20)).toHaveLength(20);
    expect(excerptOf('## only a heading')).toBe('');
  });

  it('extracts "Lesson:" paragraphs, also inside a callout, with their stock names', () => {
    const md =
      '> Lesson: roll at **strike + 5%** on $NKE, not "feels heavy".\n\nLesson: never sell into a WARN\n\nnot a lesson: x';
    expect(extractLessons(md)).toEqual(['roll at strike + 5% on $NKE, not "feels heavy".', 'never sell into a WARN']);
    expect(lessonsOf(md)).toEqual([
      {
        text: 'roll at strike + 5% on NKE, not "feels heavy".',
        mentions: [{ market: 'US', symbol: 'NKE' }],
        source: 'entry',
      },
      { text: 'never sell into a WARN', mentions: [], source: 'entry' },
    ]);
  });
});

describe('title, tags and templates', () => {
  it('normalises tags', () => {
    expect(normaliseTag('#Roll-Rule')).toBe('roll-rule');
    expect(normaliseTag('hk')).toBe('hk');
    expect(normaliseTag('two words')).toBeNull();
    expect(normaliseTag('')).toBeNull();
    expect(normaliseTag('x'.repeat(41))).toBeNull();
    expect(normaliseTags(['#a', 'A', 'b'])).toEqual(['a', 'b']);
    expect(normaliseTags(['ok', 'not ok'])).toBeNull();
    expect(normaliseTags(Array.from({ length: 21 }, (_, i) => `t${i}`))).toBeNull();
    expect(parseTagInput('#roll-rule  #hk, breach nonsense! #hk')).toEqual(['roll-rule', 'hk', 'breach']);
  });

  it('trims a title and turns an empty one into null', () => {
    expect(cleanTitle('  Evening review ')).toBe('Evening review');
    expect(cleanTitle('   ')).toBeNull();
    expect(cleanTitle(null)).toBeNull();
  });

  it('fills an empty entry with a template and appends to an entry that has text', () => {
    const evening = JOURNAL_TEMPLATES.find((t) => t.id === 'evening');
    if (!evening) throw new Error('no evening template');
    expect(isEmptyDoc(EMPTY_DOC as unknown as JournalDocJson)).toBe(true);
    expect(applyTemplate(EMPTY_DOC as unknown as JournalDocJson, 'evening')).toEqual(evening.doc);
    const written = doc(para('my notes'));
    const merged = applyTemplate(written, 'evening');
    expect(merged.content?.[0]).toEqual(para('my notes'));
    expect(merged.content).toHaveLength(1 + (evening.doc.content?.length ?? 0));
    expect(validateJournalDoc(merged).ok).toBe(true);
  });
});

describe('lessons of both kinds, and the line that names a stock', () => {
  const md = [
    '## Market',
    '',
    'Rolled $NKE early. $0700.HK held 600.',
    '',
    '> Lesson: roll at **strike + 5%**',
    '',
    '## Lessons & actions (AI draft)',
    '',
    '- Rules beat feelings on $NKE',
    '- [ ] Set an alert at 68',
    '- Premium has a floor',
    '',
    '## Tomorrow',
    '',
    '- not a lesson',
  ].join('\n');

  it('takes "Lesson:" paragraphs and the bullets of the AI section in order, and leaves out its to-dos', () => {
    expect(lessonsOf(md).map((l) => `${l.source}: ${l.text}`)).toEqual([
      'entry: roll at strike + 5%',
      'ai: Rules beat feelings on NKE',
      'ai: Premium has a floor',
    ]);
    expect(lessonsOf(md)[1]?.mentions).toEqual([{ market: 'US', symbol: 'NKE' }]);
  });

  it('finds the first prose line that names the stock, without Markdown, and never inside a table or heading', () => {
    expect(snippetFor(md, 'NKE')).toBe('Rolled NKE early. 0700.HK held 600.');
    expect(snippetFor(md, '0700.HK')).toBe('Rolled NKE early. 0700.HK held 600.');
    expect(snippetFor('| $NKE | 65 |\n\n## $NKE plan\n\n- [ ] call $NKE', 'NKE')).toBe('call NKE');
    expect(snippetFor(md, 'KO')).toBe('');
    expect(snippetFor(`${'word '.repeat(80)}$NKE`, 'NKE', 40)).toHaveLength(40);
  });
});

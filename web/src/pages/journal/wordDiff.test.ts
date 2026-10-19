import { describe, expect, it } from 'vitest';
import { changesView, DIFF_WORD_LIMIT, lockedNote, plainMarkdown, withoutPlaceholders, wordDiff } from './wordDiff';

const text = (parts: { kind: string; text: string }[], kind: string) =>
  parts
    .filter((p) => p.kind === kind)
    .map((p) => p.text.trim())
    .join('|');

describe('wordDiff', () => {
  it('is all "same" for identical text', () => {
    expect(wordDiff('keep every word', 'keep every word')).toEqual([{ kind: 'same', text: 'keep every word' }]);
  });

  it('marks added words', () => {
    const parts = wordDiff('the put is fine', 'the put is fine but small');
    expect(parts.map((p) => p.kind)).toEqual(['same', 'ins']);
    expect(text(parts, 'ins')).toBe('but small');
    expect(text(parts, 'del')).toBe('');
  });

  it('marks removed words', () => {
    const parts = wordDiff('I really think the put is fine', 'the put is fine');
    expect(text(parts, 'del')).toBe('I really think');
    expect(text(parts, 'ins')).toBe('');
  });

  it('shows a replaced stretch as the removed words, then the added ones', () => {
    const parts = wordDiff('didnt sell the Nov put', 'did not sell the Nov put');
    expect(parts.map((p) => p.kind)).toEqual(['del', 'ins', 'same']);
    expect(text(parts, 'del')).toBe('didnt');
    expect(text(parts, 'ins')).toBe('did not');
  });

  it('keeps the spacing and line breaks of the side each word is on, so the text can be read back', () => {
    const before = 'Market\n\nHK open weak.\nNo sale.';
    const after = 'Market\n\nHK opened weak.\nNo sale.';
    const parts = wordDiff(before, after);
    const kept = parts
      .filter((p) => p.kind !== 'del')
      .map((p) => p.text)
      .join('');
    expect(kept).toBe(after);
    const original = parts
      .filter((p) => p.kind !== 'ins')
      .map((p) => p.text)
      .join('');
    expect(original.replace(/\s+/g, ' ').trim()).toBe(before.replace(/\s+/g, ' ').trim());
  });

  it('merges neighbours of the same kind and ignores differences in spacing only', () => {
    expect(wordDiff('a b c', 'a\nb  c')).toEqual([{ kind: 'same', text: 'a\nb  c' }]);
  });

  it('handles an empty side', () => {
    expect(wordDiff('', 'new text')).toEqual([{ kind: 'ins', text: 'new text' }]);
    expect(wordDiff('old text', '')).toEqual([{ kind: 'del', text: 'old text' }]);
    expect(wordDiff('', '')).toEqual([]);
  });

  it('finds the longest common run, not just the first match', () => {
    const parts = wordDiff('one two three four five', 'two four six');
    expect(text(parts, 'same')).toBe('two|four');
    expect(text(parts, 'ins')).toBe('six');
    // everything that was removed is exactly the words not in "two four"
    expect(parts.filter((p) => p.kind === 'del').flatMap((p) => p.text.trim().split(/\s+/))).toEqual([
      'one',
      'three',
      'five',
    ]);
  });

  it('copes with a long entry that is mostly unchanged', () => {
    const base = Array.from({ length: 2000 }, (_, i) => `w${i}`);
    const edited = [...base.slice(0, 1000), 'INSERTED', ...base.slice(1000)];
    const parts = wordDiff(base.join(' '), edited.join(' '));
    expect(text(parts, 'ins')).toBe('INSERTED');
    expect(text(parts, 'del')).toBe('');
  });
});

describe('withoutPlaceholders and lockedNote', () => {
  it('takes the placeholder lines out and says which kinds of locked block there were, in a fixed order', () => {
    const md = 'Market\n\n[[TODO:1]]\n\nText\n\n[[FIG:1]]\n\n[[SNAP:1]]\n\n[[FIG:2]]\n';
    const out = withoutPlaceholders(md);
    expect(out.text).toBe('Market\n\nText');
    expect(out.kinds).toEqual(['FIG', 'SNAP', 'TODO']);
  });

  it("leaves a placeholder that sits inside a sentence (it is the model's text, not a locked line)", () => {
    expect(withoutPlaceholders('see [[FIG:1]] above').text).toBe('see [[FIG:1]] above');
  });

  it('writes the note', () => {
    expect(lockedNote(['FIG', 'SNAP', 'TODO'])).toBe('Image, snapshot and checklist: kept as written (locked).');
    expect(lockedNote(['FIG'])).toBe('Image: kept as written (locked).');
    expect(lockedNote(['FIG', 'TBL'])).toBe('Image and table: kept as written (locked).');
    expect(lockedNote([])).toBeNull();
  });
});

describe('plainMarkdown', () => {
  it('drops heading hashes, emphasis marks and escapes, and writes names as typed', () => {
    expect(plainMarkdown('## Market\n\n**Rules** beat *feelings* and ~~noise~~')).toBe(
      'Market\n\nRules beat feelings and noise',
    );
    expect(plainMarkdown('sold $NKE and $0700.HK for $5')).toBe('sold NKE and 0700.HK for $5');
    expect(plainMarkdown('a \\* star and \\[brackets\\]')).toBe('a * star and [brackets]');
  });

  it('keeps list markers and numbers', () => {
    expect(plainMarkdown('- one\n- two 3 * 4')).toBe('- one\n- two 3 * 4');
  });
});

describe('changesView shows words, not markdown marks', () => {
  it('has no heading hashes or dollar signs in the diff text', () => {
    const view = changesView('## Market\n\nsold $NKE', '## Market\n\nSold $NKE today');
    if (view.kind !== 'diff') throw new Error('expected a diff');
    expect(view.parts.map((p) => p.text).join('')).not.toMatch(/[#$]/);
  });
});

describe('changesView', () => {
  it('diffs the prose only: the locked lines are not in the diff and the note names them', () => {
    const input = 'Market\n\nHK open weak.\n\n[[FIG:1]]\n\nTomorrow\n\n[[TODO:1]]';
    const output = 'Market\n\nHong Kong opened weak.\n\n[[FIG:1]]\n\nTomorrow\n\n[[TODO:1]]';
    const view = changesView(input, output);
    expect(view.kind).toBe('diff');
    if (view.kind !== 'diff') return;
    expect(view.changed).toBe(true);
    expect(view.note).toBe('Image and checklist: kept as written (locked).');
    const all = view.parts.map((p) => p.text).join('');
    expect(all).not.toContain('[[');
    expect(text(view.parts, 'ins')).toBe('Hong Kong opened');
    expect(text(view.parts, 'del')).toBe('HK open');
  });

  it('says nothing changed for identical text, and has no note without locked blocks', () => {
    const view = changesView('Same words', 'Same words');
    expect(view).toMatchObject({ kind: 'diff', changed: false, note: null });
  });

  it('shows an appended section as added words only (Lessons & actions)', () => {
    const view = changesView('My notes', 'My notes\n\n## Lessons & actions (AI draft)\n\n- Rules beat feelings.');
    if (view.kind !== 'diff') throw new Error('expected a diff');
    expect(view.parts[0]).toMatchObject({ kind: 'same' });
    expect(view.parts.filter((p) => p.kind === 'del')).toEqual([]);
    expect(text(view.parts, 'ins')).toContain('Rules beat feelings.');
  });

  it('falls back to before and after, whole, when an entry is too long to diff', () => {
    const long = Array.from({ length: DIFF_WORD_LIMIT + 1 }, (_, i) => `w${i}`).join(' ');
    const view = changesView(long, `${long} extra`);
    expect(view.kind).toBe('whole');
    if (view.kind !== 'whole') return;
    expect(view.before).toBe(long);
    expect(view.after).toBe(`${long} extra`);
  });

  it('still diffs an entry right at the limit', () => {
    const edge = Array.from({ length: DIFF_WORD_LIMIT }, (_, i) => `w${i}`).join(' ');
    expect(changesView(edge, edge).kind).toBe('diff');
  });
});

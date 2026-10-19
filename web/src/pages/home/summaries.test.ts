import { describe, expect, it } from 'vitest';
import type { Resource } from '../../hooks/useResource';
import { leadersSummary } from './LeadersPanel';
import { newsSummary } from './NewsPanel';
import { putsSummary } from './PutsPanel';
import { remindersSummary } from './RemindersPanel';
import { researchSummary } from './ResearchPanel';

/** A loaded (or not yet loaded) resource; the summaries read only `data`. */
const res = <T>(data: unknown): Resource<T> =>
  ({ data, error: null, loading: data === undefined, refreshing: false, refresh: () => {} }) as Resource<T>;

const DAY = 86_400_000;
const ago = (days: number): string => new Date(Date.now() - days * DAY).toISOString();

describe('putsSummary', () => {
  it('is empty until the scan arrives', () => {
    expect(putsSummary(res(undefined))).toEqual({ count: null, kind: 'quiet', tile: null });
  });
  it('counts the ideas', () => {
    expect(putsSummary(res({ ideas: [{}, {}, {}] }))).toEqual({
      count: '3',
      kind: 'ok',
      tile: { value: '3', label: 'Puts' },
    });
  });
  it('goes quiet at zero but still shows the figure', () => {
    const s = putsSummary(res({ ideas: [] }));
    expect(s.kind).toBe('quiet');
    expect(s.tile).toEqual({ value: '0', label: 'Puts' });
  });
});

describe('leadersSummary', () => {
  it('pluralises the setups and warns when the posture is watch-only', () => {
    expect(leadersSummary(res({ funnel: { setup: 1 }, regime: null })).count).toBe('1 setup');
    const s = leadersSummary(res({ funnel: { setup: 7 }, regime: { posture: 'watch_only' } }));
    expect(s.count).toBe('7 setups');
    expect(s.kind).toBe('warn');
    expect(s.tile).toEqual({ value: '7', label: 'Setups' });
  });
});

describe('newsSummary', () => {
  const story = (impact: string, id: string) => ({ id, impact, publishedAt: '2026-10-19T00:00:00Z' });
  it('leads with the blocking stories when there are any', () => {
    const s = newsSummary(
      res({ groups: [{ symbol: 'A', items: [story('blocks', '1'), story('supports', '2'), story('caution', '3')] }] }),
    );
    expect(s.count).toBe('1 blocking');
    expect(s.kind).toBe('fail');
    expect(s.tile).toEqual({ value: '1', label: 'Blocking' });
  });
  it('counts only classified stories otherwise', () => {
    const s = newsSummary(
      res({ groups: [{ symbol: 'A', items: [story('supports', '1'), { id: '2', impact: null }] }] }),
    );
    expect(s.tile).toEqual({ value: '1', label: 'News' });
    expect(s.kind).toBe('ok');
  });
});

describe('researchSummary', () => {
  const run = (status: string, finishedDaysAgo: number | null) => ({
    status,
    finishedAt: finishedDaysAgo === null ? null : ago(finishedDaysAgo),
  });
  it('shows what is running before what finished', () => {
    const s = researchSummary(res([run('running', null), run('done', 1)]));
    expect(s.count).toBe('1 running');
    expect(s.tile).toEqual({ value: '1', label: 'Running' });
  });
  it('counts this week’s finished reports and ignores older and cancelled ones', () => {
    const s = researchSummary(res([run('done', 1), run('done', 3), run('done', 20), run('cancelled', 1)]));
    expect(s.count).toBe('2 this week');
    expect(s.tile).toEqual({ value: '2', label: 'Reports' });
  });
});

describe('remindersSummary', () => {
  it('waits for the first load', () => {
    expect(remindersSummary({ items: [], due: 0, loading: true }).tile).toBeNull();
  });
  it('leads with what is due today', () => {
    const s = remindersSummary({ items: [1, 2, 3, 4], due: 2, loading: false });
    expect(s.count).toBe('2 today');
    expect(s.kind).toBe('warn');
    expect(s.tile).toEqual({ value: '2', label: 'Due today' });
  });
  it('falls back to what is coming up', () => {
    const s = remindersSummary({ items: [1, 2], due: 0, loading: false });
    expect(s.tile).toEqual({ value: '2', label: 'Coming up' });
    expect(s.kind).toBe('ok');
  });
});

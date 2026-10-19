import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ReasonView } from '../api/types';
import { groupReasons, ReasonsTable } from './ReasonsTable';

const reason = (over: Partial<ReasonView>): ReasonView => ({
  rule: 'quality.fcfYield',
  value: 4.6,
  threshold: '>= 4%',
  level: 'PASS',
  kind: 'rule',
  note: null,
  group: 'Quality gate',
  skillId: 'fundamental.gate',
  ...over,
});

const reasons: ReasonView[] = [
  reason({ rule: 'option.delta', group: 'Option', value: 0.19, threshold: '0.15-0.30' }),
  reason({ rule: 'quality.fcfYield' }),
  reason({
    rule: 'regime.noVolIndex',
    group: 'Market',
    level: 'WARN',
    kind: 'data',
    value: true,
    threshold: null,
    note: 'no VHSI history',
  }),
  reason({
    rule: 'events.earningsWindow',
    group: 'Events',
    level: 'FAIL',
    value: '2026-11-02',
    note: 'results fall inside the window',
  }),
  reason({ rule: 'iv.vrp', group: 'Volatility', level: 'INFO', value: null, threshold: null }),
];

describe('ReasonsTable', () => {
  it('groups rules in the canonical order', () => {
    expect(groupReasons(reasons).map((g) => g.group)).toEqual([
      'Market',
      'Quality gate',
      'Events',
      'Volatility',
      'Option',
    ]);
  });

  it('shows OK, WARN, FAIL and INFO level chips', () => {
    render(<ReasonsTable reasons={reasons} />);
    for (const label of ['OK', 'WARN', 'FAIL', 'INFO']) expect(screen.getAllByText(label).length).toBeGreaterThan(0);
  });

  it('marks data-quality rows as data and shows threshold and note', () => {
    render(<ReasonsTable reasons={reasons} />);
    const row = screen.getByText('regime.noVolIndex').closest('.rrow') as HTMLElement;
    expect(within(row).getByText('data')).toBeInTheDocument();
    expect(within(row).getByText('no VHSI history')).toBeInTheDocument();
    expect(row).toHaveClass('warn');
    const quality = screen.getByText('quality.fcfYield').closest('.rrow') as HTMLElement;
    expect(within(quality).getByText('want >= 4%')).toBeInTheDocument();
    expect(within(quality).getByText('4.6')).toBeInTheDocument();
  });

  it('opens a plain-English explanation from the rule name and closes it again', async () => {
    const user = userEvent.setup();
    render(<ReasonsTable reasons={reasons} />);
    const button = screen.getByRole('button', { name: /quality\.fcfYield/ });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Why it matters')).not.toBeInTheDocument();
    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    const row = button.closest('.rrow') as HTMLElement;
    expect(within(row).getByText('What it is')).toBeInTheDocument();
    expect(within(row).getByText('Why it matters')).toBeInTheDocument();
    expect(within(row).getByText('How to read it')).toBeInTheDocument();
    expect(within(row).getByText(/Free cash flow/)).toBeInTheDocument();
    await user.click(button);
    expect(within(row).queryByText('Why it matters')).not.toBeInTheDocument();
  });

  it('shows a rule that has no explanation as plain text, not a button', () => {
    render(<ReasonsTable reasons={[reason({ rule: 'iv.vrp', group: 'Volatility' })]} />);
    expect(screen.getByText('iv.vrp')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /iv\.vrp/ })).not.toBeInTheDocument();
  });

  it('says so when nothing was evaluated', () => {
    render(<ReasonsTable reasons={[]} />);
    expect(screen.getByText('No rules were evaluated.')).toBeInTheDocument();
  });
});

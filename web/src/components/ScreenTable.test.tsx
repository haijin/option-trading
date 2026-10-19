import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ScreenView } from '../api/types';
import { ScreenTable } from './ScreenTable';

const screenView: ScreenView = {
  verdict: 'EXEMPT-PASS',
  borderline: 1,
  windowYears: 4,
  rows: [
    {
      n: 1,
      label: '10-year average ROE',
      valueText: '12.0%',
      rule: '>= 8%',
      status: 'pass',
      note: 'data window 4y of 10y',
    },
    { n: 2, label: 'Interest cover', valueText: 'n/a', rule: '>= 2x', status: 'na', note: 'banks are exempt' },
    { n: 3, label: 'Gross margin', valueText: '15.4%', rule: '>= 15%', status: 'warn', note: '' },
    {
      n: 4,
      label: 'Net margin',
      valueText: '2.0%',
      rule: '>= 5%',
      status: 'exempt',
      note: 'Exemption B: gross margin over 30%',
    },
    { n: 5, label: 'Share count change', valueText: '+40%', rule: '<= +20%', status: 'fail', note: '' },
  ],
};

describe('ScreenTable', () => {
  it('shows the verdict, every filter and a result chip per status', () => {
    render(<ScreenTable screen={screenView} />);
    expect(screen.getByText('EXEMPT-PASS')).toBeInTheDocument();
    expect(screen.getByText('1 borderline')).toBeInTheDocument();
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(5);
    const chipText = (row: HTMLElement) => within(row).getAllByText(/^(PASS|BORDER|FAIL|EXEMPT|N\/A)$/)[0]?.textContent;
    expect(rows.map(chipText)).toEqual(['PASS', 'N/A', 'BORDER', 'EXEMPT', 'FAIL']);
    expect(screen.getByText('Exemption B: gross margin over 30%')).toBeInTheDocument();
    expect(screen.getByText('12.0%')).toBeInTheDocument();
  });

  it('colours chips by outcome', () => {
    render(<ScreenTable screen={screenView} />);
    expect(screen.getByText('PASS')).toHaveClass('ok');
    expect(screen.getByText('FAIL')).toHaveClass('fail');
    expect(screen.getByText('BORDER')).toHaveClass('warn');
    expect(screen.getByText('EXEMPT')).toHaveClass('blue');
  });

  it('says how many years of statements it used', () => {
    render(<ScreenTable screen={screenView} />);
    expect(screen.getByText(/Based on 4 years of annual statements/)).toBeInTheDocument();
  });

  it('renders an excluded verdict as a failure', () => {
    render(<ScreenTable screen={{ ...screenView, verdict: 'EXCLUDED', borderline: 0 }} />);
    expect(screen.getByText('EXCLUDED')).toHaveClass('fail');
    expect(screen.queryByText(/borderline/)).toBeNull();
  });
});

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { MethodView } from '../api/types';
import { RangeBar } from './RangeBar';

const methods: MethodView[] = [
  { id: 'scenario', label: 'Three-scenario, base case', value: 72.4, note: '' },
  { id: 'dcf', label: 'Owner-earnings DCF', value: 80.1, note: '' },
  { id: 'fair_value', label: 'Morningstar fair value', value: 70, note: '' },
];

const leftOf = (element: HTMLElement) => Number.parseFloat(element.style.left);

describe('RangeBar', () => {
  it('labels price, intrinsic value, strike and both ends of the range', () => {
    render(<RangeBar price={68.2} base={72.4} low={61.5} high={85.9} strike={64} methods={methods} />);
    expect(screen.getByText('Price 68.20')).toBeInTheDocument();
    expect(screen.getByText('Intrinsic 72.40')).toBeInTheDocument();
    expect(screen.getByText('Strike 64.00')).toBeInTheDocument();
    expect(screen.getByText('low 61.50')).toBeInTheDocument();
    expect(screen.getByText('high 85.90')).toBeInTheDocument();
  });

  it('omits the strike marker when no put is proposed', () => {
    render(<RangeBar price={68.2} base={72.4} low={61.5} high={85.9} methods={methods} />);
    expect(screen.queryByText(/^Strike/)).toBeNull();
  });

  it('draws the shaded band between low and high and one dot per method', () => {
    const { container } = render(<RangeBar price={68.2} base={72.4} low={61.5} high={85.9} methods={methods} />);
    const band = container.querySelector('.band') as HTMLElement;
    expect(band).toHaveAttribute('title', 'range 61.50 to 85.90');
    expect(Number.parseFloat(band.style.width)).toBeGreaterThan(0);
    expect(container.querySelectorAll('.rbd')).toHaveLength(3);
    expect(screen.getByText('Owner-earnings DCF 80.10')).toBeInTheDocument();
  });

  it('keeps markers in left-to-right order of their values and inside the track', () => {
    render(<RangeBar price={68.2} base={72.4} low={61.5} high={85.9} strike={64} methods={methods} />);
    const strike = leftOf(screen.getByText('Strike 64.00'));
    const price = leftOf(screen.getByText('Price 68.20'));
    const intrinsic = leftOf(screen.getByText('Intrinsic 72.40'));
    expect(strike).toBeLessThan(price);
    expect(price).toBeLessThan(intrinsic);
    for (const x of [strike, price, intrinsic]) {
      expect(x).toBeGreaterThanOrEqual(6);
      expect(x).toBeLessThanOrEqual(94);
    }
  });

  it('puts crowded labels on different rows so they do not overlap', () => {
    render(<RangeBar price={72.0} base={72.4} low={61.5} high={85.9} strike={72.2} methods={methods} />);
    const tops = ['Price 72.00', 'Intrinsic 72.40', 'Strike 72.20'].map(
      (text) => (screen.getByText(text) as HTMLElement).style.top,
    );
    expect(new Set(tops).size).toBe(3);
  });

  it('has an accessible summary', () => {
    render(<RangeBar price={68.2} base={72.4} low={61.5} high={85.9} methods={methods} />);
    expect(screen.getByRole('img', { name: /Price 68.20 against intrinsic value 72.40/ })).toBeInTheDocument();
  });
});

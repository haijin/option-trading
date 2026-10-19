import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LeadersTodayCard } from './LeadersTodayCard';

const card = { asOf: '2026-10-13', setups: 7, newToday: 3, shortlisted: 20, posture: 'entries' as const };

describe('LeadersTodayCard', () => {
  it('links to the Leaders page with the setups and new names', () => {
    render(<LeadersTodayCard card={card} />);
    const link = screen.getByRole('link', { name: /Leaders/ });
    expect(link).toHaveAttribute('href', '#/leaders');
    expect(link).toHaveTextContent('Leaders7 setups · 3 new');
  });

  it('says one setup, not 1 setups', () => {
    render(<LeadersTodayCard card={{ ...card, setups: 1 }} />);
    expect(screen.getByRole('link')).toHaveTextContent('1 setup · 3 new');
  });

  it('says watch only in a panic regime', () => {
    render(<LeadersTodayCard card={{ ...card, setups: 0, posture: 'watch_only' }} />);
    expect(screen.getByRole('link')).toHaveTextContent('watch only · 3 new');
    expect(screen.getByRole('link')).toHaveClass('off');
  });

  it('is hidden until a scan has run', () => {
    const { container, rerender } = render(<LeadersTodayCard card={null} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<LeadersTodayCard card={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});

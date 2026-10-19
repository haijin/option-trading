import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Sheet } from './Sheet';

function Host({ dismissible = true, onClose }: { dismissible?: boolean; onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      {open ? (
        <Sheet
          title="History"
          dismissible={dismissible}
          onClose={() => {
            onClose?.();
            setOpen(false);
          }}
          footer={
            <button type="button" className="btn">
              Footer button
            </button>
          }
        >
          <button type="button">First</button>
          <button type="button">Second</button>
        </Sheet>
      ) : null}
    </>
  );
}

const open = () => fireEvent.click(screen.getByRole('button', { name: 'Open' }));

describe('Sheet', () => {
  it('is a labelled modal dialog with a body that scrolls on its own and a footer that stays', () => {
    render(<Host />);
    open();
    const dialog = screen.getByRole('dialog', { name: 'History' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog.querySelector('.jr-sb')).not.toBeNull();
    expect(dialog.querySelector('.jr-sf')).toContainElement(screen.getByRole('button', { name: 'Footer button' }));
    expect(dialog.querySelector('.jr-grab')).not.toBeNull();
  });

  it('moves focus into the sheet, keeps Tab inside it, and gives focus back when it closes', () => {
    render(<Host />);
    const trigger = screen.getByRole('button', { name: 'Open' });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus();
    const last = screen.getByRole('button', { name: 'Footer button' });
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('closes with Escape, with the close button and with a click on the scrim', () => {
    const onClose = vi.fn();
    render(<Host onClose={onClose} />);
    open();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(2);
    open();
    fireEvent.click(screen.getByTestId('jr-scrim'));
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not close on a click inside the sheet', () => {
    const onClose = vi.fn();
    render(<Host onClose={onClose} />);
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Second' }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('cannot be dismissed when it is a choice that has to be made', () => {
    const onClose = vi.fn();
    render(<Host dismissible={false} onClose={onClose} />);
    open();
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByTestId('jr-scrim'));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Modal } from './Modal';

function Harness({ onClose = () => undefined }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        open it
      </button>
      {open ? (
        <Modal
          title="Log a fill"
          onClose={() => {
            onClose();
            setOpen(false);
          }}
          footer={
            <button type="button" id="last">
              Save
            </button>
          }
        >
          <label>
            Symbol
            <input />
          </label>
        </Modal>
      ) : null}
    </div>
  );
}

describe('Modal', () => {
  it('is a labelled dialog and focuses the first form control', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByText('open it'));
    const dialog = screen.getByRole('dialog', { name: 'Log a fill' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByLabelText('Symbol')).toHaveFocus();
  });

  it('closes on Escape and returns focus to the opener', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const opener = screen.getByText('open it');
    await user.click(opener);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
  });

  it('traps Tab inside the dialog in both directions', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByText('open it'));
    const close = screen.getByRole('button', { name: 'Close' });
    const save = screen.getByText('Save');
    expect(screen.getByLabelText('Symbol')).toHaveFocus();
    await user.tab();
    expect(save).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(save).toHaveFocus();
    // The opener behind the backdrop is never reached.
    for (let i = 0; i < 6; i++) await user.tab();
    expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement);
  });

  it('closes when the backdrop is pressed but not when the dialog is', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    await user.click(screen.getByText('open it'));
    fireEvent.mouseDown(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
    const overlay = screen.getByRole('dialog').parentElement as HTMLElement;
    fireEvent.mouseDown(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

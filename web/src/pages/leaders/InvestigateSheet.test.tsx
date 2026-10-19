import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillCatalogView } from '../../api/types';
import { DataVersionProvider } from '../../state/dataVersion';
import { RouterProvider } from '../../state/router';
import { ToastProvider } from '../../state/toast';
import { InvestigateSheet, leaderPresets } from './InvestigateSheet';
import { candidate, catalog, watchCandidate } from './testFixtures';

const api = { skills: vi.fn(), startResearch: vi.fn() };
vi.mock('../../api/endpoints', () => ({
  api: {
    skills: (...a: unknown[]) => api.skills(...a),
    startResearch: (...a: unknown[]) => api.startResearch(...a),
  },
}));

function renderSheet(c = candidate(), onClose = vi.fn()) {
  render(
    <ToastProvider>
      <DataVersionProvider>
        <RouterProvider>
          <InvestigateSheet c={c} onClose={onClose} />
        </RouterProvider>
      </DataVersionProvider>
    </ToastProvider>,
  );
  return onClose;
}

/** The sheet opens on a skeleton and swaps to the real thing when the catalogue arrives. */
const loaded = () => screen.findByRole('button', { name: /^Run \d+ skills?$/ });
const run = () => screen.getByRole('button', { name: /^Run \d+ skills?$/ });
const checked = () =>
  within(screen.getByRole('dialog'))
    .getAllByRole('checkbox')
    .filter((box) => (box as HTMLInputElement).checked)
    .map((box) => box.closest('label')?.querySelector('.t')?.firstChild?.textContent);

beforeEach(() => {
  api.skills.mockReset();
  api.startResearch.mockReset();
  window.location.hash = '';
  api.skills.mockResolvedValue(catalog());
});

describe('leaderPresets', () => {
  it('offers Leader check, Just the numbers and Full deep dive, in that order, and hides the put seller preset', () => {
    expect(leaderPresets(catalog()).map((p) => p.id)).toEqual(['leader', 'numbers', 'full']);
    const noLeader: SkillCatalogView = catalog({ presets: catalog().presets.filter((p) => p.id !== 'leader') });
    expect(leaderPresets(noLeader).map((p) => p.id)).toEqual(['numbers', 'full']);
  });
});

describe('InvestigateSheet', () => {
  it('is titled with the name, offers the three presets and starts on Leader check with its three skills ticked', async () => {
    renderSheet();
    await loaded();
    const dialog = screen.getByRole('dialog', { name: 'Investigate VRT · Vertiv Holdings' });
    const presets = within(dialog);
    expect(presets.getByRole('button', { name: 'Leader check' })).toHaveAttribute('aria-pressed', 'true');
    expect(presets.getByRole('button', { name: 'Just the numbers' })).toHaveAttribute('aria-pressed', 'false');
    expect(presets.getByRole('button', { name: 'Full deep dive' })).toHaveAttribute('aria-pressed', 'false');
    expect(presets.queryByRole('button', { name: /Would I accept assignment/ })).toBeNull();
    expect(checked()).toEqual(['Quality screen', 'News pulse', 'Thesis tracker']);
    expect(run()).toHaveTextContent('Run 3 skills');
  });

  it('lists every skill with its Chinese and English name, its effort and what it does', async () => {
    renderSheet();
    await loaded();
    const rows = screen.getAllByRole('checkbox');
    expect(rows).toHaveLength(4);
    const quality = within(screen.getByText('Quality screen').closest('label') as HTMLElement);
    expect(quality.getByText('去劣筛选')).toBeInTheDocument();
    expect(quality.getByText('local, instant')).toBeInTheDocument();
    expect(quality.getByText('Seven hard filters on stored statements.')).toBeInTheDocument();
    expect(
      within(screen.getByText('Four-masters research').closest('label') as HTMLElement).getByText('Heavy AI run'),
    ).toBeInTheDocument();
  });

  it('switches the ticked skills with the presets and counts them on the run button', async () => {
    const user = userEvent.setup();
    renderSheet();
    await loaded();
    await user.click(screen.getByRole('button', { name: 'Just the numbers' }));
    expect(checked()).toEqual(['Quality screen']);
    expect(run()).toHaveTextContent('Run 1 skill');
    await user.click(screen.getByRole('button', { name: 'Full deep dive' }));
    expect(checked()).toEqual(['Quality screen', 'Thesis tracker', 'Four-masters research']);
    expect(run()).toHaveTextContent('Run 3 skills');
  });

  it('lets a skill be ticked or unticked by hand, which leaves no preset selected, and cannot run none', async () => {
    const user = userEvent.setup();
    renderSheet();
    await loaded();
    await user.click(screen.getByRole('checkbox', { name: /News pulse/ }));
    expect(checked()).toEqual(['Quality screen', 'Thesis tracker']);
    expect(screen.getByRole('button', { name: 'Leader check' })).toHaveAttribute('aria-pressed', 'false');
    expect(run()).toHaveTextContent('Run 2 skills');
    await user.click(screen.getByRole('checkbox', { name: /Quality screen/ }));
    await user.click(screen.getByRole('checkbox', { name: /Thesis tracker/ }));
    expect(run()).toHaveTextContent('Run 0 skills');
    expect(run()).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Leader check' }));
    expect(run()).toHaveTextContent('Run 3 skills');
  });

  it('says statements are fetched first when none are stored, and says nothing when they are', async () => {
    renderSheet(watchCandidate());
    expect(
      await screen.findByText(
        'No stored statements: they will be fetched first, about 30 s, so the quality screen can run.',
      ),
    ).toBeInTheDocument();
    expect(run()).toHaveTextContent('Run 3 skills');
  });

  it('has no fetch note for a name that has statements', async () => {
    renderSheet(candidate({ hasStatements: true }));
    await loaded();
    expect(screen.queryByText(/No stored statements/)).toBeNull();
  });

  it('queues the chosen skills for the name, closes, and toasts with a link to Research', async () => {
    const user = userEvent.setup();
    api.startResearch.mockResolvedValue([{ id: 'run-1' }, { id: 'run-2' }, { id: 'run-3' }]);
    const onClose = renderSheet();
    await loaded();
    await user.click(run());
    expect(api.startResearch).toHaveBeenCalledWith({
      symbol: 'VRT',
      market: 'US',
      skillIds: ['quality-screen', 'news-pulse', 'thesis-tracker'],
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Queued 3 runs for VRT')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open Research ›' }));
    expect(window.location.hash).toBe('#/research/US/VRT');
  });

  it('says one run when one was queued', async () => {
    const user = userEvent.setup();
    api.startResearch.mockResolvedValue([{ id: 'run-1' }]);
    renderSheet();
    await loaded();
    await user.click(screen.getByRole('button', { name: 'Just the numbers' }));
    await user.click(run());
    expect(await screen.findByText('Queued 1 run for VRT')).toBeInTheDocument();
  });

  it('stays open and shows the error when the server refuses', async () => {
    const user = userEvent.setup();
    api.startResearch.mockRejectedValue(new Error('investment-research is not available'));
    const onClose = renderSheet();
    await loaded();
    await user.click(run());
    expect(await screen.findByText('investment-research is not available')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('disables a skill the server says is unavailable, shows why, and leaves it out of the run', async () => {
    const user = userEvent.setup();
    const c = catalog();
    c.skills[3] = {
      ...c.skills[3],
      available: false,
      unavailableReason: 'Needs a second source',
    } as (typeof c.skills)[number];
    api.skills.mockResolvedValue(c);
    renderSheet();
    await loaded();
    const box = screen.getByRole('checkbox', { name: /Four-masters research/ });
    expect(box).toBeDisabled();
    expect(screen.getByText('Needs a second source')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Full deep dive' }));
    expect(checked()).toEqual(['Quality screen', 'Thesis tracker']);
    expect(run()).toHaveTextContent('Run 2 skills');
  });

  it('shows a retry when the research skills cannot be loaded', async () => {
    const user = userEvent.setup();
    api.skills.mockRejectedValueOnce(new Error('Cannot reach the server.'));
    renderSheet();
    expect(await screen.findByText('Cannot reach the server.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run 3 skills' })).toBeInTheDocument());
  });

  it('closes from Cancel', async () => {
    const user = userEvent.setup();
    const onClose = renderSheet();
    await loaded();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

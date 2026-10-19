import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import type { JournalAiAcceptView, JournalAiRunView, JournalEntryView } from '../../api/types';
import { type AiApi, AiRunController, POLL_CLOSED_MS, POLL_OPEN_MS } from './aiRun';

const DATE = '2026-10-13';

function run(patch: Partial<JournalAiRunView> = {}): JournalAiRunView {
  return {
    id: 'run-1',
    date: DATE,
    mode: 'polish',
    instruction: null,
    withContext: false,
    status: 'queued',
    accepted: null,
    progress: [],
    error: null,
    model: null,
    costUsd: null,
    durationMs: null,
    createdAt: '2026-10-13T08:00:00.000Z',
    finishedAt: null,
    result: null,
    ...patch,
  };
}

const done = (patch: Partial<JournalAiRunView> = {}): JournalAiRunView =>
  run({
    status: 'done',
    model: 'claude-haiku-5-5',
    costUsd: 0.03,
    durationMs: 9000,
    progress: ['prose: 41 words', 'writing…'],
    result: {
      doc: { type: 'doc', content: [{ type: 'paragraph' }] },
      inputMarkdown: 'a',
      outputMarkdown: 'b',
      lockedKept: 3,
      lockedTotal: 3,
    },
    ...patch,
  });

function fakeApi() {
  const api = {
    latest: vi.fn<AiApi['latest']>(async () => null),
    start: vi.fn<AiApi['start']>(async () => ({ runId: 'run-1' })),
    get: vi.fn<AiApi['get']>(async () => run({ status: 'running', progress: ['prose: 41 words'] })),
    cancel: vi.fn<AiApi['cancel']>(async () => run({ status: 'cancelled' })),
    accept: vi.fn<AiApi['accept']>(async () => ({ entry: { revisionNo: 9 } as JournalEntryView, undoRevisionNo: 5 })),
    reject: vi.fn<AiApi['reject']>(async () => done({ accepted: false })),
  };
  return api;
}

function setup(api = fakeApi(), over: { ensureSaved?: () => Promise<boolean> } = {}) {
  const onAccepted = vi.fn<(r: JournalAiAcceptView) => void>();
  const onCancelled = vi.fn();
  const ensureSaved = over.ensureSaved ?? vi.fn(async () => true);
  const controller = new AiRunController({ date: DATE, api, ensureSaved, onAccepted, onCancelled });
  const states: string[] = [];
  controller.subscribe(() => states.push(controller.getState().phase.kind));
  return { controller, api, onAccepted, onCancelled, ensureSaved, states };
}

const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
const phase = (c: AiRunController) => c.getState().phase.kind;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('starting a run', () => {
  it('saves first, starts with the choices, then goes queued -> running -> done', async () => {
    const { controller, api, ensureSaved, states } = setup();
    api.get
      .mockResolvedValueOnce(run({ status: 'running', progress: ['prose: 41 words'] }))
      .mockResolvedValueOnce(done());
    const started = controller.start({ mode: 'polish', withContext: false });
    expect(phase(controller)).toBe('starting');
    await started;
    expect(ensureSaved).toHaveBeenCalledTimes(1);
    expect(api.start).toHaveBeenCalledWith(DATE, { mode: 'polish', withContext: false });
    expect(phase(controller)).toBe('running');
    expect(controller.getState().phase).toMatchObject({ run: { id: 'run-1', status: 'queued', progress: [] } });
    await tick(0); // first poll right away
    expect(controller.getState().phase).toMatchObject({
      kind: 'running',
      run: { status: 'running', progress: ['prose: 41 words'] },
    });
    await tick(POLL_CLOSED_MS);
    expect(phase(controller)).toBe('result');
    expect(controller.getState().phase).toMatchObject({ run: { status: 'done', costUsd: 0.03 } });
    expect(states).toContain('starting');
    // a finished run is not polled any more
    api.get.mockClear();
    await tick(POLL_CLOSED_MS * 3);
    expect(api.get).not.toHaveBeenCalled();
  });

  it('does not start when the text could not be saved: the rewrite works from the saved copy', async () => {
    const { controller, api } = setup(undefined, { ensureSaved: async () => false });
    await controller.start({ mode: 'polish' });
    expect(api.start).not.toHaveBeenCalled();
    expect(phase(controller)).toBe('idle');
    expect(controller.getState().notice).toMatch(/not saved yet/);
  });

  it('ignores a second start while one is starting or running', async () => {
    const { controller, api } = setup();
    const first = controller.start({ mode: 'polish' });
    await controller.start({ mode: 'tighten' });
    await first;
    await controller.start({ mode: 'tighten' });
    expect(api.start).toHaveBeenCalledTimes(1);
  });

  it('shows the server message when a start is refused (daily limit, nothing to rewrite, instruction missing)', async () => {
    const { controller, api } = setup();
    api.start.mockRejectedValueOnce(new ApiError('daily_limit', "You have used today's 20 rewrites.", 429));
    await controller.start({ mode: 'polish' });
    expect(phase(controller)).toBe('idle');
    expect(controller.getState().notice).toBe("You have used today's 20 rewrites.");
    expect(controller.getState().unavailable).toBeNull();
    api.start.mockRejectedValueOnce(
      new ApiError('instruction_required', 'Tell the AI what to do in the box, or pick another mode.', 400),
    );
    await controller.start({ mode: 'custom' });
    expect(controller.getState().notice).toBe('Tell the AI what to do in the box, or pick another mode.');
  });

  it('remembers that the model cannot run here (503 ai_unavailable)', async () => {
    const { controller, api } = setup();
    api.start.mockRejectedValueOnce(
      new ApiError('ai_unavailable', 'The AI rewrite needs the claude CLI and it was not found.', 503),
    );
    await controller.start({ mode: 'polish' });
    expect(controller.getState().unavailable).toBe('The AI rewrite needs the claude CLI and it was not found.');
    expect(controller.getState().notice).toBe('The AI rewrite needs the claude CLI and it was not found.');
  });

  it('attaches to the run that is already going on a 409 run_in_progress', async () => {
    const { controller, api } = setup();
    api.start.mockRejectedValueOnce(
      new ApiError('run_in_progress', 'A rewrite is already running for this entry.', 409, { runId: 'run-77' }),
    );
    api.get.mockResolvedValue(run({ id: 'run-77', status: 'running', progress: ['writing…'] }));
    await controller.start({ mode: 'polish' });
    expect(api.get).toHaveBeenCalledWith('run-77');
    expect(controller.getState().phase).toMatchObject({ kind: 'running', run: { id: 'run-77' } });
    expect(controller.getState().notice).toMatch(/already running/);
    await tick(POLL_CLOSED_MS);
    expect(api.get).toHaveBeenLastCalledWith('run-77');
  });

  it('a run_in_progress that cannot be fetched shows the server message instead', async () => {
    const { controller, api } = setup();
    api.start.mockRejectedValueOnce(
      new ApiError('run_in_progress', 'A rewrite is already running for this entry.', 409, { runId: 'gone' }),
    );
    api.get.mockRejectedValueOnce(new ApiError('run_not_found', 'x', 404));
    await controller.start({ mode: 'polish' });
    expect(phase(controller)).toBe('idle');
    expect(controller.getState().notice).toBe('A rewrite is already running for this entry.');
  });
});

describe('how a run ends', () => {
  it('failed: shows the run with its error in words', async () => {
    const { controller, api } = setup();
    api.get.mockResolvedValue(
      run({ status: 'failed', error: 'The suggestion was refused and nothing was changed. A number changed.' }),
    );
    await controller.start({ mode: 'polish' });
    await tick(0);
    expect(controller.getState().phase).toMatchObject({
      kind: 'failed',
      run: { error: 'The suggestion was refused and nothing was changed. A number changed.' },
    });
  });

  it('cancelled elsewhere: back to Choose and the host says so', async () => {
    const { controller, api, onCancelled } = setup();
    api.get.mockResolvedValue(run({ status: 'cancelled' }));
    await controller.start({ mode: 'polish' });
    await tick(0);
    expect(phase(controller)).toBe('idle');
    expect(onCancelled).toHaveBeenCalledTimes(1);
  });

  it('the author cancels: the run is cancelled, back to Choose, announced once', async () => {
    const { controller, api, onCancelled } = setup();
    await controller.start({ mode: 'polish' });
    await controller.cancel();
    expect(api.cancel).toHaveBeenCalledWith('run-1');
    expect(phase(controller)).toBe('idle');
    expect(onCancelled).toHaveBeenCalledTimes(1);
    expect(controller.getState().deciding).toBe(false);
  });

  it('cancel that arrives too late shows the finished suggestion', async () => {
    const { controller, api, onCancelled } = setup();
    api.cancel.mockResolvedValueOnce(done());
    await controller.start({ mode: 'polish' });
    await controller.cancel();
    expect(phase(controller)).toBe('result');
    expect(onCancelled).not.toHaveBeenCalled();
  });

  it('keeps following a run through a dropped connection', async () => {
    const { controller, api } = setup();
    api.get.mockRejectedValueOnce(new ApiError('network_error', 'down', 0)).mockResolvedValueOnce(done());
    await controller.start({ mode: 'polish' });
    await tick(0);
    expect(phase(controller)).toBe('running');
    await tick(POLL_CLOSED_MS);
    expect(phase(controller)).toBe('result');
  });

  it('a run that no longer exists ends the Running stage with a message', async () => {
    const { controller, api } = setup();
    api.get.mockRejectedValue(new ApiError('run_not_found', 'gone', 404));
    await controller.start({ mode: 'polish' });
    await tick(0);
    expect(phase(controller)).toBe('idle');
    expect(controller.getState().notice).toMatch(/no longer exists/);
  });
});

describe('polling pace', () => {
  async function running() {
    const ctx = setup();
    ctx.api.get.mockResolvedValue(run({ status: 'running' }));
    await ctx.controller.start({ mode: 'polish' });
    await tick(0); // the immediate poll
    ctx.api.get.mockClear();
    return ctx;
  }

  it('polls every 2 s while the sheet is open', async () => {
    const { controller, api } = await running();
    controller.setSheetOpen(true);
    await tick(0);
    api.get.mockClear();
    await tick(POLL_OPEN_MS * 3 + 50);
    expect(api.get).toHaveBeenCalledTimes(3);
  });

  it('polls every 10 s while it is closed, and switches pace as the sheet opens and closes', async () => {
    const { controller, api } = await running();
    await tick(POLL_CLOSED_MS - 100);
    expect(api.get).not.toHaveBeenCalled();
    await tick(200);
    expect(api.get).toHaveBeenCalledTimes(1);
    api.get.mockClear();
    controller.setSheetOpen(true);
    await tick(0); // opening polls at once
    expect(api.get).toHaveBeenCalledTimes(1);
    api.get.mockClear();
    controller.setSheetOpen(false);
    await tick(POLL_OPEN_MS * 3);
    expect(api.get).not.toHaveBeenCalled();
    await tick(POLL_CLOSED_MS);
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('stops polling when disposed', async () => {
    const { controller, api } = await running();
    controller.dispose();
    await tick(POLL_CLOSED_MS * 3);
    expect(api.get).not.toHaveBeenCalled();
  });
});

describe('picking a rewrite up again when the editor opens', () => {
  it('resumes a run that is still running, and polls it', async () => {
    const { controller, api } = setup();
    api.latest.mockResolvedValue(run({ id: 'run-9', status: 'running', progress: ['writing…'] }));
    await controller.resume();
    expect(api.latest).toHaveBeenCalledWith(DATE);
    expect(controller.getState().phase).toMatchObject({ kind: 'running', run: { id: 'run-9' } });
    await tick(POLL_CLOSED_MS);
    expect(api.get).toHaveBeenCalledWith('run-9');
  });

  it('resumes a finished suggestion nobody has decided on', async () => {
    const { controller, api } = setup();
    api.latest.mockResolvedValue(done({ accepted: null }));
    await controller.resume();
    expect(phase(controller)).toBe('result');
  });

  it('does not resume a failed, cancelled or already decided run', async () => {
    for (const latest of [
      run({ status: 'failed', error: 'x' }),
      run({ status: 'cancelled' }),
      done({ accepted: true }),
      done({ accepted: false }),
    ]) {
      const { controller, api, onCancelled } = setup();
      api.latest.mockResolvedValue(latest);
      await controller.resume();
      expect(phase(controller)).toBe('idle');
      expect(onCancelled).not.toHaveBeenCalled();
    }
  });

  it('copes with no run, an entry that is not on the server yet (404), and a failing request', async () => {
    const a = setup();
    await a.controller.resume();
    expect(phase(a.controller)).toBe('idle');
    const b = setup();
    b.api.latest.mockRejectedValue(new ApiError('entry_not_found', 'none', 404));
    await b.controller.resume();
    expect(phase(b.controller)).toBe('idle');
    expect(b.controller.getState().unavailable).toBeNull();
    const c = setup();
    c.api.latest.mockRejectedValue(new ApiError('network_error', 'down', 0));
    await c.controller.resume();
    expect(phase(c.controller)).toBe('idle');
  });

  it('learns that the model is unavailable from the lookup', async () => {
    const { controller, api } = setup();
    api.latest.mockRejectedValue(new ApiError('ai_unavailable', 'The AI rewrite needs the claude CLI.', 503));
    await controller.resume();
    expect(controller.getState().unavailable).toBe('The AI rewrite needs the claude CLI.');
  });
});

describe('deciding', () => {
  async function withResult(over: Parameters<typeof setup>[1] = {}) {
    const ctx = setup(undefined, over);
    ctx.api.latest.mockResolvedValue(done());
    await ctx.controller.resume();
    expect(phase(ctx.controller)).toBe('result');
    return ctx;
  }

  it('Use suggestion saves what is typed, accepts, and hands the entry and the Undo revision to the host', async () => {
    const { controller, api, onAccepted, ensureSaved } = await withResult();
    await controller.accept();
    expect(ensureSaved).toHaveBeenCalled();
    expect(api.accept).toHaveBeenCalledWith('run-1');
    expect(onAccepted).toHaveBeenCalledWith({ entry: { revisionNo: 9 }, undoRevisionNo: 5 });
    expect(phase(controller)).toBe('idle');
    expect(controller.getState().deciding).toBe(false);
  });

  it('keeps the suggestion on screen with the server message when the entry changed (entry_changed)', async () => {
    const { controller, api, onAccepted } = await withResult();
    api.accept.mockRejectedValueOnce(
      new ApiError(
        'entry_changed',
        'You edited this entry after the suggestion was made. Ask again to get one for what you have now.',
        409,
      ),
    );
    await controller.accept();
    expect(onAccepted).not.toHaveBeenCalled();
    expect(phase(controller)).toBe('result');
    expect(controller.getState().notice).toBe(
      'You edited this entry after the suggestion was made. Ask again to get one for what you have now.',
    );
    expect(controller.getState().deciding).toBe(false);
  });

  it('Keep mine rejects the suggestion and returns to Choose; the entry is not touched', async () => {
    const { controller, api, onAccepted } = await withResult();
    await controller.reject();
    expect(api.reject).toHaveBeenCalledWith('run-1');
    expect(onAccepted).not.toHaveBeenCalled();
    expect(phase(controller)).toBe('idle');
  });

  it('Keep mine still closes the suggestion when the rejection does not reach the server', async () => {
    const { controller, api } = await withResult();
    api.reject.mockRejectedValueOnce(new ApiError('network_error', 'down', 0));
    await controller.reject();
    expect(phase(controller)).toBe('idle');
  });

  it('Try again goes back to Choose, but never while a run is going', async () => {
    const { controller } = await withResult();
    controller.reset();
    expect(phase(controller)).toBe('idle');
    const running = setup();
    await running.controller.start({ mode: 'polish' });
    running.controller.reset();
    expect(phase(running.controller)).toBe('running');
  });
});

/**
 * The AI rewrite of one day as a state machine: start a run, follow it (every 2 s while the sheet is open, every 10 s while
 * it is closed), let the author cancel, accept or keep their own text. No React and no `fetch` in here: the host hands in the
 * API, so it runs under fake timers in a test.
 *
 * The rules (docs/designs/daily-journal.md, "AI rewrite"): nothing changes in the entry until Use suggestion; a run works
 * from the server's copy, so what is typed is saved first; a rewrite that is still running, or finished and not yet decided,
 * is picked up again when the editor opens.
 */
import { type ApiError, isApiError } from '../../api/client';
import type {
  JournalAiAcceptView,
  JournalAiMode,
  JournalAiRunView,
  JournalAiStartInput,
  JournalAiStartView,
} from '../../api/types';

export interface AiApi {
  latest: (date: string) => Promise<JournalAiRunView | null>;
  start: (date: string, input: JournalAiStartInput) => Promise<JournalAiStartView>;
  get: (runId: string) => Promise<JournalAiRunView>;
  cancel: (runId: string) => Promise<JournalAiRunView>;
  accept: (runId: string) => Promise<JournalAiAcceptView>;
  reject: (runId: string) => Promise<JournalAiRunView>;
}

/** A run that is queued or running: only what the Running stage shows. */
export interface ActiveRun {
  id: string;
  status: 'queued' | 'running';
  progress: string[];
  mode: JournalAiMode | null;
}

export type AiPhase =
  | { kind: 'idle' }
  /** Saving what is typed, then asking the server to start. */
  | { kind: 'starting' }
  | { kind: 'running'; run: ActiveRun }
  /** Done, and the author has not decided: the Suggestion stage. */
  | { kind: 'result'; run: JournalAiRunView }
  | { kind: 'failed'; run: JournalAiRunView };

export interface AiState {
  phase: AiPhase;
  /** A problem to show in the sheet (a refused start, an entry that changed, a failed accept). */
  notice: string | null;
  /** Set when the server says the model cannot run here: the button is disabled with this as its reason. */
  unavailable: string | null;
  /** Use suggestion or Keep mine is being sent. */
  deciding: boolean;
}

export interface AiRunDeps {
  date: string;
  api: AiApi;
  /** Saves what is typed so the server holds it. false when it could not be saved (offline, a conflict). */
  ensureSaved: () => Promise<boolean>;
  /** The author used the suggestion: the entry (and the revision Undo restores) come back. */
  onAccepted: (result: JournalAiAcceptView) => void;
  /** A run ended as cancelled while the author was not looking at it (or by their own Cancel run). */
  onCancelled: () => void;
  /** Poll every this many ms while the sheet is open / closed. */
  openMs?: number;
  closedMs?: number;
}

export const POLL_OPEN_MS = 2_000;
export const POLL_CLOSED_MS = 10_000;

const IDLE: AiState = { phase: { kind: 'idle' }, notice: null, unavailable: null, deciding: false };

const activeOf = (run: JournalAiRunView): ActiveRun => ({
  id: run.id,
  status: run.status === 'running' ? 'running' : 'queued',
  progress: run.progress,
  mode: run.mode,
});

const isCode = (e: unknown, status: number, code: string): e is ApiError =>
  isApiError(e) && e.status === status && e.code === code;

export class AiRunController {
  private state: AiState = IDLE;
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sheetOpen = false;
  private disposed = false;
  /** The run the author just cancelled themselves: its end is not announced a second time. */
  private cancelledByUs: string | null = null;

  constructor(private readonly deps: AiRunDeps) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getState = (): AiState => this.state;

  private set(patch: Partial<AiState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  // ------------------------------------------------------------------------------------------ following a run
  private schedule(delay?: number): void {
    this.clearTimer();
    if (this.disposed || this.state.phase.kind !== 'running') return;
    const wait =
      delay ?? (this.sheetOpen ? (this.deps.openMs ?? POLL_OPEN_MS) : (this.deps.closedMs ?? POLL_CLOSED_MS));
    this.timer = setTimeout(() => void this.poll(), wait);
  }
  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** The sheet opened or closed: poll now when it opens, and change the pace. */
  setSheetOpen(open: boolean): void {
    if (this.sheetOpen === open) return;
    this.sheetOpen = open;
    if (this.state.phase.kind !== 'running') return;
    this.schedule(open ? 0 : undefined);
  }

  private async poll(): Promise<void> {
    const phase = this.state.phase;
    if (phase.kind !== 'running') return;
    const id = phase.run.id;
    try {
      const run = await this.deps.api.get(id);
      const now = this.state.phase;
      if (now.kind !== 'running' || now.run.id !== id) return; // moved on while the answer was on its way
      this.take(run, false);
    } catch (error) {
      const now = this.state.phase;
      if (now.kind !== 'running' || now.run.id !== id) return;
      if (isApiError(error) && error.status === 404) {
        this.set({ phase: { kind: 'idle' }, notice: 'That rewrite no longer exists.' });
        return;
      }
      // a dropped connection is not the end of the run: keep following it
      this.schedule();
    }
  }

  /** Moves to the phase a run's status says. `resume` is true when the run is found again after opening the editor. */
  private take(run: JournalAiRunView, resume: boolean): void {
    if (run.status === 'queued' || run.status === 'running') {
      this.set({ phase: { kind: 'running', run: activeOf(run) } });
      this.schedule();
      return;
    }
    this.clearTimer();
    if (run.status === 'done') {
      this.set({ phase: run.accepted === null ? { kind: 'result', run } : { kind: 'idle' } });
      return;
    }
    if (run.status === 'failed') {
      this.set({ phase: resume ? { kind: 'idle' } : { kind: 'failed', run } });
      return;
    }
    // cancelled
    this.set({ phase: { kind: 'idle' } });
    if (!resume && this.cancelledByUs !== run.id) this.deps.onCancelled();
    this.cancelledByUs = null;
  }

  /** The editor opened: pick up a rewrite that is still running, or finished and not yet decided. */
  async resume(): Promise<void> {
    try {
      const run = await this.deps.api.latest(this.deps.date);
      if (!run || this.disposed || this.state.phase.kind !== 'idle') return;
      this.take(run, true);
    } catch (error) {
      if (isCode(error, 503, 'ai_unavailable')) this.set({ unavailable: error.message });
      // 404: the day has no entry yet, so no run; anything else: the sheet works without the old run
    }
  }

  // ------------------------------------------------------------------------------------------ the author's actions
  async start(input: JournalAiStartInput): Promise<void> {
    const kind = this.state.phase.kind;
    if (kind === 'starting' || kind === 'running') return;
    this.set({ phase: { kind: 'starting' }, notice: null });
    const saved = await this.deps.ensureSaved();
    if (this.disposed) return;
    if (!saved) {
      this.set({
        phase: { kind: 'idle' },
        notice: 'Your latest text is not saved yet, and the rewrite works from the saved copy. Try again when it is.',
      });
      return;
    }
    try {
      const { runId } = await this.deps.api.start(this.deps.date, input);
      this.set({
        phase: { kind: 'running', run: { id: runId, status: 'queued', progress: [], mode: input.mode } },
      });
      this.schedule(0);
    } catch (error) {
      await this.startFailed(error);
    }
  }

  private async startFailed(error: unknown): Promise<void> {
    if (isCode(error, 409, 'run_in_progress')) {
      // a rewrite is already running for this entry (started from another tab or device): follow that one
      const details = error.details;
      const runId =
        typeof details === 'object' && details !== null ? (details as { runId?: unknown }).runId : undefined;
      if (typeof runId === 'string') {
        try {
          const run = await this.deps.api.get(runId);
          this.take(run, false);
          this.set({ notice: 'A rewrite was already running for this entry. This is that one.' });
          return;
        } catch {
          // fall through to the message below
        }
      }
    }
    const message = isApiError(error) ? error.message : 'The rewrite could not be started.';
    this.set({
      phase: { kind: 'idle' },
      notice: message,
      ...(isCode(error, 503, 'ai_unavailable') ? { unavailable: message } : {}),
    });
  }

  async cancel(): Promise<void> {
    const phase = this.state.phase;
    if (phase.kind !== 'running') return;
    this.cancelledByUs = phase.run.id;
    this.set({ deciding: true });
    try {
      const run = await this.deps.api.cancel(phase.run.id);
      this.set({ deciding: false });
      this.take(run, false);
      if (run.status === 'cancelled') this.deps.onCancelled();
    } catch (error) {
      this.cancelledByUs = null;
      this.set({ deciding: false, notice: isApiError(error) ? error.message : 'The run could not be cancelled.' });
    }
  }

  /** Use suggestion. */
  async accept(): Promise<void> {
    const phase = this.state.phase;
    if (phase.kind !== 'result' || this.state.deciding) return;
    this.set({ deciding: true, notice: null });
    // Anything typed since is saved first. That changes the entry, so the server refuses the suggestion
    // (`entry_changed`) instead of replacing text that was never saved.
    await this.deps.ensureSaved();
    if (this.disposed) return;
    try {
      const result = await this.deps.api.accept(phase.run.id);
      this.set({ phase: { kind: 'idle' }, deciding: false, notice: null });
      this.deps.onAccepted(result);
    } catch (error) {
      const message = isApiError(error) ? error.message : 'The suggestion could not be used.';
      this.set({ deciding: false, notice: message });
    }
  }

  /** Keep mine. */
  async reject(): Promise<void> {
    const phase = this.state.phase;
    if (phase.kind !== 'result' || this.state.deciding) return;
    this.set({ deciding: true });
    try {
      await this.deps.api.reject(phase.run.id);
    } catch {
      // the entry was never changed: a rejection that did not reach the server only leaves the suggestion waiting
    }
    this.set({ phase: { kind: 'idle' }, deciding: false, notice: null });
  }

  /** Back to the Choose stage (Try again, or after a failed run). */
  reset(): void {
    this.clearTimer();
    if (this.state.phase.kind === 'running') return;
    this.set({ phase: { kind: 'idle' }, notice: null });
  }

  /** The editor mounted (again, under StrictMode): follow the run again if there is one. */
  attach(): void {
    this.disposed = false;
    this.schedule();
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
  }
}

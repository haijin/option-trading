/**
 * The journal's AI rewrite (docs/designs/daily-journal.md). A run takes an entry's prose, hands it to the model with no
 * tools and a small dollar cap, checks what comes back, and offers the result as a suggestion. Nothing reaches the entry
 * until the author accepts, and accepting writes a revision first. Images, tables, snapshots and checklists never reach
 * the model: they are cut out as placeholders and put back untouched. The pure parts are in src/journal/ai.ts.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activeJournalAiRun,
  allInstrumentSymbols,
  claimJournalAiRun,
  countJournalAiRunsSince,
  failOrphanedJournalAiRuns,
  getJournalAiRun,
  getJournalAiRunById,
  getJournalEntryDate,
  insertJournalAiRun,
  type JournalAiRunRow,
  latestJournalAiRun,
  lockJournalAiUser,
  updateJournalAiRun,
} from '../../db/journal';
import { countWords } from '../../journal';
import {
  buildPrompt,
  cutLockedBlocks,
  finishRewrite,
  type JournalAiMode,
  type LockedBlock,
  MODE_LABEL,
} from '../../journal/ai';
import type { JournalAiAcceptView, JournalAiRunView, JournalAiStartInput, JournalAiStartView } from '../api-types';
import type { ServerDeps } from '../deps';
import { ApiError, badRequest, conflict, notFound, unavailable } from '../errors';
import { type JournalAiConfig, journalAiConfig } from '../journal-config';
import { docHash, type JournalService } from './journal-service';
import type { JournalSnapshotService, SnapshotContext } from './journal-snapshot';

const CONCURRENCY = 2;
const PLACEHOLDER = /\[\[(?:FIG|TBL|SNAP|TODO):\d+\]\]/g;
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s).replace(/\s+/g, ' ').trim();

/** The model was asked for Markdown only; if it wrapped the whole answer in a code fence anyway, take the fence off. */
function unfence(text: string): string {
  const t = text.replace(/\r\n/g, '\n').trim();
  const m = /^```(?:markdown|md)?\n([\s\S]*?)\n```$/.exec(t);
  return (m ? (m[1] as string) : t).trim();
}

export class JournalAiService {
  private readonly controllers = new Map<string, AbortController>();
  private readonly queue: string[] = [];
  private active = 0;
  private readonly cfg: JournalAiConfig;

  constructor(
    private readonly deps: ServerDeps,
    private readonly journal: JournalService,
    private readonly snapshots: JournalSnapshotService,
  ) {
    this.cfg = journalAiConfig(process.env, deps.journal);
    // A process that died mid-run leaves queued or running rows that would be polled forever.
    void failOrphanedJournalAiRuns(deps.db, 'the server restarted while this run was in progress', deps.now()).catch(
      () => undefined,
    );
  }

  // ------------------------------------------------------------------------------------------ views
  private async view(row: JournalAiRunRow): Promise<JournalAiRunView> {
    const date = (await getJournalEntryDate(this.deps.db, row.entryId)) ?? '';
    const locked = (row.locked ?? []) as LockedBlock[];
    return {
      id: row.id,
      date,
      mode: row.mode as JournalAiMode,
      instruction: row.instruction,
      withContext: row.withContext,
      status: row.status as JournalAiRunView['status'],
      accepted: row.accepted,
      progress: row.progress ?? [],
      error: row.error,
      model: row.model,
      costUsd: row.costUsd === null ? null : Number(row.costUsd),
      durationMs: row.durationMs,
      createdAt: row.createdAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
      result:
        row.status === 'done' && row.outputDoc
          ? {
              doc: row.outputDoc,
              inputMarkdown: row.inputMarkdown,
              outputMarkdown: row.outputMarkdown ?? '',
              lockedKept: locked.length,
              lockedTotal: locked.length,
            }
          : null,
    };
  }

  private async own(userId: string, id: string): Promise<JournalAiRunRow> {
    const row = await getJournalAiRun(this.deps.db, userId, id);
    if (!row) throw notFound('there is no such rewrite', 'run_not_found');
    return row;
  }

  async get(userId: string, id: string): Promise<JournalAiRunView> {
    return this.view(await this.own(userId, id));
  }

  async latestForEntry(userId: string, rawDate: string): Promise<JournalAiRunView | null> {
    const entry = await this.journal.entryRow(userId, rawDate);
    const row = await latestJournalAiRun(this.deps.db, userId, entry.id);
    return row ? this.view(row) : null;
  }

  // ------------------------------------------------------------------------------------------ start
  async start(userId: string, rawDate: string, input: JournalAiStartInput): Promise<JournalAiStartView> {
    const instruction = (input.instruction ?? '').trim() || null;
    if (instruction && instruction.length > 500)
      throw badRequest('invalid_instruction', 'The instruction is at most 500 characters.');
    if (input.mode === 'custom' && !instruction)
      throw badRequest('instruction_required', 'Tell the AI what to do in the box, or pick another mode.');
    if (this.deps.research.executorKind === 'none')
      throw unavailable(
        'ai_unavailable',
        'The AI rewrite needs the claude CLI and it was not found. Set OT_CLAUDE_CLI to its path and restart the app.',
      );
    const db = this.deps.db;
    const entry = await this.journal.entryRow(userId, rawDate);
    const now = this.deps.now();
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const cut = cutLockedBlocks(entry.doc);
    if (cut.words === 0)
      throw badRequest('nothing_to_rewrite', 'There is no text to rewrite yet. Write something first.');
    let row: JournalAiRunRow;
    try {
      // Count, one-at-a-time check and insert under one per-user lock, so parallel starts cannot overshoot the daily cap.
      row = await db.transaction(async (tx) => {
        await lockJournalAiUser(tx, userId);
        if ((await countJournalAiRunsSince(tx, userId, dayStart)) >= this.cfg.dailyRuns)
          throw new ApiError(
            429,
            'daily_limit',
            `You have used today's ${this.cfg.dailyRuns} rewrites. The count restarts at midnight UTC.`,
          );
        const running = await activeJournalAiRun(tx, entry.id);
        if (running)
          throw conflict('run_in_progress', 'A rewrite is already running for this entry.', { runId: running.id });
        return insertJournalAiRun(tx, {
          entryId: entry.id,
          userId,
          mode: input.mode,
          instruction,
          withContext: input.withContext === true,
          inputMarkdown: cut.markdown,
          locked: cut.locked,
          inputHash: docHash(entry.doc),
          createdAt: now,
        });
      });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      // Two starts at once: the unique index on (entry) while queued or running let only one in.
      const again = await activeJournalAiRun(db, entry.id);
      if (again) throw conflict('run_in_progress', 'A rewrite is already running for this entry.', { runId: again.id });
      throw err;
    }
    this.queue.push(row.id);
    this.pump();
    return { runId: row.id };
  }

  // ------------------------------------------------------------------------------------------ worker
  private pump(): void {
    while (this.active < CONCURRENCY && this.queue.length > 0) {
      const id = this.queue.shift() as string;
      this.active++;
      void this.runOne(id)
        .catch((err) => this.deps.log(`journal AI run ${id} crashed: ${(err as Error).stack ?? String(err)}`))
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }

  /** Waits for every queued and running rewrite to finish (tests). */
  async idle(): Promise<void> {
    while (this.active > 0 || this.queue.length > 0) await new Promise((r) => setTimeout(r, 20));
  }

  private async runOne(id: string): Promise<void> {
    const db = this.deps.db;
    const row = await getJournalAiRunById(db, id);
    if (row?.status !== 'queued') return;
    // Claim it: a cancel that lands between the read above and here wins and the run never starts.
    if (!(await claimJournalAiRun(db, id))) return;
    const mode = row.mode as JournalAiMode;
    const locked = (row.locked ?? []) as LockedBlock[];
    const ctrl = new AbortController();
    this.controllers.set(id, ctrl);
    const started = this.deps.now().getTime();
    const lines: string[] = [];
    let chain: Promise<void> = Promise.resolve();
    const say = (line: string): void => {
      lines.push(line);
      if (lines.length > 40) lines.splice(1, lines.length - 40);
      const snapshot = [...lines];
      chain = chain.then(() => updateJournalAiRun(db, id, { progress: snapshot })).catch(() => undefined);
    };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, this.cfg.timeoutMs);
    let workDir: string | null = null;
    try {
      let context: SnapshotContext | null = null;
      if (row.withContext) context = await this.snapshots.contextBlock();
      const words = countWords(row.inputMarkdown.replace(PLACEHOLDER, ' '));
      const kinds = [
        ...new Set(locked.map((l) => ({ FIG: 'image', TBL: 'table', SNAP: 'snapshot', TODO: 'checklist' })[l.kind])),
      ];
      say(
        `prose: ${words} words, ${locked.length} locked block${locked.length === 1 ? '' : 's'}${kinds.length ? ` (${kinds.join(', ')})` : ''}`,
      );
      say(`mode: ${MODE_LABEL[mode]}${row.instruction ? ` · "${clip(row.instruction, 60)}"` : ''}`);
      say(`context: ${context ? context.summary : 'none'}`);
      say(`claude -p · no tools · cap $${this.cfg.maxBudgetUsd.toFixed(2)} · model ${this.cfg.model}`);
      say('writing…');
      workDir = await mkdtemp(join(tmpdir(), 'ot-journal-ai-'));
      const prompt = buildPrompt({
        mode,
        instruction: row.instruction,
        context: context?.text ?? null,
        markdown: row.inputMarkdown,
      });
      const res = await this.deps.research.executor.run({
        prompt,
        cwd: workDir,
        signal: ctrl.signal,
        onProgress: (l) => say(clip(l, 160)),
        maxBudgetUsd: this.cfg.maxBudgetUsd,
        model: this.cfg.model,
        tools: [],
        allowedTools: [],
        isolated: true,
      });
      clearTimeout(timer);
      const output = unfence(res.markdown);
      const outcome = finishRewrite({
        mode,
        input: row.inputMarkdown,
        output,
        locked,
        watched: await allInstrumentSymbols(db),
      });
      await chain;
      const common = {
        outputMarkdown: output,
        model: res.model ?? this.cfg.model,
        costUsd: res.costUsd === null ? null : res.costUsd.toFixed(4),
        durationMs: this.deps.now().getTime() - started,
        finishedAt: this.deps.now(),
      };
      if (outcome.ok && outcome.doc)
        await updateJournalAiRun(db, id, { ...common, status: 'done', outputDoc: outcome.doc });
      else
        await updateJournalAiRun(db, id, {
          ...common,
          status: 'failed',
          error: `The suggestion was refused and nothing was changed. ${outcome.problems[0] ?? ''}`.trim(),
        });
    } catch (err) {
      await chain;
      const base = { durationMs: this.deps.now().getTime() - started, finishedAt: this.deps.now() };
      if (timedOut)
        await updateJournalAiRun(db, id, {
          ...base,
          status: 'failed',
          error: `The model did not answer within ${Math.max(1, Math.round(this.cfg.timeoutMs / 1000))} seconds. Nothing was changed.`,
        });
      else if (ctrl.signal.aborted) await updateJournalAiRun(db, id, { ...base, status: 'cancelled' });
      else
        await updateJournalAiRun(db, id, {
          ...base,
          status: 'failed',
          error: `The model run failed: ${clip((err as Error).message, 300)} Nothing was changed.`,
        });
    } finally {
      clearTimeout(timer);
      this.controllers.delete(id);
      if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // ------------------------------------------------------------------------------------------ decide
  async cancel(userId: string, id: string): Promise<JournalAiRunView> {
    const row = await this.own(userId, id);
    if (row.status === 'queued') {
      const i = this.queue.indexOf(id);
      if (i >= 0) this.queue.splice(i, 1);
      await updateJournalAiRun(this.deps.db, id, { status: 'cancelled', finishedAt: this.deps.now() });
    } else if (row.status === 'running') {
      this.controllers.get(id)?.abort();
      // The worker records the cancellation as soon as the model process is gone; wait for it so the answer is final.
      for (let n = 0; n < 100 && this.controllers.has(id); n++) await new Promise((r) => setTimeout(r, 20));
    }
    return this.view(await this.own(userId, id));
  }

  async accept(userId: string, id: string): Promise<JournalAiAcceptView> {
    const row = await this.own(userId, id);
    if (row.status !== 'done' || !row.outputDoc)
      throw conflict('run_not_ready', 'This rewrite has no suggestion to use.');
    if (row.accepted !== null)
      throw conflict(
        'already_decided',
        row.accepted ? 'This suggestion was already used.' : 'You already kept your version.',
      );
    const date = await getJournalEntryDate(this.deps.db, row.entryId);
    if (!date) throw notFound('there is no entry for that day', 'entry_not_found');
    return this.journal.applyAiResult(userId, date, { id: row.id, inputHash: row.inputHash }, row.outputDoc);
  }

  async reject(userId: string, id: string): Promise<JournalAiRunView> {
    const row = await this.own(userId, id);
    if (row.status !== 'done') throw conflict('run_not_ready', 'This rewrite has no suggestion to decline.');
    if (row.accepted === null) await updateJournalAiRun(this.deps.db, id, { accepted: false });
    return this.view(await this.own(userId, id));
  }
}

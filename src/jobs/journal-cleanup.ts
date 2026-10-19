/**
 * Daily housekeeping for the journal (docs/designs/daily-journal.md): entries deleted more than 30 days ago are removed
 * for good, and images that nothing shows any more (an upload that was never saved, a picture taken out of an entry whose
 * History no longer holds it) are deleted with their files once they are a day old.
 * The job reads only the journal's own tables and files; it knows nothing about the scanner, and nothing there reads it.
 */
import { rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { Db } from '../db/client';
import { deleteJournalAssetIfUnused, orphanJournalAssets, purgeDeletedJournalEntries } from '../db/journal';
import { finishJob, startJob } from '../db/repos';
import { thumbRelPath } from '../journal';
import type { JobDeps, JobOutcome } from './jobs';

/** An upload that is not in any entry after this long is abandoned. */
export const ORPHAN_ASSET_AGE_MS = 24 * 3600 * 1000;

export interface JournalCleanupResult {
  purgedEntries: number;
  deletedAssets: number;
}

/** Removes a stored image and its thumbnail; refuses a path that would leave the data root. */
async function removeFiles(dataDir: string, rel: string): Promise<void> {
  const root = resolve(dataDir);
  for (const r of [rel, thumbRelPath(rel)]) {
    const full = resolve(root, r);
    if (!full.startsWith(root + sep)) continue;
    await rm(full, { force: true });
  }
}

export async function cleanJournal(db: Db, dataDir: string, now: Date): Promise<JournalCleanupResult> {
  // Entries first: their revisions go with them, which frees the images only they showed.
  const purgedEntries = await purgeDeletedJournalEntries(db, now);
  const cutoff = new Date(now.getTime() - ORPHAN_ASSET_AGE_MS);
  const orphans = await orphanJournalAssets(db, cutoff);
  let deletedAssets = 0;
  for (const a of orphans) {
    // Looked at again under a row lock: an image that was uploaded again or saved into an entry since the list was made stays.
    const gone = await deleteJournalAssetIfUnused(db, a.userId, a.id, cutoff);
    if (gone === null || gone === 'in_use') continue;
    await removeFiles(dataDir, gone.path);
    deletedAssets++;
  }
  return { purgedEntries, deletedAssets };
}

/** The scheduled run: records a `job_runs` row and never throws. */
export async function runJournalCleanupJob(deps: JobDeps): Promise<JobOutcome> {
  const handle = deps.ctx.db();
  const id = await startJob(handle.db, 'journal-cleanup', {});
  try {
    const r = await cleanJournal(handle.db, deps.ctx.dataDir, deps.ctx.now());
    const out: JobOutcome = {
      status: 'ok',
      rows: r.purgedEntries + r.deletedAssets,
      detail: `${r.purgedEntries} deleted entries purged, ${r.deletedAssets} unused images removed`,
    };
    await finishJob(handle.db, id, { status: out.status, rowsWritten: out.rows, meta: { detail: out.detail } });
    deps.log(`job journal-cleanup: ${out.detail}`);
    return out;
  } catch (err) {
    const message = (err as Error).message;
    await finishJob(handle.db, id, { status: 'failed', error: message });
    deps.log(`job journal-cleanup failed: ${message}`);
    return { status: 'failed', rows: 0, detail: message };
  }
}

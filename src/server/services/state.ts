/** Shared mutable state of one server process. */
export class AppState {
  /** Bumped by every write that can change a result (ingest, watchlist edit, position, settings, import). Caches key on it. */
  version = 0;

  bump(): void {
    this.version++;
  }
}

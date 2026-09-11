export interface RunRevision<T> { key: string; value: T }
/** One runner, newest revision only, no persistence and no execution until explicitly enabled/run. */
export class LiveTests<T, R> {
  private timer?: ReturnType<typeof setTimeout>;
  private current?: RunRevision<T>;
  private queued?: RunRevision<T>;
  private active?: AbortController;
  private disposed = false;
  enabled = false;
  constructor(private readonly execute: (value: T, signal: AbortSignal) => Promise<R>,
    private readonly completed: (result: R, key: string) => void,
    private readonly failed: (error: unknown) => void,
    private readonly debounceMs = 500) {}
  change(revision?: RunRevision<T>): void {
    if (revision?.key === this.current?.key && revision !== undefined) return;
    this.current = revision;
    this.queued = undefined;
    clearTimeout(this.timer);
    this.active?.abort();
    if (this.enabled && revision) this.timer = setTimeout(() => this.request(), this.debounceMs);
  }
  enable(): void { this.enabled = true; this.request(); }
  pause(): void { this.enabled = false; this.cancel(); }
  cancel(): void { clearTimeout(this.timer); this.queued = undefined; this.active?.abort(); }
  request(): void {
    clearTimeout(this.timer);
    if (!this.current || this.disposed) return;
    this.queued = this.current;
    if (this.active) { this.active.abort(); return; }
    void this.drain();
  }
  private async drain(): Promise<void> {
    const revision = this.queued;
    if (!revision || this.disposed) return;
    this.queued = undefined;
    const controller = new AbortController();
    this.active = controller;
    try {
      const result = await this.execute(revision.value, controller.signal);
      if (!controller.signal.aborted && this.current?.key === revision.key && !this.disposed) this.completed(result, revision.key);
    } catch (error) {
      if (!controller.signal.aborted && !this.disposed) this.failed(error);
    } finally {
      this.active = undefined;
      if (this.queued && !this.disposed) void this.drain();
    }
  }
  dispose(): void { this.disposed = true; this.pause(); }
}

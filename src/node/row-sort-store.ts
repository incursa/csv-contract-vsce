import { closeSync, createReadStream, existsSync, mkdirSync, mkdtempSync, openSync, rmSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { OrderedRow } from "../core/ordered-rule";

/** A bounded chunk sort. Each run is immutable and merge reads one row per run. */
export class RowSortStore {
  private readonly directory: string;
  private readonly paths: string[] = [];
  private buffer: OrderedRow[] = [];
  private mergeId = 0;

  public constructor(private readonly compare: (a: OrderedRow, b: OrderedRow) => number,
    tempRoot?: string, private readonly chunkRows = 10000) {
    const root = resolve(tempRoot ?? tmpdir());
    if (!existsSync(root)) mkdirSync(root, { recursive: true });
    this.directory = mkdtempSync(join(root, "csv-contract-sequence-"));
  }

  public add(row: OrderedRow): void {
    this.buffer.push(row);
    if (this.buffer.length >= this.chunkRows) this.spill();
  }

  private spill(): void {
    if (!this.buffer.length) return;
    this.buffer.sort(this.compare);
    const path = join(this.directory, `run-${this.paths.length}.jsonl`);
    writeFileSync(path, this.buffer.map(row => JSON.stringify(row)).join("\n") + "\n");
    this.paths.push(path);
    this.buffer = [];
  }

  public async *rows(): AsyncGenerator<OrderedRow> {
    if (this.paths.length === 0) {
      this.buffer.sort(this.compare);
      yield* this.buffer;
      return;
    }
    this.spill();
    let paths = [...this.paths];
    while (paths.length > 64) {
      const merged: string[] = [];
      for (let start = 0; start < paths.length; start += 64) {
        const batch = paths.slice(start, start + 64);
        const path = join(this.directory, `merge-${this.mergeId++}.jsonl`);
        const descriptor = openSync(path, "w");
        try { for await (const row of this.merge(batch)) writeSync(descriptor, JSON.stringify(row) + "\n"); }
        finally { closeSync(descriptor); }
        batch.forEach(unlinkSync);
        merged.push(path);
      }
      paths = merged;
    }
    yield* this.merge(paths);
  }

  private async *merge(paths: string[]): AsyncGenerator<OrderedRow> {
    const readers = paths.map(path => createInterface({ input: createReadStream(path), crlfDelay: Infinity })[Symbol.asyncIterator]());
    const heads = await Promise.all(readers.map(async reader => {
      const next = await reader.next();
      return next.done ? undefined : JSON.parse(next.value) as OrderedRow;
    }));
    while (true) {
      let best = -1;
      for (let i = 0; i < heads.length; i++) {
        if (heads[i] && (best < 0 || this.compare(heads[i]!, heads[best]!) < 0)) best = i;
      }
      if (best < 0) break;
      yield heads[best]!;
      const next = await readers[best].next();
      heads[best] = next.done ? undefined : JSON.parse(next.value) as OrderedRow;
    }
  }

  public dispose(): void { rmSync(this.directory, { recursive: true, force: true }); }
}

import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeSync
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

interface Partition {
  path: string;
  descriptor: number;
  buffer: Buffer;
  offset: number;
}

export interface DuplicateValue {
  targetId: number;
  value: string;
  firstRow: number;
  row: number;
}

function hashValue(targetId: number, value: string): number {
  let hash = (2166136261 ^ targetId) >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

export class PartitionedUniquenessStore {
  private readonly directory: string;
  private readonly partitions: Partition[];
  private closed = false;

  public constructor(tempRoot?: string, partitionCount = 128, private readonly bufferBytes = 64 * 1024) {
    if (!Number.isInteger(partitionCount) || partitionCount < 8 || partitionCount > 1024) {
      throw new Error("uniquePartitions must be an integer between 8 and 1024.");
    }
    const root = resolve(tempRoot ?? tmpdir());
    if (!existsSync(root)) mkdirSync(root, { recursive: true });
    this.directory = mkdtempSync(join(root, "csv-contract-unique-"));
    this.partitions = Array.from({ length: partitionCount }, (_, index) => {
      const path = join(this.directory, `partition-${String(index).padStart(4, "0")}.bin`);
      return {
        path,
        descriptor: openSync(path, "w"),
        buffer: Buffer.allocUnsafe(this.bufferBytes),
        offset: 0
      };
    });
  }

  public add(targetId: number, value: string, row: number): void {
    if (this.closed) throw new Error("Uniqueness store is already closed.");
    const bytes = Buffer.from(value, "utf8");
    const recordBytes = 14 + bytes.length;
    const partition = this.partitions[hashValue(targetId, value) % this.partitions.length];
    if (recordBytes > partition.buffer.length) {
      this.flush(partition);
      const record = Buffer.allocUnsafe(recordBytes);
      this.writeRecord(record, 0, targetId, row, bytes);
      writeSync(partition.descriptor, record);
      return;
    }
    if (partition.offset + recordBytes > partition.buffer.length) this.flush(partition);
    this.writeRecord(partition.buffer, partition.offset, targetId, row, bytes);
    partition.offset += recordBytes;
  }

  public async findDuplicates(onDuplicate: (duplicate: DuplicateValue) => void): Promise<void> {
    this.closeForWriting();
    for (const partition of this.partitions) {
      const seen = new Map<string, number>();
      let pending = Buffer.alloc(0);
      for await (const chunk of createReadStream(partition.path, { highWaterMark: 1024 * 1024 })) {
        const content = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
        let offset = 0;
        while (content.length - offset >= 14) {
          const targetId = content.readUInt16LE(offset);
          const row = content.readDoubleLE(offset + 2);
          const length = content.readUInt32LE(offset + 10);
          const recordBytes = 14 + length;
          if (content.length - offset < recordBytes) break;
          const value = content.toString("utf8", offset + 14, offset + recordBytes);
          const key = `${targetId}\u0000${value}`;
          const firstRow = seen.get(key);
          if (firstRow === undefined) {
            seen.set(key, row);
          } else {
            onDuplicate({ targetId, value, firstRow, row });
          }
          offset += recordBytes;
        }
        pending = offset < content.length ? Buffer.from(content.subarray(offset)) : Buffer.alloc(0);
      }
      if (pending.length > 0) throw new Error(`Uniqueness partition "${partition.path}" ended with an incomplete record.`);
    }
  }

  public dispose(): void {
    this.closeForWriting();
    rmSync(this.directory, { recursive: true, force: true });
  }

  private writeRecord(target: Buffer, offset: number, targetId: number, row: number, value: Buffer): void {
    target.writeUInt16LE(targetId, offset);
    target.writeDoubleLE(row, offset + 2);
    target.writeUInt32LE(value.length, offset + 10);
    value.copy(target, offset + 14);
  }

  private flush(partition: Partition): void {
    if (partition.offset === 0) return;
    writeSync(partition.descriptor, partition.buffer.subarray(0, partition.offset));
    partition.offset = 0;
  }

  private closeForWriting(): void {
    if (this.closed) return;
    for (const partition of this.partitions) {
      this.flush(partition);
      closeSync(partition.descriptor);
    }
    this.closed = true;
  }
}

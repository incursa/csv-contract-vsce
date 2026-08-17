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

export interface GroupValues {
  targetId: number;
  groupKey: string;
  display: string;
  firstRow: number;
  values: Set<string>;
}

function hashValue(targetId: number, value: string): number {
  let hash = (2166136261 ^ targetId) >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

export class PartitionedGroupStore {
  private readonly directory: string;
  private readonly partitions: Partition[];
  private closed = false;

  public constructor(tempRoot?: string, partitionCount = 128, private readonly bufferBytes = 64 * 1024) {
    if (!Number.isInteger(partitionCount) || partitionCount < 8 || partitionCount > 1024) {
      throw new Error("uniquePartitions must be an integer between 8 and 1024.");
    }
    const root = resolve(tempRoot ?? tmpdir());
    if (!existsSync(root)) mkdirSync(root, { recursive: true });
    this.directory = mkdtempSync(join(root, "csv-contract-groups-"));
    this.partitions = Array.from({ length: partitionCount }, (_, index) => {
      const path = join(this.directory, `partition-${String(index).padStart(4, "0")}.bin`);
      return { path, descriptor: openSync(path, "w"), buffer: Buffer.allocUnsafe(this.bufferBytes), offset: 0 };
    });
  }

  public add(targetId: number, groupKey: string, display: string, value: string, row: number): void {
    if (this.closed) throw new Error("Group store is already closed.");
    const keyBytes = Buffer.from(groupKey, "utf8");
    const displayBytes = Buffer.from(display, "utf8");
    const valueBytes = Buffer.from(value, "utf8");
    const recordBytes = 22 + keyBytes.length + displayBytes.length + valueBytes.length;
    const partition = this.partitions[hashValue(targetId, groupKey) % this.partitions.length];
    if (recordBytes > partition.buffer.length) {
      this.flush(partition);
      const record = Buffer.allocUnsafe(recordBytes);
      this.writeRecord(record, 0, targetId, row, keyBytes, displayBytes, valueBytes);
      writeSync(partition.descriptor, record);
      return;
    }
    if (partition.offset + recordBytes > partition.buffer.length) this.flush(partition);
    this.writeRecord(partition.buffer, partition.offset, targetId, row, keyBytes, displayBytes, valueBytes);
    partition.offset += recordBytes;
  }

  public async readGroups(onGroup: (group: GroupValues) => void): Promise<void> {
    this.closeForWriting();
    for (const partition of this.partitions) {
      const groups = new Map<string, GroupValues>();
      let pending = Buffer.alloc(0);
      for await (const chunk of createReadStream(partition.path, { highWaterMark: 1024 * 1024 })) {
        const content = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
        let offset = 0;
        while (content.length - offset >= 22) {
          const targetId = content.readUInt16LE(offset);
          const row = content.readDoubleLE(offset + 2);
          const keyLength = content.readUInt32LE(offset + 10);
          const displayLength = content.readUInt32LE(offset + 14);
          const valueLength = content.readUInt32LE(offset + 18);
          const recordBytes = 22 + keyLength + displayLength + valueLength;
          if (content.length - offset < recordBytes) break;
          let contentOffset = offset + 22;
          const groupKey = content.toString("utf8", contentOffset, contentOffset + keyLength);
          contentOffset += keyLength;
          const display = content.toString("utf8", contentOffset, contentOffset + displayLength);
          contentOffset += displayLength;
          const value = content.toString("utf8", contentOffset, contentOffset + valueLength);
          const mapKey = `${targetId}\u0000${groupKey}`;
          const group = groups.get(mapKey) ?? { targetId, groupKey, display, firstRow: row, values: new Set<string>() };
          group.values.add(value);
          groups.set(mapKey, group);
          offset += recordBytes;
        }
        pending = offset < content.length ? Buffer.from(content.subarray(offset)) : Buffer.alloc(0);
      }
      if (pending.length > 0) throw new Error(`Group partition "${partition.path}" ended with an incomplete record.`);
      groups.forEach(onGroup);
    }
  }

  public dispose(): void {
    this.closeForWriting();
    rmSync(this.directory, { recursive: true, force: true });
  }

  private writeRecord(target: Buffer, offset: number, targetId: number, row: number,
    key: Buffer, display: Buffer, value: Buffer): void {
    target.writeUInt16LE(targetId, offset);
    target.writeDoubleLE(row, offset + 2);
    target.writeUInt32LE(key.length, offset + 10);
    target.writeUInt32LE(display.length, offset + 14);
    target.writeUInt32LE(value.length, offset + 18);
    key.copy(target, offset + 22);
    display.copy(target, offset + 22 + key.length);
    value.copy(target, offset + 22 + key.length + display.length);
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

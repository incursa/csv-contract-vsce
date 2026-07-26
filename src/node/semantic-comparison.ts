import { closeSync, createReadStream, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type * as vscode from "vscode";
import { canonicalValues, compareCsvTexts, normalizeComparisonValue } from "../comparison/engine";
import type {
  ComparisonDiagnostic,
  ComparisonOptions,
  ComparisonResult,
  ComparisonSummary,
  DuplicateKeyGroup
} from "../comparison/model";
import { rowsToCsv } from "../comparison/evidence";
import { readCsvRecords } from "./csv-stream";

const inMemoryBytes = 20 * 1024 * 1024;
const partitionCount = 128;

interface StoredRecord {
  key: string;
  row: Array<string | null>;
}

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

class PartitionedRecordStore {
  public readonly directory = mkdtempSync(join(tmpdir(), "csv-contract-compare-"));
  private readonly paths = Array.from({ length: partitionCount }, (_, index) => join(this.directory, `${String(index).padStart(3, "0")}.jsonl`));
  private readonly descriptors = this.paths.map((path) => openSync(path, "w"));
  private closed = false;

  public add(record: StoredRecord): void {
    const data = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    writeSync(this.descriptors[hash(record.key) % partitionCount], data);
  }

  public close(): void {
    if (this.closed) return;
    this.descriptors.forEach(closeSync);
    this.closed = true;
  }

  public async records(index: number): Promise<StoredRecord[]> {
    this.close();
    const records: StoredRecord[] = [];
    const lines = createInterface({ input: createReadStream(this.paths[index], { encoding: "utf8" }), crlfDelay: Number.POSITIVE_INFINITY });
    for await (const line of lines) {
      if (line) records.push(JSON.parse(line) as StoredRecord);
    }
    return records;
  }

  public dispose(): void {
    this.close();
    rmSync(this.directory, { recursive: true, force: true });
  }
}

function csvHeader(headers: string[]): string {
  return rowsToCsv(headers, []);
}

async function readHeader(path: string): Promise<string[]> {
  for await (const record of readCsvRecords(path, { delimiter: ",", quote: "\"", allowBlankRows: false }, { maxRecords: 1 })) {
    return record.fields;
  }
  return [];
}

async function countRows(path: string, headers: string[]): Promise<number> {
  let rows = 0;
  let first = true;
  for await (const record of readCsvRecords(path, { delimiter: ",", quote: "\"", allowBlankRows: false })) {
    if (first) {
      first = false;
      continue;
    }
    rows += 1;
    if (record.fields.length !== headers.length) {
      throw new Error(`CSV field-count mismatch at data record ${rows}: expected ${headers.length} fields and found ${record.fields.length}.`);
    }
  }
  return rows;
}

function assertUniqueHeader(headers: string[], side: string): void {
  const seen = new Set<string>();
  headers.forEach((header) => {
    if (seen.has(header)) throw new Error(`${side} CSV contains duplicate column "${header}".`);
    seen.add(header);
  });
}

async function partitionCsv(
  path: string,
  store: PartitionedRecordStore,
  columns: string[],
  headers: string[],
  keyColumns: string[],
  normalization: ComparisonSummary["options"]["normalization"]
): Promise<number> {
  const positions = columns.map((column) => headers.indexOf(column));
  const keyPositions = keyColumns.map((column) => columns.indexOf(column));
  const dates = new Set(normalization.dateColumns);
  const decimals = new Set(normalization.decimalColumns);
  let rows = 0;
  let first = true;
  for await (const record of readCsvRecords(path, { delimiter: ",", quote: "\"", allowBlankRows: false })) {
    if (first) {
      first = false;
      continue;
    }
    rows += 1;
    if (record.fields.length !== headers.length) {
      throw new Error(`CSV field-count mismatch at data record ${rows}: expected ${headers.length} fields and found ${record.fields.length}.`);
    }
    const row = columns.map((column, index) =>
      normalizeComparisonValue(record.fields[positions[index]] ?? "", column, rows, normalization, dates, decimals)
    );
    const key = canonicalValues(keyColumns.length ? keyPositions.map((position) => row[position]) : row);
    store.add({ key, row });
  }
  return rows;
}

function emptyLargeDetails(columns: string[]): ComparisonResult["details"] {
  return {
    columns,
    normalizedRowsTruncated: true,
    detailsTruncated: true,
    normalizedLeftRows: [],
    normalizedRightRows: [],
    leftOnlyRows: [],
    rightOnlyRows: [],
    changedCells: [],
    keysOnlyInLeft: [],
    keysOnlyInRight: [],
    duplicateKeysLeft: [],
    duplicateKeysRight: []
  };
}

function bounded(items: ComparisonDiagnostic[], max: number): ComparisonSummary["diagnostics"] {
  return { total: items.length, included: Math.min(items.length, max), truncated: items.length > max, items: items.slice(0, max) };
}

function reference(key: string): string {
  return `key-${hash(key).toString(16).padStart(8, "0")}`;
}

async function compareLargeFiles(leftPath: string, rightPath: string, options: ComparisonOptions): Promise<ComparisonResult> {
  const [leftHeaders, rightHeaders] = await Promise.all([readHeader(leftPath), readHeader(rightPath)]);
  assertUniqueHeader(leftHeaders, "Left");
  assertUniqueHeader(rightHeaders, "Right");
  const template = compareCsvTexts(csvHeader(leftHeaders), csvHeader(rightHeaders), options);
  if (template.summary.status === "schema-mismatch") {
    const [leftRows, rightRows] = await Promise.all([countRows(leftPath, leftHeaders), countRows(rightPath, rightHeaders)]);
    template.summary.left.rowCount = leftRows;
    template.summary.right.rowCount = rightRows;
    template.details.normalizedRowsTruncated = true;
    template.details.detailsTruncated = true;
    return template;
  }
  const summary = template.summary;
  const details = emptyLargeDetails(summary.columns.comparableColumns);
  const leftStore = new PartitionedRecordStore();
  const rightStore = new PartitionedRecordStore();
  try {
    const [leftRows, rightRows] = await Promise.all([
      partitionCsv(leftPath, leftStore, details.columns, leftHeaders, summary.options.keyColumns, summary.options.normalization),
      partitionCsv(rightPath, rightStore, details.columns, rightHeaders, summary.options.keyColumns, summary.options.normalization)
    ]);
    summary.left.rowCount = leftRows;
    summary.right.rowCount = rightRows;
    const diagnostics: ComparisonDiagnostic[] = [];
    let leftDistinct = 0;
    let rightDistinct = 0;
    let leftDuplicateRows = 0;
    let rightDuplicateRows = 0;
    let added = 0;
    let removed = 0;
    let changed = 0;
    let unchanged = 0;
    let changedCells = 0;
    let duplicateCountDifferences = 0;
    let duplicateKeysLeft = 0;
    let duplicateKeysRight = 0;
    let uniqueKeysLeft = 0;
    let uniqueKeysRight = 0;
    const changedCellsByColumn = { ...summary.differences.changedCellsByColumn };
    const keyColumns = summary.options.keyColumns;
    const businessColumns = details.columns.filter((column) => !keyColumns.includes(column));
    businessColumns.forEach((column) => changedCellsByColumn[column] = 0);
    const businessPositions = businessColumns.map((column) => details.columns.indexOf(column));
    const contextPositions = summary.options.contextColumns.map((column) => details.columns.indexOf(column));

    for (let partition = 0; partition < partitionCount; partition += 1) {
      const [leftRecords, rightRecords] = await Promise.all([leftStore.records(partition), rightStore.records(partition)]);
      const group = (records: StoredRecord[]) => {
        const groups = new Map<string, Array<Array<string | null>>>();
        records.forEach((record) => {
          const rows = groups.get(record.key);
          if (rows) rows.push(record.row);
          else groups.set(record.key, [record.row]);
        });
        return groups;
      };
      const leftGroups = group(leftRecords);
      const rightGroups = group(rightRecords);
      const rowCounts = (records: StoredRecord[]) => {
        const counts = new Map<string, number>();
        records.forEach((record) => {
          const row = canonicalValues(record.row);
          counts.set(row, (counts.get(row) ?? 0) + 1);
        });
        return counts;
      };
      const leftRowCounts = rowCounts(leftRecords);
      const rightRowCounts = rowCounts(rightRecords);
      leftDistinct += leftRowCounts.size;
      rightDistinct += rightRowCounts.size;
      leftDuplicateRows += [...leftRowCounts.values()].filter((count) => count > 1).length;
      rightDuplicateRows += [...rightRowCounts.values()].filter((count) => count > 1).length;
      const allKeys = [...new Set([...leftGroups.keys(), ...rightGroups.keys()])].sort();
      for (const key of allKeys) {
        const leftGroup = leftGroups.get(key);
        const rightGroup = rightGroups.get(key);
        const keyRef = reference(key);
        if (!keyColumns.length) {
          const leftCount = leftGroup?.length ?? 0;
          const rightCount = rightGroup?.length ?? 0;
          unchanged += Math.min(leftCount, rightCount);
          if (leftCount === rightCount) continue;
          duplicateCountDifferences += 1;
          added += Math.max(0, rightCount - leftCount);
          removed += Math.max(0, leftCount - rightCount);
          diagnostics.push({
            id: `${keyRef}-count`,
            kind: leftCount === 0 ? "row-added" : rightCount === 0 ? "row-removed" : "row-count-changed",
            count: Math.abs(leftCount - rightCount)
          });
          continue;
        }
        if (leftGroup?.length === 1) uniqueKeysLeft += 1;
        if (rightGroup?.length === 1) uniqueKeysRight += 1;
        if (leftGroup && leftGroup.length > 1) {
          duplicateKeysLeft += 1;
          const includedRows = details.duplicateKeysLeft.reduce((count, group) => count + group.rows.length, 0);
          const remainingRows = Math.max(0, summary.options.maxDiagnostics - includedRows);
          const duplicate: DuplicateKeyGroup = { keyReference: keyRef, keyValues: keyColumns.map((_, index) => leftGroup[0][details.columns.indexOf(keyColumns[index])]), rows: leftGroup.slice(0, remainingRows) };
          if (duplicate.rows.length) details.duplicateKeysLeft.push(duplicate);
          diagnostics.push({ id: `${keyRef}-duplicate-left`, kind: "duplicate-key-left", count: leftGroup.length, keyReference: keyRef });
        }
        if (rightGroup && rightGroup.length > 1) {
          duplicateKeysRight += 1;
          const includedRows = details.duplicateKeysRight.reduce((count, group) => count + group.rows.length, 0);
          const remainingRows = Math.max(0, summary.options.maxDiagnostics - includedRows);
          const duplicate: DuplicateKeyGroup = { keyReference: keyRef, keyValues: keyColumns.map((_, index) => rightGroup[0][details.columns.indexOf(keyColumns[index])]), rows: rightGroup.slice(0, remainingRows) };
          if (duplicate.rows.length) details.duplicateKeysRight.push(duplicate);
          diagnostics.push({ id: `${keyRef}-duplicate-right`, kind: "duplicate-key-right", count: rightGroup.length, keyReference: keyRef });
        }
        if (!leftGroup && rightGroup) {
          added += rightGroup.length;
          if (details.keysOnlyInRight.length < summary.options.maxDiagnostics) details.keysOnlyInRight.push({ keyReference: keyRef, keyValues: keyColumns.map((column) => rightGroup[0][details.columns.indexOf(column)]), contextValues: contextPositions.map((position) => rightGroup[0][position]), count: rightGroup.length });
          diagnostics.push({ id: `${keyRef}-added`, kind: "key-added", count: rightGroup.length, keyReference: keyRef });
          continue;
        }
        if (leftGroup && !rightGroup) {
          removed += leftGroup.length;
          if (details.keysOnlyInLeft.length < summary.options.maxDiagnostics) details.keysOnlyInLeft.push({ keyReference: keyRef, keyValues: keyColumns.map((column) => leftGroup[0][details.columns.indexOf(column)]), contextValues: contextPositions.map((position) => leftGroup[0][position]), count: leftGroup.length });
          diagnostics.push({ id: `${keyRef}-removed`, kind: "key-removed", count: leftGroup.length, keyReference: keyRef });
          continue;
        }
        if (!leftGroup || !rightGroup || leftGroup.length !== 1 || rightGroup.length !== 1) continue;
        let keyChanged = false;
        businessPositions.forEach((position, index) => {
          if (leftGroup[0][position] === rightGroup[0][position]) return;
          keyChanged = true;
          changedCells += 1;
          changedCellsByColumn[businessColumns[index]] += 1;
          if (details.changedCells.length < summary.options.maxDiagnostics) details.changedCells.push({
            keyReference: keyRef,
            keyValues: keyColumns.map((column) => leftGroup[0][details.columns.indexOf(column)]),
            contextValues: contextPositions.map((contextPosition) => rightGroup[0][contextPosition]),
            column: businessColumns[index],
            leftValue: leftGroup[0][position],
            rightValue: rightGroup[0][position]
          });
        });
        if (keyChanged) {
          changed += 1;
          diagnostics.push({ id: `${keyRef}-changed`, kind: "key-changed", count: 1, keyReference: keyRef });
        } else unchanged += 1;
      }
    }
    summary.left.distinctRowCount = leftDistinct;
    summary.right.distinctRowCount = rightDistinct;
    summary.left.duplicateRowGroups = leftDuplicateRows;
    summary.right.duplicateRowGroups = rightDuplicateRows;
    summary.left.uniqueKeyCount = keyColumns.length ? uniqueKeysLeft : null;
    summary.right.uniqueKeyCount = keyColumns.length ? uniqueKeysRight : null;
    summary.left.duplicateKeyCount = keyColumns.length ? duplicateKeysLeft : null;
    summary.right.duplicateKeyCount = keyColumns.length ? duplicateKeysRight : null;
    summary.differences = {
      added, removed, changed, unchanged, changedCells, schemaChanges: 0,
      duplicateRowCountDifferences: duplicateCountDifferences,
      duplicateKeysLeft, duplicateKeysRight, changedCellsByColumn
    };
    const hasDuplicates = duplicateKeysLeft > 0 || duplicateKeysRight > 0;
    summary.semanticEqual = !hasDuplicates && !added && !removed && !changedCells;
    summary.status = hasDuplicates ? "duplicate-keys" : summary.semanticEqual ? "equal" : "different";
    summary.exitCode = hasDuplicates ? 4 : summary.semanticEqual ? 0 : 1;
    summary.diagnostics = bounded(diagnostics, summary.options.maxDiagnostics);
    return { summary, details };
  } finally {
    leftStore.dispose();
    rightStore.dispose();
  }
}

export async function compareCsvFilesDesktop(
  leftUri: vscode.Uri,
  rightUri: vscode.Uri,
  options: ComparisonOptions
): Promise<ComparisonResult> {
  return compareCsvPathsDesktop(leftUri.fsPath, rightUri.fsPath, options);
}

export async function compareCsvPathsDesktop(
  leftPath: string,
  rightPath: string,
  options: ComparisonOptions,
  maxInMemoryBytes = inMemoryBytes
): Promise<ComparisonResult> {
  if (statSync(leftPath).size <= maxInMemoryBytes && statSync(rightPath).size <= maxInMemoryBytes) {
    return compareCsvTexts(readFileSync(leftPath, "utf8"), readFileSync(rightPath, "utf8"), options);
  }
  return compareLargeFiles(leftPath, rightPath, options);
}

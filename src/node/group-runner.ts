import { closeSync, mkdtempSync, openSync, rmSync, writeSync, createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import Papa from "papaparse";
import type { CsvOptions, GroupTest, ValidationIssue, ValidationResult } from "../core/model";
import type { OrderedRow } from "../core/ordered-rule";
import { validateCsv } from "../core/contract";
import { RowSortStore } from "./row-sort-store";

const inMemoryGroupRows = 5000;
const inMemoryGroupBytes = 4 * 1024 * 1024;

export interface GroupSummary {
  issues: ValidationIssue[];
  issueCount: number;
  errorCount: number;
  warningCount: number;
  testCount: number;
  ruleOutcomes: NonNullable<ValidationResult["ruleOutcomes"]>;
  nestedGroupOutcomes: NonNullable<ValidationResult["groupOutcomes"]>;
  groupCounts: Array<{ id: string; count: number }>;
  passedGroups: number;
  failedGroups: number;
}

function normalized(value: string, options: CsvOptions): string {
  const trimmed = options.trimValues ? value.trim() : value;
  return options.caseSensitive === false ? trimmed.toLowerCase() : trimmed;
}

function key(row: OrderedRow, columns: string[], options: CsvOptions): string {
  return JSON.stringify(columns.map(c => normalized(row.values[c] ?? "", options)));
}

async function sourceRows(path: string, wanted: Set<number>): Promise<Map<number, number>> {
  const found = new Map<number, number>();
  if (!wanted.size) return found;
  let childRow = 2;
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    if (wanted.has(childRow)) found.set(childRow, Number(line));
    if (found.size === wanted.size) break;
    childRow++;
  }
  lines.close();
  return found;
}

export class GroupTestRunner {
  private readonly store: RowSortStore;
  private readonly options: CsvOptions;

  public constructor(private readonly group: GroupTest, private readonly headers: string[],
    options: CsvOptions, private readonly source: string, private readonly tempRoot?: string) {
    if (!group.resolvedContract && !group.contract) throw new Error(`Group test ${group.id} has an unresolved child contract.`);
    for (const column of group.groupBy) if (!headers.includes(column)) throw new Error(`Group test ${group.id} requires missing column ${column}.`);
    this.options = options;
    this.store = new RowSortStore((a, b) => key(a, group.groupBy, options).localeCompare(key(b, group.groupBy, options)) || a.row - b.row, tempRoot);
  }

  public add(row: number, fields: string[]): void {
    this.store.add({ row, values: Object.fromEntries(this.headers.map((header, index) => [header, fields[index] ?? ""])) });
  }

  public async finish(maxIssues: number): Promise<GroupSummary> {
    const directory = mkdtempSync(join(resolve(this.tempRoot ?? tmpdir()), "csv-contract-group-"));
    const summary: GroupSummary = { issues: [], issueCount: 0, errorCount: 0, warningCount: 0,
      testCount: 1, ruleOutcomes: [], nestedGroupOutcomes: [], groupCounts: [{ id: this.group.id, count: 0 }], passedGroups: 0, failedGroups: 0 };
    const add = (issue: ValidationIssue): void => {
      summary.issueCount++;
      if (issue.severity === "warning") summary.warningCount++;
      else summary.errorCount++;
      if (summary.issues.length < maxIssues) summary.issues.push(issue);
    };
    const csvPath = join(directory, "group.csv");
    const mapPath = join(directory, "rows.txt");
    let csvFd: number | undefined;
    let mapFd: number | undefined;
    let groupOpen = false;
    let memoryRows: OrderedRow[] = [];
    let memoryBytes = 0;
    let currentKey: string | undefined;
    let currentGroup: Record<string, string> = {};
    let hasRows = false;
    const openGroup = (row?: OrderedRow): void => {
      groupOpen = true;
      memoryRows = [];
      memoryBytes = 0;
      currentGroup = Object.fromEntries(this.group.groupBy.map(c => [c, row?.values[c] ?? ""]));
      summary.groupCounts[0].count++;
    };
    const writeRow = (row: OrderedRow): void => {
      writeSync(csvFd!, Papa.unparse([this.headers.map(h => row.values[h] ?? "")]) + "\n");
      writeSync(mapFd!, String(row.row) + "\n");
    };
    const spillGroup = (): void => {
      csvFd = openSync(csvPath, "w"); mapFd = openSync(mapPath, "w");
      writeSync(csvFd, Papa.unparse([this.headers]) + "\n");
      memoryRows.forEach(writeRow);
      memoryRows = [];
      memoryBytes = 0;
    };
    const closeGroup = async (): Promise<void> => {
      if (!groupOpen) return;
      groupOpen = false;
      const child = (this.group.resolvedContract ?? this.group.contract)!;
      const normalizedChild = { ...child, csv: { ...child.csv, delimiter: ",", quote: "\"", header: "required" as const } };
      let result: ValidationResult;
      let rowMap: Map<number, number>;
      if (csvFd === undefined || mapFd === undefined) {
        const csv = Papa.unparse({ fields: this.headers, data: memoryRows.map(row => this.headers.map(h => row.values[h] ?? "")) });
        result = validateCsv(normalizedChild, csv);
        rowMap = new Map(memoryRows.map((row, index) => [index + 2, row.row]));
      } else {
        closeSync(csvFd); closeSync(mapFd); csvFd = undefined; mapFd = undefined;
        const { validateCsvFile } = await import("./streaming-validator");
        const run = await validateCsvFile(csvPath, [{ spec: this.group.resolvedSource ?? (this.source === "<sql-contract>" ? csvPath : this.source), contract: normalizedChild }],
          { maxIssues, tempDirectory: this.tempRoot });
        result = run.runs[0].result;
        const wanted = new Set(result.issues.flatMap(issue => [...(issue.row === undefined ? [] : [issue.row]), ...(issue.relatedRows ?? [])]));
        rowMap = await sourceRows(mapPath, wanted);
      }
      if (result.valid) summary.passedGroups++;
      else summary.failedGroups++;
      summary.testCount = Math.max(summary.testCount, 1 + result.testCount);
      for (const outcome of result.ruleOutcomes ?? []) {
        const id = `${this.group.id}/${outcome.id}`;
        const aggregate = summary.ruleOutcomes.find(item => item.id === id);
        if (aggregate) { aggregate.selected += outcome.selected; aggregate.passed += outcome.passed; aggregate.failed += outcome.failed; }
        else summary.ruleOutcomes.push({ ...outcome, id });
      }
      for (const outcome of result.groupOutcomes ?? []) {
        const id = `${this.group.id}/${outcome.id}`;
        const aggregate = summary.nestedGroupOutcomes.find(item => item.id === id);
        if (aggregate) { aggregate.groups += outcome.groups; aggregate.passed += outcome.passed; aggregate.failed += outcome.failed; }
        else summary.nestedGroupOutcomes.push({ ...outcome, id });
      }
      summary.issueCount += result.issueCount;
      summary.errorCount += result.errorCount;
      summary.warningCount += result.warningCount;
      for (const issue of result.issues) if (summary.issues.length < maxIssues) summary.issues.push({ ...issue,
        testId: issue.testId ? `${this.group.id}/${issue.testId}` : this.group.id,
        group: { ...currentGroup, ...issue.group }, row: issue.row === undefined ? undefined : rowMap.get(issue.row) ?? issue.row,
        relatedRows: issue.relatedRows?.map(row => rowMap.get(row) ?? row),
        message: `${this.group.id} ${JSON.stringify(currentGroup)}: ${issue.message}` });
    };
    try {
      for await (const row of this.store.rows()) {
        hasRows = true;
        const nextKey = key(row, this.group.groupBy, this.options);
        if (nextKey !== currentKey) { await closeGroup(); openGroup(row); currentKey = nextKey; }
        if (csvFd !== undefined) writeRow(row);
        else {
          memoryRows.push(row);
          memoryBytes += this.headers.reduce((bytes, h) => bytes + (row.values[h]?.length ?? 0), 0);
          if (memoryRows.length > inMemoryGroupRows || memoryBytes > inMemoryGroupBytes) spillGroup();
        }
      }
      if (!hasRows && this.group.groupBy.length === 0) openGroup();
      await closeGroup();
      const count = summary.groupCounts[0].count;
      for (const [kind, expected] of Object.entries(this.group.groupCount ?? {})) {
        if (kind === "exact" && count === expected || kind === "min" && count >= expected || kind === "max" && count <= expected) continue;
        add({ level: "file", code: "GROUP_COUNT", testId: this.group.id,
          message: `Group test ${this.group.id} found ${count} groups; expected ${kind} ${expected}.`, actual: count, expected });
      }
      return summary;
    } finally {
      if (csvFd !== undefined) closeSync(csvFd);
      if (mapFd !== undefined) closeSync(mapFd);
      this.store.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  }

  public dispose(): void { this.store.dispose(); }
}

import { stat } from "node:fs/promises";
import type {
  ColumnConstraints,
  CountExpectation,
  CsvContract,
  CsvOptions,
  RowTest,
  ValidationIssue,
  ValidationPerformance,
  ValidationResult
} from "../core/model";
import { readCsvRecords, type CsvPhysicalOptions } from "./csv-stream";
import { PartitionedUniquenessStore, type DuplicateValue } from "./uniqueness-store";

const csvDefaults: Required<CsvOptions> = {
  delimiter: ",",
  encoding: "utf-8",
  quote: "\"",
  header: "required",
  nullValues: [""],
  trimValues: false,
  caseSensitive: true,
  allowBlankRows: false,
  allowRaggedRows: false
};

export interface ContractRunInput {
  spec: string;
  contract: CsvContract;
}

export interface ContractRunOutput {
  spec: string;
  result: ValidationResult;
}

export interface StreamingValidationOutput {
  valid: boolean;
  runs: ContractRunOutput[];
  performance: ValidationPerformance;
}

export interface StreamingValidationOptions {
  maxIssues?: number;
  progressInterval?: number;
  tempDirectory?: string;
  uniquePartitions?: number;
  onProgress?: (progress: { pass: number; passes: number; rows: number; bytesRead: number }) => void;
}

class IssueCollector {
  public readonly issues: ValidationIssue[] = [];
  public total = 0;

  public constructor(private readonly maximum: number) {}

  public add(issue: ValidationIssue): void {
    this.total += 1;
    if (this.issues.length < this.maximum) this.issues.push(issue);
  }

  public addAll(issues: ValidationIssue[]): void {
    issues.forEach((issue) => this.add(issue));
  }
}

interface PreparedColumn {
  name: string;
  index: number;
  constraints: ColumnConstraints;
  allowedValues?: Set<string>;
  expression?: RegExp;
  uniqueTargetId?: number;
}

interface PreparedRowTest {
  test: RowTest;
  valid: boolean;
  matchCount: number;
  selectors: Array<{ index: number; expected: string }>;
  cells: Array<{ index: number; column: string; expected: string }>;
}

interface UniqueCheck {
  targetId: number;
  kind: "column" | "identity";
  state: ContractState;
  column?: string;
  indexes: number[];
}

interface ContractState {
  input: ContractRunInput;
  options: Required<CsvOptions>;
  collector: IssueCollector;
  headers: string[];
  headerIndex: Map<string, number>;
  declared: Set<string>;
  columns: PreparedColumn[];
  rowTests: PreparedRowTest[];
  identity?: UniqueCheck;
  rowCount: number;
  initialized: boolean;
  nullValues: Set<string>;
}

function resolveOptions(contract: CsvContract): Required<CsvOptions> {
  return { ...csvDefaults, ...(contract.csv ?? {}) };
}

function physicalOptions(options: Required<CsvOptions>): CsvPhysicalOptions {
  return {
    delimiter: options.delimiter,
    quote: options.quote,
    allowBlankRows: options.allowBlankRows
  };
}

function physicalKey(options: Required<CsvOptions>): string {
  return JSON.stringify(physicalOptions(options));
}

function normalize(value: string, options: Required<CsvOptions>): string {
  const effective = options.trimValues ? value.trim() : value;
  return options.caseSensitive ? effective : effective.toLowerCase();
}

function displayValue(value: string): string {
  return value.length <= 160 ? value : `${value.slice(0, 157)}...`;
}

function countIssues(
  name: string,
  actual: number,
  expectation: CountExpectation | undefined,
  level: "file" | "row",
  testId?: string
): ValidationIssue[] {
  if (!expectation) return [];
  const issues: ValidationIssue[] = [];
  if (expectation.exact !== undefined && actual !== expectation.exact) {
    issues.push({ level, code: `${name.toUpperCase()}_EXACT`, message: `${name} is ${actual}; expected exactly ${expectation.exact}.`, actual, expected: expectation.exact, testId });
  }
  if (expectation.min !== undefined && actual < expectation.min) {
    issues.push({ level, code: `${name.toUpperCase()}_MIN`, message: `${name} is ${actual}; expected at least ${expectation.min}.`, actual, expected: expectation.min, testId });
  }
  if (expectation.max !== undefined && actual > expectation.max) {
    issues.push({ level, code: `${name.toUpperCase()}_MAX`, message: `${name} is ${actual}; expected at most ${expectation.max}.`, actual, expected: expectation.max, testId });
  }
  return issues;
}

function createState(input: ContractRunInput, maxIssues: number): ContractState {
  const options = resolveOptions(input.contract);
  return {
    input,
    options,
    collector: new IssueCollector(maxIssues),
    headers: [],
    headerIndex: new Map(),
    declared: new Set(Object.keys(input.contract.schema.columns)),
    columns: [],
    rowTests: [],
    rowCount: 0,
    initialized: false,
    nullValues: new Set(options.nullValues.map((value) => normalize(value, options)))
  };
}

function isNull(state: ContractState, value: string): boolean {
  return state.nullValues.has(normalize(value, state.options));
}

function initializeState(
  state: ContractState,
  rawHeaders: string[],
  nextUniqueTarget: () => number,
  uniqueChecks: Map<number, UniqueCheck>
): void {
  const { contract } = state.input;
  state.headers = rawHeaders.map((header) => state.options.trimValues ? header.trim() : header);
  state.headers.forEach((header, index) => {
    if (!state.headerIndex.has(header)) state.headerIndex.set(header, index);
  });
  const headerCounts = new Map<string, number>();
  state.headers.forEach((header) => headerCounts.set(header, (headerCounts.get(header) ?? 0) + 1));
  for (const [header, count] of headerCounts) {
    if (count > 1) {
      state.collector.add({ level: "file", code: "DUPLICATE_HEADER", message: `Header "${header}" appears more than once.`, column: header });
    }
  }
  state.collector.addAll(countIssues("column_count", state.headers.length, contract.schema.columnCount, "file"));

  for (const [name, definition] of Object.entries(contract.schema.columns)) {
    const index = state.headerIndex.get(name);
    if (index === undefined) {
      if (definition.presence === "required") {
        state.collector.add({ level: "column", code: "REQUIRED_COLUMN_MISSING", message: `Required column "${name}" is missing.`, column: name });
      }
      continue;
    }
    const constraints = definition.constraints ?? {};
    const prepared: PreparedColumn = {
      name,
      index,
      constraints,
      allowedValues: constraints.allowedValues
        ? new Set(constraints.allowedValues.map((value) => normalize(value, state.options)))
        : undefined
    };
    if (constraints.matches) {
      try {
        prepared.expression = new RegExp(constraints.matches, state.options.caseSensitive ? "" : "i");
      } catch (error) {
        state.collector.add({ level: "column", code: "INVALID_REGEX", message: `"${name}" has an invalid regex: ${String(error)}`, column: name });
      }
    }
    if (constraints.unique) {
      const targetId = nextUniqueTarget();
      prepared.uniqueTargetId = targetId;
      uniqueChecks.set(targetId, { targetId, kind: "column", state, column: name, indexes: [index] });
    }
    state.columns.push(prepared);
  }

  if (contract.schema.allowAdditionalColumns === false) {
    for (const header of state.headers) {
      if (!state.declared.has(header)) {
        state.collector.add({ level: "column", code: "ADDITIONAL_COLUMN", message: `Undeclared column "${header}" is not allowed.`, column: header });
      }
    }
  }

  if (contract.identity) {
    const missing = contract.identity.columns.filter((name) => !state.declared.has(name) || !state.headerIndex.has(name));
    missing.forEach((name) => state.collector.add({ level: "column", code: "IDENTITY_COLUMN_MISSING", message: `Identity column "${name}" must be declared and present.`, column: name }));
    if (contract.identity.unique !== false && missing.length === 0) {
      const targetId = nextUniqueTarget();
      const identity: UniqueCheck = {
        targetId,
        kind: "identity",
        state,
        indexes: contract.identity.columns.map((name) => state.headerIndex.get(name)!)
      };
      state.identity = identity;
      uniqueChecks.set(targetId, identity);
    }
  }

  const testIds = new Set<string>();
  for (const test of contract.rowTests ?? []) {
    let valid = true;
    if (testIds.has(test.id)) {
      state.collector.add({ level: "row", code: "DUPLICATE_TEST_ID", message: `Row test id "${test.id}" is duplicated.`, testId: test.id });
      valid = false;
    }
    testIds.add(test.id);
    const references = [...Object.keys(test.select), ...Object.keys(test.expect.cells ?? {})];
    for (const column of references) {
      if (!state.declared.has(column)) {
        state.collector.add({ level: "row", code: "UNDECLARED_TEST_COLUMN", message: `Test "${test.id}" references undeclared column "${column}".`, column, testId: test.id });
        valid = false;
      } else if (!state.headerIndex.has(column)) {
        state.collector.add({ level: "row", code: "TEST_COLUMN_MISSING", message: `Test "${test.id}" references optional column "${column}", but it is absent from this CSV.`, column, testId: test.id });
        valid = false;
      }
    }
    state.rowTests.push({
      test,
      valid,
      matchCount: 0,
      selectors: valid
        ? Object.entries(test.select).map(([column, expected]) => ({ index: state.headerIndex.get(column)!, expected: normalize(expected, state.options) }))
        : [],
      cells: valid
        ? Object.entries(test.expect.cells ?? {}).map(([column, expectation]) => ({ index: state.headerIndex.get(column)!, column, expected: normalize(expectation.equals, state.options) }))
        : []
    });
  }
  state.initialized = true;
}

function processRow(state: ContractState, fields: string[], recordNumber: number, uniqueness?: PartitionedUniquenessStore): void {
  state.rowCount += 1;
  if (!state.options.allowRaggedRows && fields.length !== state.headers.length) {
    state.collector.add({
      level: "file",
      code: "RAGGED_ROW",
      message: `CSV record ${recordNumber} has ${fields.length} cells; expected ${state.headers.length}.`,
      row: recordNumber,
      actual: fields.length,
      expected: state.headers.length
    });
  }

  for (const column of state.columns) {
    const raw = fields[column.index] ?? "";
    const value = state.options.trimValues ? raw.trim() : raw;
    const nullValue = isNull(state, value);
    if (column.constraints.notNull && nullValue) {
      state.collector.add({ level: "cell", code: "NULL_VALUE", message: `"${column.name}" contains a configured null value.`, column: column.name, row: recordNumber });
    }
    if (nullValue) continue;
    if (column.constraints.minLength !== undefined && value.length < column.constraints.minLength) {
      state.collector.add({ level: "cell", code: "MIN_LENGTH", message: `"${column.name}" is shorter than ${column.constraints.minLength} characters.`, column: column.name, row: recordNumber, actual: value.length, expected: column.constraints.minLength });
    }
    if (column.constraints.maxLength !== undefined && value.length > column.constraints.maxLength) {
      state.collector.add({ level: "cell", code: "MAX_LENGTH", message: `"${column.name}" exceeds ${column.constraints.maxLength} characters.`, column: column.name, row: recordNumber, actual: value.length, expected: column.constraints.maxLength });
    }
    const normalized = normalize(value, state.options);
    if (column.allowedValues && !column.allowedValues.has(normalized)) {
      state.collector.add({ level: "cell", code: "NOT_ALLOWED", message: `"${column.name}" value "${displayValue(value)}" is not allowed.`, column: column.name, row: recordNumber, actual: displayValue(value) });
    }
    if (column.expression && !column.expression.test(value)) {
      state.collector.add({ level: "cell", code: "REGEX_MISMATCH", message: `"${column.name}" value "${displayValue(value)}" does not match ${column.constraints.matches}.`, column: column.name, row: recordNumber, actual: displayValue(value) });
    }
    if (column.uniqueTargetId !== undefined) uniqueness?.add(column.uniqueTargetId, normalized, recordNumber);
  }

  if (state.identity && uniqueness) {
    const values = state.identity.indexes.map((index) => normalize(fields[index] ?? "", state.options));
    const identityKey = values.map((value) => `${value.length}:${value}`).join("");
    uniqueness.add(state.identity.targetId, identityKey, recordNumber);
  }

  for (const prepared of state.rowTests) {
    if (!prepared.valid) continue;
    const matches = prepared.selectors.every(({ index, expected }) => normalize(fields[index] ?? "", state.options) === expected);
    if (!matches) continue;
    prepared.matchCount += 1;
    for (const cell of prepared.cells) {
      const actual = state.options.trimValues ? (fields[cell.index] ?? "").trim() : (fields[cell.index] ?? "");
      if (normalize(actual, state.options) !== cell.expected) {
        const expected = prepared.test.expect.cells![cell.column].equals;
        state.collector.add({
          level: "cell",
          code: "CELL_NOT_EQUAL",
          message: `Test "${prepared.test.id}" expected "${cell.column}" to equal "${displayValue(expected)}", found "${displayValue(actual)}".`,
          column: cell.column,
          row: recordNumber,
          testId: prepared.test.id,
          actual: displayValue(actual),
          expected: displayValue(expected)
        });
      }
    }
  }
}

function addDuplicateIssue(duplicate: DuplicateValue, checks: Map<number, UniqueCheck>): void {
  const check = checks.get(duplicate.targetId);
  if (!check) throw new Error(`Unknown uniqueness target ${duplicate.targetId}.`);
  if (check.kind === "column") {
    check.state.collector.add({
      level: "cell",
      code: "NOT_UNIQUE",
      message: `"${check.column}" duplicates CSV record ${duplicate.firstRow}.`,
      column: check.column,
      row: duplicate.row,
      actual: displayValue(duplicate.value)
    });
  } else {
    check.state.collector.add({
      level: "row",
      code: "IDENTITY_NOT_UNIQUE",
      message: `Composite identity duplicates CSV record ${duplicate.firstRow}.`,
      row: duplicate.row
    });
  }
}

function finalizeState(state: ContractState): ContractRunOutput {
  state.collector.addAll(countIssues("row_count", state.rowCount, state.input.contract.schema.rowCount, "file"));
  for (const prepared of state.rowTests) {
    if (prepared.valid) {
      state.collector.addAll(countIssues("match_count", prepared.matchCount, prepared.test.expect.count ?? { exact: 1 }, "row", prepared.test.id));
    }
  }
  return {
    spec: state.input.spec,
    result: {
      valid: state.collector.total === 0,
      rowCount: state.rowCount,
      columnCount: state.headers.length,
      testCount: Object.keys(state.input.contract.schema.columns).length + (state.input.contract.rowTests?.length ?? 0),
      issueCount: state.collector.total,
      truncated: state.collector.total > state.collector.issues.length,
      issues: state.collector.issues
    }
  };
}

async function validateGroup(
  csvPath: string,
  inputs: ContractRunInput[],
  groupPass: number,
  totalPasses: number,
  options: Required<Pick<StreamingValidationOptions, "maxIssues" | "progressInterval" | "uniquePartitions">> & StreamingValidationOptions
): Promise<ContractRunOutput[]> {
  const states = inputs.map((input) => createState(input, options.maxIssues));
  const uniqueChecks = new Map<number, UniqueCheck>();
  let nextTarget = 0;
  const getNextTarget = (): number => {
    if (nextTarget >= 65535) throw new Error("Too many uniqueness checks in one validation pass.");
    return nextTarget++;
  };
  let uniqueness: PartitionedUniquenessStore | undefined;
  let foundHeader = false;
  const physical = physicalOptions(states[0].options);
  try {
    for await (const record of readCsvRecords(csvPath, physical, {
      progressInterval: options.progressInterval,
      onProgress: ({ bytesRead, recordsRead }) => options.onProgress?.({
        pass: groupPass,
        passes: totalPasses,
        rows: Math.max(0, recordsRead - 1),
        bytesRead
      })
    })) {
      if (!foundHeader) {
        foundHeader = true;
        states.forEach((state) => initializeState(state, record.fields, getNextTarget, uniqueChecks));
        if (uniqueChecks.size > 0) {
          uniqueness = new PartitionedUniquenessStore(options.tempDirectory, options.uniquePartitions);
        }
        continue;
      }
      states.forEach((state) => processRow(state, record.fields, record.recordNumber, uniqueness));
    }
    if (!foundHeader) {
      states.forEach((state) => {
        initializeState(state, [], getNextTarget, uniqueChecks);
        state.collector.add({ level: "file", code: "CSV_EMPTY", message: "CSV is empty." });
      });
    }
    await uniqueness?.findDuplicates((duplicate) => addDuplicateIssue(duplicate, uniqueChecks));
    return states.map(finalizeState);
  } finally {
    uniqueness?.dispose();
  }
}

export async function validateCsvFile(
  csvPath: string,
  inputs: ContractRunInput[],
  options: StreamingValidationOptions = {}
): Promise<StreamingValidationOutput> {
  if (inputs.length === 0) throw new Error("At least one contract is required.");
  const resolved = {
    ...options,
    maxIssues: options.maxIssues ?? 1000,
    progressInterval: options.progressInterval ?? 250000,
    uniquePartitions: options.uniquePartitions ?? 128
  };
  if (!Number.isInteger(resolved.maxIssues) || resolved.maxIssues < 1) throw new Error("maxIssues must be a positive integer.");
  const file = await stat(csvPath);
  const started = performance.now();
  const groups = new Map<string, ContractRunInput[]>();
  inputs.forEach((input) => {
    const key = physicalKey(resolveOptions(input.contract));
    const group = groups.get(key) ?? [];
    group.push(input);
    groups.set(key, group);
  });
  const runs: ContractRunOutput[] = [];
  let pass = 0;
  for (const group of groups.values()) {
    pass += 1;
    runs.push(...await validateGroup(csvPath, group, pass, groups.size, resolved));
  }
  const durationMs = performance.now() - started;
  const totalRows = Math.max(...runs.map((run) => run.result.rowCount));
  return {
    valid: runs.every((run) => run.result.valid),
    runs: inputs.map((input) => runs.find((run) => run.spec === input.spec)!),
    performance: {
      bytesRead: file.size * groups.size,
      durationMs,
      rowsPerSecond: durationMs > 0 ? Math.round(totalRows / (durationMs / 1000)) : totalRows,
      maxRssBytes: process.resourceUsage().maxRSS * 1024,
      passes: groups.size
    }
  };
}

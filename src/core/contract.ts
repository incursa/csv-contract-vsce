import Papa from "papaparse";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type {
  CountExpectation,
  CsvContract,
  CsvOptions,
  ParsedCsv,
  ValidationIssue,
  ValidationResult
} from "./model";

const defaults: Required<CsvOptions> = {
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

export function parseContract(text: string): CsvContract {
  const value = parseYaml(text) as CsvContract;
  if (!value || value.version !== 1 || !value.schema?.columns) {
    throw new Error("The contract must declare version: 1 and schema.columns.");
  }
  return value;
}

export function serializeContract(contract: CsvContract, schemaPath = "./schemas/csvtest.schema.json"): string {
  return `# yaml-language-server: $schema=${schemaPath}\n${stringifyYaml(contract, { lineWidth: 110 })}`;
}

export function parseCsv(text: string, options: CsvOptions = {}): ParsedCsv {
  const config = { ...defaults, ...options };
  const parsed = Papa.parse<string[]>(text, {
    delimiter: config.delimiter,
    quoteChar: config.quote,
    skipEmptyLines: config.allowBlankRows ? false : "greedy"
  });
  const data = parsed.data.map((row) => row.map((cell) => config.trimValues ? cell.trim() : cell));
  const parseErrors = parsed.errors.map((error) => `CSV row ${(error.row ?? 0) + 1}: ${error.message}`);
  if (data.length === 0) {
    return { headers: [], rows: [], sourceRowNumbers: [], parseErrors: [...parseErrors, "CSV is empty."] };
  }
  const headers = data[0];
  const rows = data.slice(1);
  if (!config.allowRaggedRows) {
    rows.forEach((row, index) => {
      if (row.length !== headers.length) {
        parseErrors.push(`CSV row ${index + 2} has ${row.length} cells; expected ${headers.length}.`);
      }
    });
  }
  return {
    headers,
    rows,
    sourceRowNumbers: rows.map((_, index) => index + 2),
    parseErrors
  };
}

function normalized(value: string, options: Required<CsvOptions>): string {
  const trimmed = options.trimValues ? value.trim() : value;
  return options.caseSensitive ? trimmed : trimmed.toLocaleLowerCase();
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

function isNull(value: string, options: Required<CsvOptions>): boolean {
  const candidate = normalized(value, options);
  return options.nullValues.some((item) => normalized(item, options) === candidate);
}

export function validateCsv(contract: CsvContract, csvText: string): ValidationResult {
  const options = { ...defaults, ...(contract.csv ?? {}) };
  const parsed = parseCsv(csvText, options);
  const issues: ValidationIssue[] = parsed.parseErrors.map((message) => ({ level: "file", code: "CSV_PARSE", message }));
  const duplicateHeaders = parsed.headers.filter((header, index) => parsed.headers.indexOf(header) !== index);
  for (const header of [...new Set(duplicateHeaders)]) {
    issues.push({ level: "file", code: "DUPLICATE_HEADER", message: `Header "${header}" appears more than once.`, column: header });
  }

  issues.push(...countIssues("row_count", parsed.rows.length, contract.schema.rowCount, "file"));
  issues.push(...countIssues("column_count", parsed.headers.length, contract.schema.columnCount, "file"));

  const headerIndex = new Map(parsed.headers.map((header, index) => [header, index]));
  const declared = new Set(Object.keys(contract.schema.columns));
  for (const [column, definition] of Object.entries(contract.schema.columns)) {
    const index = headerIndex.get(column);
    if (index === undefined) {
      if (definition.presence === "required") {
        issues.push({ level: "column", code: "REQUIRED_COLUMN_MISSING", message: `Required column "${column}" is missing.`, column });
      }
      continue;
    }
    const constraints = definition.constraints ?? {};
    const values = parsed.rows.map((row) => row[index] ?? "");
    values.forEach((value, rowIndex) => {
      const nullValue = isNull(value, options);
      const row = parsed.sourceRowNumbers[rowIndex];
      if (constraints.notNull && nullValue) {
        issues.push({ level: "cell", code: "NULL_VALUE", message: `"${column}" contains a configured null value.`, column, row });
      }
      if (nullValue) return;
      if (constraints.minLength !== undefined && value.length < constraints.minLength) {
        issues.push({ level: "cell", code: "MIN_LENGTH", message: `"${column}" is shorter than ${constraints.minLength} characters.`, column, row, actual: value.length, expected: constraints.minLength });
      }
      if (constraints.maxLength !== undefined && value.length > constraints.maxLength) {
        issues.push({ level: "cell", code: "MAX_LENGTH", message: `"${column}" exceeds ${constraints.maxLength} characters.`, column, row, actual: value.length, expected: constraints.maxLength });
      }
      if (constraints.allowedValues && !constraints.allowedValues.some((item) => normalized(item, options) === normalized(value, options))) {
        issues.push({ level: "cell", code: "NOT_ALLOWED", message: `"${column}" value "${value}" is not allowed.`, column, row, actual: value });
      }
      if (constraints.matches) {
        try {
          const expression = new RegExp(constraints.matches, options.caseSensitive ? "" : "i");
          if (!expression.test(value)) {
            issues.push({ level: "cell", code: "REGEX_MISMATCH", message: `"${column}" value "${value}" does not match ${constraints.matches}.`, column, row, actual: value });
          }
        } catch (error) {
          issues.push({ level: "column", code: "INVALID_REGEX", message: `"${column}" has an invalid regex: ${String(error)}`, column });
        }
      }
    });
    if (constraints.unique) {
      const seen = new Map<string, number>();
      values.forEach((value, rowIndex) => {
        if (isNull(value, options)) return;
        const key = normalized(value, options);
        const first = seen.get(key);
        if (first !== undefined) {
          issues.push({ level: "cell", code: "NOT_UNIQUE", message: `"${column}" duplicates CSV row ${first}.`, column, row: parsed.sourceRowNumbers[rowIndex], actual: value });
        } else {
          seen.set(key, parsed.sourceRowNumbers[rowIndex]);
        }
      });
    }
  }

  if (contract.schema.allowAdditionalColumns === false) {
    for (const header of parsed.headers) {
      if (!declared.has(header)) {
        issues.push({ level: "column", code: "ADDITIONAL_COLUMN", message: `Undeclared column "${header}" is not allowed.`, column: header });
      }
    }
  }

  if (contract.identity) {
    const missing = contract.identity.columns.filter((column) => !declared.has(column) || !headerIndex.has(column));
    missing.forEach((column) => issues.push({ level: "column", code: "IDENTITY_COLUMN_MISSING", message: `Identity column "${column}" must be declared and present.`, column }));
    if (contract.identity.unique !== false && missing.length === 0) {
      const seen = new Map<string, number>();
      parsed.rows.forEach((row, rowIndex) => {
        const key = contract.identity!.columns.map((column) => normalized(row[headerIndex.get(column)!] ?? "", options)).join("\u001f");
        const first = seen.get(key);
        if (first !== undefined) {
          issues.push({ level: "row", code: "IDENTITY_NOT_UNIQUE", message: `Composite identity duplicates CSV row ${first}.`, row: parsed.sourceRowNumbers[rowIndex] });
        } else {
          seen.set(key, parsed.sourceRowNumbers[rowIndex]);
        }
      });
    }
  }

  const testIds = new Set<string>();
  for (const test of contract.rowTests ?? []) {
    if (testIds.has(test.id)) {
      issues.push({ level: "row", code: "DUPLICATE_TEST_ID", message: `Row test id "${test.id}" is duplicated.`, testId: test.id });
      continue;
    }
    testIds.add(test.id);
    const references = [...Object.keys(test.select), ...Object.keys(test.expect.cells ?? {})];
    const undeclared = references.filter((column) => !declared.has(column));
    undeclared.forEach((column) => issues.push({ level: "row", code: "UNDECLARED_TEST_COLUMN", message: `Test "${test.id}" references undeclared column "${column}".`, column, testId: test.id }));
    const absent = references.filter((column) => declared.has(column) && !headerIndex.has(column));
    absent.forEach((column) => issues.push({ level: "row", code: "TEST_COLUMN_MISSING", message: `Test "${test.id}" references optional column "${column}", but it is absent from this CSV.`, column, testId: test.id }));
    if (undeclared.length || absent.length) continue;
    const matches = parsed.rows.map((row, index) => ({ row, index })).filter(({ row }) =>
      Object.entries(test.select).every(([column, expected]) => normalized(row[headerIndex.get(column)!] ?? "", options) === normalized(expected, options))
    );
    issues.push(...countIssues("match_count", matches.length, test.expect.count ?? { exact: 1 }, "row", test.id));
    for (const [column, expectation] of Object.entries(test.expect.cells ?? {})) {
      for (const match of matches) {
        const actual = match.row[headerIndex.get(column)!] ?? "";
        if (normalized(actual, options) !== normalized(expectation.equals, options)) {
          issues.push({ level: "cell", code: "CELL_NOT_EQUAL", message: `Test "${test.id}" expected "${column}" to equal "${expectation.equals}", found "${actual}".`, column, row: parsed.sourceRowNumbers[match.index], testId: test.id, actual, expected: expectation.equals });
        }
      }
    }
  }

  return {
    valid: issues.length === 0,
    rowCount: parsed.rows.length,
    columnCount: parsed.headers.length,
    testCount: Object.keys(contract.schema.columns).length + (contract.rowTests?.length ?? 0),
    issueCount: issues.length,
    truncated: false,
    issues
  };
}

export function createContractFromCsv(csvText: string): CsvContract {
  const parsed = parseCsv(csvText);
  if (parsed.headers.length === 0) throw new Error("Cannot create a contract from an empty CSV.");
  const columns = Object.fromEntries(parsed.headers.map((header) => [
    header,
    {
      presence: "required" as const,
      constraints: {
        notNull: false,
        unique: false,
        maxLength: Math.max(0, ...parsed.rows.map((row) => (row[parsed.headers.indexOf(header)] ?? "").length))
      }
    }
  ]));
  return {
    version: 1,
    csv: { ...defaults },
    schema: {
      allowAdditionalColumns: true,
      rowCount: { min: 1 },
      columnCount: { exact: parsed.headers.length },
      columns
    },
    rowTests: []
  };
}

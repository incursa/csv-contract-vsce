import Papa from "papaparse";
import Ajv from "ajv/dist/2020";
import { resolveEvaluation } from "./evaluation";
import { identityKey } from "./identity";
import { validatePreviewOptions, type PreviewOptions } from "./preview";
import schema from "../../schemas/csvtest.schema.json";
import { baselineIssues, CsvSchemaObservation } from "./baseline";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type {
  CountExpectation,
  CsvContract,
  CsvOptions,
  ParsedCsv,
  ValidationIssue,
  ValidationResult
} from "./model";
import { createPredicateRuntime, evaluatePredicate, predicateColumns, predicateDescription } from "./predicate";
import { OrderedRuleEvaluator, orderedChecks, orderedColumns, validateOrderedDefinition, compareOrderedRows } from "./ordered-rule";

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
const validateShape = new Ajv({ strict: false, allErrors: true, validateFormats: false }).compile(schema);

export function parseContract(text: string): CsvContract {
  const value = parseYaml(text) as CsvContract;
  if (!value || value.version !== 1 || !value.schema?.columns) {
    throw new Error("The contract must declare version: 1 and schema.columns.");
  }
  if (!validateShape(value)) throw new Error(`Invalid contract: ${JSON.stringify(validateShape.errors)}`);
  validateContractSemantics(value);
  return value;
}

function validateContractSemantics(contract: CsvContract, depth = 0): void {
  if (depth > 4) throw new Error("Group contract nesting exceeds four levels.");
  const declared = new Set(Object.keys(contract.schema.columns));
  const ids = new Set<string>();
  for (const rule of contract.orderedRules ?? []) {
    validateOrderedDefinition(rule, declared);
    for (const id of [rule.id, ...orderedChecks(rule).map(check => check.id)]) {
      if (ids.has(id)) throw new Error(`Duplicate ordered rule id ${id}.`);
      ids.add(id);
    }
  }
  for (const group of contract.groupTests ?? []) {
    if (ids.has(group.id)) throw new Error(`Duplicate group test id ${group.id}.`);
    ids.add(group.id);
    for (const column of group.groupBy) if (!declared.has(column)) throw new Error(`Group test ${group.id} references undeclared column ${column}.`);
    if (group.contract) {
      if (group.contract.targets?.length || group.contract.sqlServer) throw new Error(`Child contract ${group.id} must inherit the parent target.`);
      validateContractSemantics(group.contract, depth + 1);
    }
  }
}

export function serializeContract(contract: CsvContract, schemaPath = "./schemas/csvtest.schema.json"): string {
  return `# yaml-language-server: $schema=${schemaPath}\n${stringifyYaml(contract, { lineWidth: 110 })}`;
}

export function parseCsv(text: string, options: CsvOptions = {}, rowLimit?: number): ParsedCsv {
  const config = { ...defaults, ...options };
  const parsed = Papa.parse<string[]>(text, {
    preview: rowLimit === undefined ? undefined : rowLimit + 1,
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

export function validateCsv(contract: CsvContract, csvText: string, nativeDates?: Record<string, (string | undefined)[]>, evaluatedAt = new Date().toISOString(), preview?: PreviewOptions): ValidationResult {
  if (preview) validatePreviewOptions(preview);
  return { ...validateCsvResolved(resolveEvaluation(contract, evaluatedAt), csvText, nativeDates, preview), evaluatedAt,
    ...(preview ? { preview: { ...preview, scope: preview.rowLimit === undefined ? "complete" as const : "sample" as const } } : {}) };
}
function validateCsvResolved(contract: CsvContract, csvText: string, nativeDates?: Record<string, (string | undefined)[]>, preview?: PreviewOptions): ValidationResult {
  const examples: NonNullable<ValidationResult["examples"]> = [];
  const ruleOutcomes: NonNullable<ValidationResult["ruleOutcomes"]> = [];
  const groupOutcomes: NonNullable<ValidationResult["groupOutcomes"]> = [];
  let childTestCount = 0;
  const options = { ...defaults, ...(contract.csv ?? {}) };
  const parsed = parseCsv(csvText, options, preview?.rowLimit);
  const issues: ValidationIssue[] = parsed.parseErrors.map((message) => ({ level: "file", code: "CSV_PARSE", message }));
  if (contract.baseline) {
    const observation = new CsvSchemaObservation(parsed.headers, contract.csv);
    parsed.rows.forEach(row => observation.add(row));
    issues.push(...baselineIssues(contract, observation.snapshot()));
  }
  const duplicateHeaders = parsed.headers.filter((header, index) => parsed.headers.indexOf(header) !== index);
  for (const header of [...new Set(duplicateHeaders)]) {
    issues.push({ level: "file", code: "DUPLICATE_HEADER", message: `Header "${header}" appears more than once.`, column: header });
  }

  issues.push(...countIssues("row_count", parsed.rows.length, contract.schema.rowCount, "file"));
  issues.push(...countIssues("column_count", parsed.headers.length, contract.schema.columnCount, "file"));

  const headerIndex = new Map(parsed.headers.map((header, index) => [header, index]));
  const declared = new Set(Object.keys(contract.schema.columns));
  if (contract.schema.columnOrder === "exact") {
    const expected = [...declared].filter((header) => headerIndex.has(header));
    const actual = parsed.headers.filter((header) => declared.has(header));
    if (actual.length !== expected.length || actual.some((header, index) => header !== expected[index])) {
      issues.push({
        level: "file",
        code: "COLUMN_ORDER_MISMATCH",
        message: "CSV headers do not follow the declaration order in schema.columns."
      });
    }
  }
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
    if (missing.length === 0) {
      const seen = new Map<string, number>();
      parsed.rows.forEach((row, rowIndex) => {
        const values = contract.identity!.columns.map((column) => normalized(row[headerIndex.get(column)!] ?? "", options));
        const { key, nullFailure } = identityKey(values, contract.identity!, value => options.nullValues.some(marker => normalized(marker, options) === value));
        if (nullFailure) issues.push({ level: "row", code: "IDENTITY_NULL", testId: contract.identity!.id, message: "Identity contains a configured null value.", row: parsed.sourceRowNumbers[rowIndex] });
        if (key === undefined) return;
        const first = seen.get(key);
        if (first !== undefined) {
          issues.push({ level: "row", code: "IDENTITY_NOT_UNIQUE", testId: contract.identity!.id, message: `Composite identity duplicates CSV row ${first}.`, row: parsed.sourceRowNumbers[rowIndex] });
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

  const nullValues = new Set(options.nullValues.map((value) => normalized(value, options)));
  const advancedRuleIds = new Set<string>();
  for (const rule of contract.rules ?? []) {
    let validRule = true;
    if (advancedRuleIds.has(rule.id)) {
      issues.push({ level: "row", code: "DUPLICATE_RULE_ID", message: `Rule id "${rule.id}" is duplicated.`, testId: rule.id });
      validRule = false;
    }
    advancedRuleIds.add(rule.id);
    const references = [...new Set([...predicateColumns(rule.when), ...predicateColumns(rule.expect)])];
    for (const column of references) {
      if (!declared.has(column)) {
        issues.push({ level: "row", code: "UNDECLARED_RULE_COLUMN", message: `Rule "${rule.id}" references undeclared column "${column}".`, column, testId: rule.id });
        validRule = false;
      } else if (!headerIndex.has(column)) {
        issues.push({ level: "row", code: "RULE_COLUMN_MISSING", message: `Rule "${rule.id}" references optional column "${column}", but it is absent from this CSV.`, column, testId: rule.id });
        validRule = false;
      }
    }
    if (!validRule) continue;
    const outcome = { id: rule.id, selected: 0, passed: 0, failed: 0 };
    ruleOutcomes.push(outcome);
    parsed.rows.forEach((row, rowIndex) => {
      const runtime = createPredicateRuntime((column) => row[headerIndex.get(column)!] ?? "", options, nullValues);
      if (nativeDates) runtime.dateValue = column => nativeDates[column]?.[rowIndex];
      if (rule.when && !evaluatePredicate(rule.when, runtime)) return;
      outcome.selected++;
      const passed = evaluatePredicate(rule.expect, runtime);
      if (preview && examples.filter(e => e.id === rule.id && e.outcome === (passed ? "passed" : "failed")).length < preview.exampleLimit) {
        examples.push({ id: rule.id, outcome: passed ? "passed" : "failed", row: parsed.sourceRowNumbers[rowIndex], values: Object.fromEntries(parsed.headers.map((h, i) => [h, row[i] ?? ""])) });
      }
      if (passed) { outcome.passed++; return; }
      outcome.failed++;
      issues.push({
        level: "row",
        code: "RULE_FAILED",
        message: `Rule "${rule.name ?? rule.id}" expected ${predicateDescription(rule.expect)}.`,
        row: parsed.sourceRowNumbers[rowIndex],
        testId: rule.id,
        severity: rule.severity ?? "error"
      });
    });
  }

  for (const rule of contract.groupRules ?? []) {
    let validRule = true;
    if (advancedRuleIds.has(rule.id)) {
      issues.push({ level: "row", code: "DUPLICATE_RULE_ID", message: `Rule id "${rule.id}" is duplicated.`, testId: rule.id });
      validRule = false;
    }
    advancedRuleIds.add(rule.id);
    const references = [...new Set([...predicateColumns(rule.when), ...rule.groupBy, rule.require.column])];
    for (const column of references) {
      if (!declared.has(column)) {
        issues.push({ level: "row", code: "UNDECLARED_RULE_COLUMN", message: `Group rule "${rule.id}" references undeclared column "${column}".`, column, testId: rule.id });
        validRule = false;
      } else if (!headerIndex.has(column)) {
        issues.push({ level: "row", code: "RULE_COLUMN_MISSING", message: `Group rule "${rule.id}" references optional column "${column}", but it is absent from this CSV.`, column, testId: rule.id });
        validRule = false;
      }
    }
    if (!validRule) continue;
    const groups = new Map<string, { row: number; labels: string[]; observed: Set<string> }>();
    parsed.rows.forEach((row, rowIndex) => {
      const runtime = createPredicateRuntime((column) => row[headerIndex.get(column)!] ?? "", options, nullValues);
      if (nativeDates) runtime.dateValue = column => nativeDates[column]?.[rowIndex];
      if (rule.when && !evaluatePredicate(rule.when, runtime)) return;
      const labels = rule.groupBy.map((column) => row[headerIndex.get(column)!] ?? "");
      const key = labels.map((value) => `${normalized(value, options).length}:${normalized(value, options)}`).join("");
      const group = groups.get(key) ?? { row: parsed.sourceRowNumbers[rowIndex], labels, observed: new Set<string>() };
      group.observed.add(normalized(row[headerIndex.get(rule.require.column)!] ?? "", options));
      groups.set(key, group);
    });
    for (const group of groups.values()) {
      const missingValues = (rule.require.values ?? []).filter((required) => !group.observed.has(normalized(required, options)));
      const missingFragments = (rule.require.contains ?? []).filter((required) => {
        const fragment = normalized(required, options);
        return ![...group.observed].some((value) => value.includes(fragment));
      });
      for (const missing of [...missingValues, ...missingFragments]) {
        const groupLabel = rule.groupBy.map((column, index) => `${column}=${group.labels[index]}`).join(", ");
        issues.push({
          level: "row",
          code: "GROUP_REQUIRED_VALUE_MISSING",
          message: `Group rule "${rule.name ?? rule.id}" is missing "${missing}" in ${rule.require.column} for ${groupLabel}.`,
          row: group.row,
          column: rule.require.column,
          testId: rule.id,
          expected: missing,
          severity: rule.severity ?? "error"
        });
      }
    }
  }

  for (const rule of contract.orderedRules ?? []) {
    const missing = orderedColumns(rule).filter(column => !headerIndex.has(column));
    if (missing.length) {
      for (const column of missing) issues.push({ level: "column", code: "SEQUENCE_COLUMN_MISSING", testId: rule.id,
        column, message: `Sequence ${rule.id} requires column ${column}.` });
      continue;
    }
    const evaluator = new OrderedRuleEvaluator(rule, options, issue => issues.push(issue));
    const rows = parsed.rows.map((fields, index) => ({ row: parsed.sourceRowNumbers[index],
      values: Object.fromEntries(orderedColumns(rule).map(column => [column, fields[headerIndex.get(column)!] ?? ""])) }));
    rows.sort((a, b) => compareOrderedRows(a, b, rule, options));
    for (const row of rows) evaluator.add(row);
    evaluator.finish();
    ruleOutcomes.push(...evaluator.ruleOutcomes);
  }

  for (const groupTest of contract.groupTests ?? []) {
    if (!groupTest.resolvedContract && !groupTest.contract) {
      issues.push({ level: "file", code: "GROUP_REF_UNRESOLVED", testId: groupTest.id,
        message: `Group test ${groupTest.id} needs its referenced child contract resolved before evaluation.` });
      continue;
    }
    const missing = groupTest.groupBy.filter(column => !headerIndex.has(column));
    if (missing.length) {
      for (const column of missing) issues.push({ level: "column", code: "GROUP_COLUMN_MISSING", testId: groupTest.id,
        column, message: `Group test ${groupTest.id} requires column ${column}.` });
      continue;
    }
    const groups = new Map<string, number[]>();
    parsed.rows.forEach((row, index) => {
      const key = JSON.stringify(groupTest.groupBy.map(column => normalized(row[headerIndex.get(column)!] ?? "", options)));
      const entries = groups.get(key) ?? [];
      entries.push(index);
      groups.set(key, entries);
    });
    if (groupTest.groupBy.length === 0 && groups.size === 0) groups.set("[]", []);
    const groupOutcome = { id: groupTest.id, groups: groups.size, passed: 0, failed: 0 };
    groupOutcomes.push(groupOutcome);
    let groupChildTestCount = 0;
    for (const [key, indexes] of groups) {
      const labels = Object.fromEntries(groupTest.groupBy.map((column, index) => [column,
        indexes.length ? parsed.rows[indexes[0]][headerIndex.get(column)!] ?? "" : JSON.parse(key)[index]]));
      const definition = (groupTest.resolvedContract ?? groupTest.contract)!;
      const child = { ...definition, csv: { ...definition.csv, delimiter: ",", quote: "\"" } };
      const childDates = nativeDates ? Object.fromEntries(Object.entries(nativeDates).map(([column, values]) =>
        [column, indexes.map(index => values[index])])) : undefined;
      const childResult = validateCsv(child, Papa.unparse({ fields: parsed.headers,
        data: indexes.map(index => parsed.rows[index]) }), childDates, undefined, preview);
      groupChildTestCount = Math.max(groupChildTestCount, childResult.testCount);
      if (childResult.valid) groupOutcome.passed++;
      else groupOutcome.failed++;
      issues.push(...childResult.issues.map(issue => ({ ...issue, group: { ...labels, ...issue.group },
        row: issue.row === undefined ? undefined : parsed.sourceRowNumbers[indexes[issue.row - 2]] ?? issue.row,
        relatedRows: issue.relatedRows?.map(row => parsed.sourceRowNumbers[indexes[row - 2]] ?? row),
        testId: issue.testId ? `${groupTest.id}/${issue.testId}` : groupTest.id,
        message: `${groupTest.id} ${JSON.stringify(labels)}: ${issue.message}` })));
      for (const outcome of childResult.ruleOutcomes ?? []) {
        const id = `${groupTest.id}/${outcome.id}`;
        const aggregate = ruleOutcomes.find(item => item.id === id);
        if (aggregate) { aggregate.selected += outcome.selected; aggregate.passed += outcome.passed; aggregate.failed += outcome.failed; }
        else ruleOutcomes.push({ ...outcome, id });
      }
    }
    childTestCount += groupChildTestCount;
    const count = groups.size;
    for (const [kind, expected] of Object.entries(groupTest.groupCount ?? {})) {
      if (kind === "exact" && count === expected || kind === "min" && count >= expected || kind === "max" && count <= expected) continue;
      issues.push({ level: "file", code: "GROUP_COUNT", testId: groupTest.id,
        message: `Group test ${groupTest.id} found ${count} groups; expected ${kind} ${expected}.`, actual: count, expected });
    }
  }

  const errorCount = issues.filter((issue) => issue.severity !== "warning").length;
  const warningCount = issues.length - errorCount;

  return {
    valid: errorCount === 0,
    ruleOutcomes,
    ...(groupOutcomes.length ? { groupOutcomes } : {}),
    ...(preview ? { examples } : {}),
    rowCount: parsed.rows.length,
    columnCount: parsed.headers.length,
    testCount: Object.keys(contract.schema.columns).length + (contract.rowTests?.length ?? 0) +
      (contract.rules?.length ?? 0) + (contract.groupRules?.length ?? 0) +
      (contract.orderedRules ?? []).reduce((count, rule) => count + orderedChecks(rule).length, 0) +
      (contract.groupTests?.length ?? 0) + childTestCount,
    issueCount: issues.length,
    errorCount,
    warningCount,
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

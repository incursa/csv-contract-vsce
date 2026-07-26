import { parseCsv } from "../core/contract";
import type { ParsedCsv } from "../core/model";
import {
  comparisonSchema,
  SemanticComparisonError,
  type ComparisonDetails,
  type ComparisonDiagnostic,
  type ComparisonNormalization,
  type ComparisonOptions,
  type ComparisonResult,
  type ComparisonSideSummary,
  type ComparisonSummary,
  type DuplicateKeyGroup
} from "./model";

const defaultNormalization: Required<ComparisonNormalization> = {
  trim: false,
  caseFold: false,
  blankNullEquivalent: false,
  dateColumns: [],
  decimalColumns: []
};

interface Prepared {
  parsed: ParsedCsv;
  index: Map<string, number>;
  rows: Array<Array<string | null>>;
  canonicals: string[];
  counts: Map<string, number>;
}

interface KeyGroup {
  keyValues: Array<string | null>;
  rows: Array<Array<string | null>>;
}

export function canonicalValues(values: Array<string | null>): string {
  return values.map((value) => value === null ? "N;" : `V${value.length}:${value}`).join("");
}

function ordinalSort(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function uniqueColumns(values: string[], label: string): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new SemanticComparisonError("DUPLICATE_OPTION_COLUMN", `${label} contains duplicate column "${value}".`, value);
    seen.add(value);
  }
  return values;
}

function headerIndex(parsed: ParsedCsv, side: string): Map<string, number> {
  const result = new Map<string, number>();
  parsed.headers.forEach((header, index) => {
    if (result.has(header)) {
      throw new SemanticComparisonError("DUPLICATE_HEADER", `${side} CSV contains duplicate column "${header}".`, header);
    }
    result.set(header, index);
  });
  return result;
}

function normalizeDecimal(value: string, column: string, recordNumber: number): string {
  const candidate = value.replaceAll(",", "");
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(candidate);
  if (!match || (!match[2] && !match[3])) {
    throw new SemanticComparisonError("DECIMAL_NORMALIZATION", `Decimal normalization failed for column "${column}" at data record ${recordNumber}.`, column, recordNumber);
  }
  const sign = match[1] === "-" ? "-" : "";
  const integer = match[2] || "0";
  const fraction = match[3] ?? "";
  const exponent = Number(match[4] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100_000) {
    throw new SemanticComparisonError("DECIMAL_NORMALIZATION", `Decimal normalization failed for column "${column}" at data record ${recordNumber}.`, column, recordNumber);
  }
  let digits = `${integer}${fraction}`.replace(/^0+/, "") || "0";
  let scale = fraction.length - exponent;
  if (scale < 0) {
    digits += "0".repeat(-scale);
    scale = 0;
  }
  if (scale > digits.length) digits = `${"0".repeat(scale - digits.length)}${digits}`;
  let whole = scale === 0 ? digits : digits.slice(0, -scale) || "0";
  let decimals = scale === 0 ? "" : digits.slice(-scale);
  whole = whole.replace(/^0+(?=\d)/, "");
  decimals = decimals.replace(/0+$/, "");
  if (whole === "0" && !decimals) return "0";
  return `${sign}${whole}${decimals ? `.${decimals}` : ""}`;
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

function validDateParts(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function normalizeTime(value: string): string | undefined {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,7}))?)?\s*([AaPp][Mm])?$/.exec(value.trim());
  if (!match) return undefined;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? 0);
  if (match[5]) {
    if (hour < 1 || hour > 12) return undefined;
    if (match[5].toUpperCase() === "PM" && hour !== 12) hour += 12;
    if (match[5].toUpperCase() === "AM" && hour === 12) hour = 0;
  }
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  return `${pad(hour)}:${pad(minute)}:${pad(second)}.${(match[4] ?? "").padEnd(7, "0")}`;
}

function normalizeDate(value: string, column: string, recordNumber: number): string {
  const time = normalizeTime(value);
  if (time) return time;
  const trimmed = value.trim();
  const short = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (short) {
    const month = Number(short[1]);
    const day = Number(short[2]);
    const year = Number(short[3]);
    if (validDateParts(year, month, day)) return `${year}-${pad(month)}-${pad(day)}T00:00:00.0000000Z`;
  }
  const isoDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (isoDate) {
    const year = Number(isoDate[1]);
    const month = Number(isoDate[2]);
    const day = Number(isoDate[3]);
    if (validDateParts(year, month, day)) return `${year}-${pad(month)}-${pad(day)}T00:00:00.0000000Z`;
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,7}))?)?(Z|[+-]\d{2}:\d{2})?$/i.exec(trimmed);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    const hour = Number(iso[4]);
    const minute = Number(iso[5]);
    const second = Number(iso[6] ?? 0);
    const offset = iso[8] ?? "Z";
    if (validDateParts(year, month, day) && hour < 24 && minute < 60 && second < 60) {
      const milliseconds = Number((iso[7] ?? "").padEnd(3, "0").slice(0, 3));
      const parsed = new Date(`${iso[1]}-${iso[2]}-${iso[3]}T${iso[4]}:${iso[5]}:${pad(second)}.${pad(milliseconds, 3)}${offset}`);
      if (!Number.isNaN(parsed.valueOf())) {
        return parsed.toISOString().replace(/\.(\d{3})Z$/, ".$10000Z");
      }
    }
  }
  throw new SemanticComparisonError("DATE_NORMALIZATION", `Date normalization failed for column "${column}" at data record ${recordNumber}.`, column, recordNumber);
}

export function normalizeComparisonValue(
  raw: string,
  column: string,
  recordNumber: number,
  options: Required<ComparisonNormalization>,
  dates: Set<string>,
  decimals: Set<string>
): string | null {
  let value = options.trim ? raw.trim() : raw;
  if (options.blankNullEquivalent && value.length === 0) return null;
  if (dates.has(column)) value = normalizeDate(value, column, recordNumber);
  else if (decimals.has(column)) value = normalizeDecimal(value, column, recordNumber);
  return options.caseFold ? value.toUpperCase() : value;
}

function prepare(
  parsed: ParsedCsv,
  index: Map<string, number>,
  columns: string[],
  options: Required<ComparisonNormalization>,
  side: string
): Prepared {
  if (parsed.parseErrors.length) throw new SemanticComparisonError("CSV_PARSE", `${side} CSV could not be parsed: ${parsed.parseErrors[0]}`);
  const rows = parsed.rows.map((row, rowIndex) => columns.map((column) =>
    normalizeComparisonValue(row[index.get(column)!] ?? "", column, rowIndex + 1, options, new Set(options.dateColumns), new Set(options.decimalColumns))
  ));
  const canonicals = rows.map(canonicalValues);
  const counts = new Map<string, number>();
  canonicals.forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1));
  return { parsed, index, rows, canonicals, counts };
}

function sideSummary(prepared: Prepared, keyGroups?: Map<string, KeyGroup>): ComparisonSideSummary {
  return {
    rowCount: prepared.rows.length,
    distinctRowCount: prepared.counts.size,
    duplicateRowGroups: [...prepared.counts.values()].filter((count) => count > 1).length,
    uniqueKeyCount: keyGroups ? [...keyGroups.values()].filter((group) => group.rows.length === 1).length : null,
    duplicateKeyCount: keyGroups ? [...keyGroups.values()].filter((group) => group.rows.length > 1).length : null
  };
}

function groupByKey(rows: Array<Array<string | null>>, columns: string[], keyColumns: string[]): Map<string, KeyGroup> {
  const positions = keyColumns.map((column) => columns.indexOf(column));
  const groups = new Map<string, KeyGroup>();
  rows.forEach((row) => {
    const keyValues = positions.map((position) => row[position]);
    const id = canonicalValues(keyValues);
    const group = groups.get(id);
    if (group) group.rows.push(row);
    else groups.set(id, { keyValues, rows: [row] });
  });
  return groups;
}

function keyReference(index: number): string {
  return `key-${String(index + 1).padStart(6, "0")}`;
}

function emptyDetails(columns: string[], left: Prepared, right: Prepared): ComparisonDetails {
  return {
    columns,
    normalizedRowsTruncated: false,
    detailsTruncated: false,
    normalizedLeftRows: [...left.rows].sort((a, b) => canonicalValues(a) < canonicalValues(b) ? -1 : canonicalValues(a) > canonicalValues(b) ? 1 : 0),
    normalizedRightRows: [...right.rows].sort((a, b) => canonicalValues(a) < canonicalValues(b) ? -1 : canonicalValues(a) > canonicalValues(b) ? 1 : 0),
    leftOnlyRows: [],
    rightOnlyRows: [],
    changedCells: [],
    keysOnlyInLeft: [],
    keysOnlyInRight: [],
    duplicateKeysLeft: [],
    duplicateKeysRight: []
  };
}

function boundedDiagnostics(items: ComparisonDiagnostic[], max: number) {
  return { total: items.length, included: Math.min(items.length, max), truncated: items.length > max, items: items.slice(0, max) };
}

export function compareCsvTexts(leftText: string, rightText: string, requested: ComparisonOptions = {}): ComparisonResult {
  const keyColumns = uniqueColumns([...(requested.keyColumns ?? [])], "keyColumns");
  const contextColumns = uniqueColumns([...(requested.contextColumns ?? [])], "contextColumns");
  const ignoredColumns = uniqueColumns([...(requested.ignoredColumns ?? [])], "ignoredColumns");
  const normalization: Required<ComparisonNormalization> = {
    ...defaultNormalization,
    ...(requested.normalization ?? {}),
    dateColumns: uniqueColumns([...(requested.normalization?.dateColumns ?? [])], "dateColumns"),
    decimalColumns: uniqueColumns([...(requested.normalization?.decimalColumns ?? [])], "decimalColumns")
  };
  const maxDiagnostics = Math.max(0, Math.min(1000, requested.maxDiagnostics ?? 100));
  const parseComparisonCsv = (text: string): ParsedCsv =>
    text.replace(/^\uFEFF/, "").length === 0
      ? { headers: [], rows: [], sourceRowNumbers: [], parseErrors: [] }
      : parseCsv(text);
  const leftParsed = parseComparisonCsv(leftText);
  const rightParsed = parseComparisonCsv(rightText);
  const leftIndex = headerIndex(leftParsed, "Left");
  const rightIndex = headerIndex(rightParsed, "Right");
  const configured = [...ignoredColumns, ...keyColumns, ...contextColumns, ...normalization.dateColumns, ...normalization.decimalColumns];
  for (const column of configured) {
    if (!leftIndex.has(column) || !rightIndex.has(column)) {
      throw new SemanticComparisonError("CONFIGURED_COLUMN_MISSING", `Configured column "${column}" must exist in both CSV files.`, column);
    }
  }
  for (const column of normalization.dateColumns) {
    if (normalization.decimalColumns.includes(column)) {
      throw new SemanticComparisonError("CONFLICTING_NORMALIZATION", `Column "${column}" cannot be both a date and decimal column.`, column);
    }
  }
  for (const column of keyColumns) {
    if (ignoredColumns.includes(column) || contextColumns.includes(column)) {
      throw new SemanticComparisonError("INVALID_KEY_COLUMN", `Key column "${column}" cannot be ignored or used as context.`, column);
    }
  }
  for (const column of contextColumns) {
    if (ignoredColumns.includes(column)) {
      throw new SemanticComparisonError("INVALID_CONTEXT_COLUMN", `Context column "${column}" cannot be ignored.`, column);
    }
  }
  if (contextColumns.length && !keyColumns.length) {
    throw new SemanticComparisonError("CONTEXT_REQUIRES_KEYS", "Context columns require keyed comparison.");
  }

  const leftOnlyColumns = leftParsed.headers.filter((column) => !rightIndex.has(column));
  const rightOnlyColumns = rightParsed.headers.filter((column) => !leftIndex.has(column));
  const comparableColumns = leftParsed.headers.filter((column) => rightIndex.has(column) && !ignoredColumns.includes(column));
  const left = prepare(leftParsed, leftIndex, comparableColumns, normalization, "Left");
  const right = prepare(rightParsed, rightIndex, comparableColumns, normalization, "Right");
  const reordered = leftParsed.headers.filter((column) => rightIndex.has(column)).some((column, index) =>
    rightParsed.headers.filter((rightColumn) => leftIndex.has(rightColumn))[index] !== column
  );
  const diagnosticItems: ComparisonDiagnostic[] = [
    ...leftOnlyColumns.map((column, index) => ({ id: `schema-left-${index + 1}`, kind: "schema-left-only" as const, count: 1, column })),
    ...rightOnlyColumns.map((column, index) => ({ id: `schema-right-${index + 1}`, kind: "schema-right-only" as const, count: 1, column }))
  ];
  const base = {
    schema: comparisonSchema,
    name: requested.name?.trim() || "CSV comparison",
    mode: keyColumns.length ? "keyed" as const : "full-row-multiset" as const,
    options: { keyColumns, contextColumns, ignoredColumns, normalization, maxDiagnostics },
    columns: {
      leftColumns: leftParsed.headers,
      rightColumns: rightParsed.headers,
      comparableColumns,
      columnsOnlyInLeft: leftOnlyColumns,
      columnsOnlyInRight: rightOnlyColumns,
      reordered
    }
  };
  const details = emptyDetails(comparableColumns, left, right);

  if (leftOnlyColumns.length || rightOnlyColumns.length) {
    const summary: ComparisonSummary = {
      ...base,
      status: "schema-mismatch",
      semanticEqual: false,
      exitCode: 3,
      left: sideSummary(left),
      right: sideSummary(right),
      differences: {
        added: 0, removed: 0, changed: 0, unchanged: 0, changedCells: 0,
        schemaChanges: leftOnlyColumns.length + rightOnlyColumns.length,
        duplicateRowCountDifferences: 0, duplicateKeysLeft: 0, duplicateKeysRight: 0,
        changedCellsByColumn: {}
      },
      diagnostics: boundedDiagnostics(diagnosticItems, maxDiagnostics)
    };
    return { summary, details };
  }

  if (!keyColumns.length) {
    let added = 0;
    let removed = 0;
    let unchanged = 0;
    let duplicateRowCountDifferences = 0;
    const all = ordinalSort(new Set([...left.counts.keys(), ...right.counts.keys()]));
    all.forEach((rowCanonical, index) => {
      const leftCount = left.counts.get(rowCanonical) ?? 0;
      const rightCount = right.counts.get(rowCanonical) ?? 0;
      unchanged += Math.min(leftCount, rightCount);
      if (leftCount === rightCount) return;
      duplicateRowCountDifferences += 1;
      const values = (left.rows[left.canonicals.indexOf(rowCanonical)] ?? right.rows[right.canonicals.indexOf(rowCanonical)]);
      if (leftCount > rightCount) {
        removed += leftCount - rightCount;
        details.leftOnlyRows.push(...Array.from({ length: leftCount - rightCount }, () => values));
      } else {
        added += rightCount - leftCount;
        details.rightOnlyRows.push(...Array.from({ length: rightCount - leftCount }, () => values));
      }
      diagnosticItems.push({
        id: `row-${String(index + 1).padStart(6, "0")}`,
        kind: leftCount === 0 ? "row-added" : rightCount === 0 ? "row-removed" : "row-count-changed",
        count: Math.abs(leftCount - rightCount)
      });
    });
    const semanticEqual = added === 0 && removed === 0;
    const summary: ComparisonSummary = {
      ...base,
      status: semanticEqual ? "equal" : "different",
      semanticEqual,
      exitCode: semanticEqual ? 0 : 1,
      left: sideSummary(left),
      right: sideSummary(right),
      differences: {
        added, removed, changed: 0, unchanged, changedCells: 0, schemaChanges: 0,
        duplicateRowCountDifferences, duplicateKeysLeft: 0, duplicateKeysRight: 0,
        changedCellsByColumn: {}
      },
      diagnostics: boundedDiagnostics(diagnosticItems, maxDiagnostics)
    };
    return { summary, details };
  }

  const leftGroups = groupByKey(left.rows, comparableColumns, keyColumns);
  const rightGroups = groupByKey(right.rows, comparableColumns, keyColumns);
  const allKeys = ordinalSort(new Set([...leftGroups.keys(), ...rightGroups.keys()]));
  const contextPositions = contextColumns.map((column) => comparableColumns.indexOf(column));
  const businessColumns = comparableColumns.filter((column) => !keyColumns.includes(column));
  const businessPositions = businessColumns.map((column) => comparableColumns.indexOf(column));
  const changedCellsByColumn = Object.fromEntries(businessColumns.map((column) => [column, 0]));
  let added = 0;
  let removed = 0;
  let changed = 0;
  let unchanged = 0;
  let changedCells = 0;

  allKeys.forEach((id, index) => {
    const reference = keyReference(index);
    const leftGroup = leftGroups.get(id);
    const rightGroup = rightGroups.get(id);
    const leftDuplicate = leftGroup && leftGroup.rows.length > 1;
    const rightDuplicate = rightGroup && rightGroup.rows.length > 1;
    const duplicate = (group: KeyGroup): DuplicateKeyGroup => ({
      keyReference: reference,
      keyValues: group.keyValues,
      rows: group.rows
    });
    if (leftDuplicate) {
      details.duplicateKeysLeft.push(duplicate(leftGroup));
      diagnosticItems.push({ id: `${reference}-duplicate-left`, kind: "duplicate-key-left", count: leftGroup.rows.length, keyReference: reference });
    }
    if (rightDuplicate) {
      details.duplicateKeysRight.push(duplicate(rightGroup));
      diagnosticItems.push({ id: `${reference}-duplicate-right`, kind: "duplicate-key-right", count: rightGroup.rows.length, keyReference: reference });
    }
    if (!leftGroup && rightGroup) {
      added += rightGroup.rows.length;
      details.keysOnlyInRight.push({ keyReference: reference, keyValues: rightGroup.keyValues, contextValues: contextPositions.map((position) => rightGroup.rows[0][position]), count: rightGroup.rows.length });
      diagnosticItems.push({ id: `${reference}-added`, kind: "key-added", count: rightGroup.rows.length, keyReference: reference });
      return;
    }
    if (leftGroup && !rightGroup) {
      removed += leftGroup.rows.length;
      details.keysOnlyInLeft.push({ keyReference: reference, keyValues: leftGroup.keyValues, contextValues: contextPositions.map((position) => leftGroup.rows[0][position]), count: leftGroup.rows.length });
      diagnosticItems.push({ id: `${reference}-removed`, kind: "key-removed", count: leftGroup.rows.length, keyReference: reference });
      return;
    }
    if (!leftGroup || !rightGroup || leftDuplicate || rightDuplicate) return;
    const leftRow = leftGroup.rows[0];
    const rightRow = rightGroup.rows[0];
    let keyChanged = false;
    businessPositions.forEach((position, businessIndex) => {
      if (leftRow[position] === rightRow[position]) return;
      keyChanged = true;
      changedCells += 1;
      const column = businessColumns[businessIndex];
      changedCellsByColumn[column] += 1;
      details.changedCells.push({
        keyReference: reference,
        keyValues: leftGroup.keyValues,
        contextValues: contextPositions.map((contextPosition) => rightRow[contextPosition]),
        column,
        leftValue: leftRow[position],
        rightValue: rightRow[position]
      });
    });
    if (keyChanged) {
      changed += 1;
      diagnosticItems.push({ id: `${reference}-changed`, kind: "key-changed", count: 1, keyReference: reference });
    } else {
      unchanged += 1;
    }
  });
  const duplicateKeysLeft = details.duplicateKeysLeft.length;
  const duplicateKeysRight = details.duplicateKeysRight.length;
  const hasDuplicates = duplicateKeysLeft > 0 || duplicateKeysRight > 0;
  const semanticEqual = !hasDuplicates && !added && !removed && !changedCells;
  const summary: ComparisonSummary = {
    ...base,
    status: hasDuplicates ? "duplicate-keys" : semanticEqual ? "equal" : "different",
    semanticEqual,
    exitCode: hasDuplicates ? 4 : semanticEqual ? 0 : 1,
    left: sideSummary(left, leftGroups),
    right: sideSummary(right, rightGroups),
    differences: {
      added, removed, changed, unchanged, changedCells, schemaChanges: 0,
      duplicateRowCountDifferences: 0, duplicateKeysLeft, duplicateKeysRight,
      changedCellsByColumn
    },
    diagnostics: boundedDiagnostics(diagnosticItems, maxDiagnostics)
  };
  return { summary, details };
}

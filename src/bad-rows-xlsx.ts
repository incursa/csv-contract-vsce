import { strToU8, zipSync } from "fflate";
import { orderedChecks } from "./core/ordered-rule";
import { aggregateResultHealth, resultHealth, resultHealthCategory, type ResultHealthBand } from "./core/result-health";
import type { CsvContract, EvidenceValue, Predicate, SqlPredicate, ValidationIssue, ValidationResult } from "./core/model";

export interface BadRowsRun {
  suite?: string;
  member?: string;
  target?: string;
  table?: string;
  status?: string;
  durationMs?: number;
  evaluatedAt?: string;
  error?: string;
  result?: ValidationResult;
}

export interface WorkbookCheck {
  id: string;
  category: string;
  description: string;
}

export interface BadRowsWorkbookOptions {
  title: string;
  testLabel?: string;
  checkIds?: (run: BadRowsRun, index: number) => string[];
  checkCatalog?: (run: BadRowsRun, index: number) => WorkbookCheck[];
}

interface MatrixRow {
  source: string;
  row?: number;
  values: Record<string, EvidenceValue>;
  related: Record<string, EvidenceValue>;
  failed: Set<string>;
}

interface ConsolidatedMatrixRow extends MatrixRow {
  tests: Set<string>;
}

interface SheetDefinition {
  name: string;
  headers: string[];
  rows: Array<Array<EvidenceValue | undefined>>;
  checkStart?: number;
  readme?: boolean;
  styles?: number[][];
  wrapColumns?: number[];
  freezeColumns?: number;
}

const maximumRows = 1_048_576;
const maximumColumns = 16_384;
const textLimit = 32_767;

function unique(values: string[]): string[] { return [...new Set(values.filter(Boolean))]; }

function shown(value: unknown): string {
  if (value === undefined) return "a configured value";
  if (value === "") return "blank";
  return Array.isArray(value) ? value.map(shown).join(", ") : String(value);
}

function describePredicate(predicate: Predicate | SqlPredicate): string {
  if ("all" in predicate) return predicate.all.map(describePredicate).join(" and ");
  if ("any" in predicate) return `any of: ${predicate.any.map(describePredicate).join("; ")}`;
  const operator: Record<string, string> = {
    equals: "equals", notEquals: "does not equal", in: "is one of", notIn: "is not one of", isNull: "is null", notNull: "is populated",
    isBlank: "is blank", notBlank: "is not blank", equalsColumn: "equals column", notEqualsColumn: "does not equal column",
    contains: "contains", notContains: "does not contain", startsWith: "starts with", endsWith: "ends with", matches: "matches pattern",
    greaterThan: "is greater than", greaterThanOrEqual: "is at least", lessThan: "is less than", lessThanOrEqual: "is at most",
    dateOnOrAfter: "is on or after", dateOnOrBefore: "is on or before", dateAfter: "is after", dateBefore: "is before"
  };
  const right = predicate.otherColumn ?? predicate.values ?? predicate.value ?? ("relativeDate" in predicate ? predicate.relativeDate && `${predicate.relativeDate.days} day(s) from ${predicate.relativeDate.anchor}` : undefined);
  return `${predicate.column} ${operator[predicate.operator] ?? predicate.operator}${right === undefined ? "" : ` ${shown(right)}`}`;
}

function expectationDescription(subject: string, expectation: { exact?: number; min?: number; max?: number }): Array<[string, string]> {
  return [
    expectation.exact === undefined ? undefined : [`${subject}-exact`, `${subject.replaceAll("-", " ")} must equal ${expectation.exact}.`],
    expectation.min === undefined ? undefined : [`${subject}-min`, `${subject.replaceAll("-", " ")} must be at least ${expectation.min}.`],
    expectation.max === undefined ? undefined : [`${subject}-max`, `${subject.replaceAll("-", " ")} must be at most ${expectation.max}.`]
  ].filter((entry): entry is [string, string] => Boolean(entry));
}

/** Human-readable catalog used by the handoff workbook. */
export function contractCheckCatalog(contract: CsvContract, prefix = ""): WorkbookCheck[] {
  const id = (value: string) => prefix ? `${prefix}/${value}` : value;
  const checks: WorkbookCheck[] = [];
  const add = (checkId: string, category: string, description: string) => checks.push({ id: id(checkId), category, description });
  for (const [checkId, description] of expectationDescription("row-count", contract.schema.rowCount ?? {})) add(checkId, "File", description);
  for (const [checkId, description] of expectationDescription("column-count", contract.schema.columnCount ?? {})) add(checkId, "Schema", description);
  if (contract.schema.columnOrder === "exact") add("column-order-exact", "Schema", "Declared columns must appear in the configured order.");
  if (contract.schema.allowAdditionalColumns === false) add("additional-columns", "Schema", "Columns not declared in the contract are not allowed.");
  for (const [column, definition] of Object.entries(contract.schema.columns)) {
    const constraints = definition.constraints ?? {};
    if (definition.presence === "required") add(`${column}.presence`, "Column", `${column} must be present.`);
    if (constraints.notNull) add(`${column}.not-null`, "Column", `${column} must be populated.`);
    if (constraints.minLength !== undefined) add(`${column}.min-length`, "Column", `${column} must contain at least ${constraints.minLength} characters.`);
    if (constraints.maxLength !== undefined) add(`${column}.max-length`, "Column", `${column} must contain no more than ${constraints.maxLength} characters.`);
    if (constraints.allowedValues?.length) add(`${column}.allowed-values`, "Column", `${column} must be one of: ${constraints.allowedValues.join(", ")}.`);
    if (constraints.matches) add(`${column}.matches`, "Column", `${column} must match ${constraints.matches}.`);
    if (constraints.unique) add(`${column}.unique`, "Column", `${column} must be unique.`);
  }
  if (contract.identity) add(contract.identity.id ?? "identity.unique", "Identity", `${contract.identity.columns.join(" + ")} ${contract.identity.unique === false ? "defines the record identity" : "must uniquely identify each record"}.`);
  for (const check of contract.rowTests ?? []) {
    const expectations = [
      ...expectationDescription("matching-row-count", check.expect.count ?? {}).map(([, description]) => description),
      ...Object.entries(check.expect.cells ?? {}).map(([column, value]) => `${column} must equal ${shown(value.equals)}.`)
    ].join(" ");
    add(check.id, "Row test", check.name ?? check.message ?? `For rows where ${Object.entries(check.select).map(([column, value]) => `${column} equals ${shown(value)}`).join(" and ")}, ${expectations || "the configured expectation must hold."}`);
  }
  for (const check of contract.rules ?? []) add(check.id, "Rule", check.name ?? check.message ?? `${check.when ? `When ${describePredicate(check.when)}, ` : ""}${describePredicate(check.expect)}.`);
  for (const check of contract.groupRules ?? []) add(check.id, "Group rule", check.name ?? check.message ?? `For each ${check.groupBy.join(" + ")} group, ${check.require.column} must include ${[...(check.require.values ?? []), ...(check.require.contains ?? [])].join(", ")}.`);
  for (const rule of contract.orderedRules ?? []) for (const check of orderedChecks(rule)) add(check.id, "Ordered rule", check.message);
  for (const check of contract.sqlServer?.conditionalRules ?? []) add(check.id, "SQL rule", check.name ?? check.message ?? `${check.when ? `When ${describePredicate(check.when)}, ` : ""}${describePredicate(check.expect)}.`);
  for (const group of contract.groupTests ?? []) {
    add(group.id, "Grouped test", group.name ?? group.message ?? `Validate records within each ${group.groupBy.join(" + ")} group.`);
    const child = group.resolvedContract ?? group.contract;
    if (child) checks.push(...contractCheckCatalog(child, id(group.id)));
  }
  return [...new Map(checks.map(check => [check.id, check])).values()];
}

/** Stable columns for every configured check, including checks that produced no retained failure. */
export function contractCheckIds(contract: CsvContract, prefix = ""): string[] {
  return contractCheckCatalog(contract, prefix).map(check => check.id);
}

function issueCheckId(issue: ValidationIssue): string {
  if (issue.testId) return issue.testId;
  const fileCodes: Record<string, string> = {
    ROW_COUNT_EXACT: "row-count-exact", ROW_COUNT_MIN: "row-count-min", ROW_COUNT_MAX: "row-count-max",
    COLUMN_COUNT_EXACT: "column-count-exact", COLUMN_COUNT_MIN: "column-count-min", COLUMN_COUNT_MAX: "column-count-max",
    COLUMN_ORDER_MISMATCH: "column-order-exact", ADDITIONAL_COLUMN: "additional-columns"
  };
  if (fileCodes[issue.code]) return fileCodes[issue.code];
  if (!issue.column) return issue.code;
  const suffix: Record<string, string> = {
    NULL_VALUE: "not-null", MIN_LENGTH: "min-length", MAX_LENGTH: "max-length",
    NOT_ALLOWED: "allowed-values", REGEX_MISMATCH: "matches", NOT_UNIQUE: "unique", REQUIRED_COLUMN_MISSING: "presence"
  };
  return `${issue.column}.${suffix[issue.code] ?? issue.code.toLowerCase().replaceAll("_", "-")}`;
}

function runLabel(run: BadRowsRun, index: number): string {
  return run.table ?? run.target ?? run.member ?? `Result ${index + 1}`;
}

function targetLabel(run: BadRowsRun, index: number): string {
  return run.table ?? run.target ?? run.member ?? `Target ${index + 1}`;
}

function testLabel(run: BadRowsRun, index: number, options: BadRowsWorkbookOptions): string {
  return run.member && run.member !== "contract" ? run.member : options.testLabel ?? run.member ?? `Test ${index + 1}`;
}

function humanize(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[._/-]+/g, " ").replace(/\b\w/g, letter => letter.toUpperCase());
}

function healthStyle(band: ResultHealthBand): number {
  return band === "perfect" ? 7 : band === "attention" ? 8 : band === "concerning" ? 9 : 10;
}

function overallStatus(runs: BadRowsRun[]): string {
  const statuses = runs.map(run => run.status ?? (run.result?.valid ? "PASS" : run.result ? "FAIL" : "ERROR"));
  if (!runs.length || statuses.includes("ERROR")) return "ERROR";
  if (statuses.includes("CANCELED")) return "CANCELED";
  if (statuses.includes("FAIL")) return "FAIL";
  if (statuses.includes("SKIPPED")) return "SKIPPED";
  if (statuses.includes("SAMPLED")) return "SAMPLED";
  return "PASS";
}

function checkFailures(run: BadRowsRun, checkId: string): number {
  const result = run.result;
  if (!result) return 0;
  const retained = result.issues.filter(issue => issueCheckId(issue) === checkId).reduce((total, issue) => total + (issue.evidence?.totalSamples ?? 1), 0);
  const outcome = [...(result.ruleOutcomes ?? []), ...(result.groupOutcomes ?? [])].find(item => item.id === checkId)?.failed ?? 0;
  return Math.max(retained, outcome);
}

function overviewSheet(runs: BadRowsRun[], options: BadRowsWorkbookOptions, used: Set<string>): SheetDefinition {
  const aggregate = aggregateResultHealth(runs.map(run => ({ result: run.result, status: run.status })), "graded");
  const aggregateStatus = overallStatus(runs);
  const aggregateSampled = aggregateStatus === "SAMPLED";
  const headers = ["Test file", "Instance / target", "Status", "Impact", "Health score", "Rows", "Executed checks", "Findings", "Error findings", "Warning findings", "Duration (seconds)", "Evaluated UTC", "Notes"];
  const totalDuration = runs.reduce((total, run) => total + (run.durationMs ?? 0), 0);
  const rows: SheetDefinition["rows"] = [["Overall", `${runs.length} target result${runs.length === 1 ? "" : "s"}`, aggregateStatus, aggregateSampled ? "Sample only" : resultHealthCategory(aggregate), aggregateSampled ? undefined : aggregate.score,
    runs.reduce((total, run) => total + (run.result?.rowCount ?? 0), 0), runs.reduce((total, run) => total + (run.result?.testCount ?? 0), 0),
    runs.reduce((total, run) => total + (run.result?.issueCount ?? 0), 0), runs.reduce((total, run) => total + (run.result?.errorCount ?? 0), 0),
    runs.reduce((total, run) => total + (run.result?.warningCount ?? 0), 0), totalDuration ? Math.round(totalDuration / 100) / 10 : undefined,
    runs.map(run => run.evaluatedAt ?? run.result?.evaluatedAt).filter(Boolean).sort().at(-1), "Overall health uses the same graded calculation as the Workbench."]];
  const aggregateStyle = aggregateSampled ? 8 : healthStyle(aggregate.band);
  const styles: number[][] = [[6, 6, aggregateStyle, aggregateStyle, aggregateStyle]];
  runs.forEach((run, index) => {
    const health = resultHealth(run.result, run.status, "graded");
    const sampled = run.result?.preview?.scope === "sample";
    rows.push([testLabel(run, index, options), runLabel(run, index), run.status ?? (run.result?.valid ? "PASS" : run.result ? "FAIL" : "ERROR"),
      sampled ? "Sample only" : resultHealthCategory(health), sampled ? undefined : health.score, run.result?.rowCount, run.result?.testCount, run.result?.issueCount,
      run.result?.errorCount, run.result?.warningCount, run.durationMs === undefined ? undefined : Math.round(run.durationMs / 100) / 10,
      run.evaluatedAt ?? run.result?.evaluatedAt, run.error ?? (run.result?.truncated ? "Finding details were limited." : sampled ? "Incomplete sampled validation." : "")]);
    const style = sampled ? 8 : healthStyle(health.band);
    styles.push([6, 6, run.status === "SKIPPED" ? 11 : style, style, style]);
  });
  return { name: safeSheetName("Overview", used), headers, rows, styles, wrapColumns: [12] };
}

function rulesSheet(runs: BadRowsRun[], options: BadRowsWorkbookOptions, used: Set<string>): SheetDefinition | undefined {
  const byTest = new Map<string, Array<{ run: BadRowsRun; index: number }>>();
  runs.forEach((run, index) => {
    const label = testLabel(run, index, options);
    const values = byTest.get(label) ?? [];
    values.push({ run, index });
    byTest.set(label, values);
  });
  const rows: SheetDefinition["rows"] = [];
  const styles: number[][] = [];
  for (const [label, entries] of byTest) {
    const catalog = new Map<string, WorkbookCheck>();
    for (const { run, index } of entries) {
      const configured = options.checkCatalog?.(run, index) ?? (options.checkIds?.(run, index) ?? []).map(id => ({ id, category: "Check", description: humanize(id) }));
      for (const check of configured) catalog.set(check.id, check);
      for (const issue of run.result?.issues ?? []) {
        const id = issueCheckId(issue);
        if (!catalog.has(id)) catalog.set(id, { id, category: humanize(issue.level), description: issue.title ?? issue.message });
      }
    }
    for (const check of catalog.values()) {
      const evaluated = entries.filter(({ run }) => Boolean(run.result)).length;
      const complete = entries.filter(({ run }) => Boolean(run.result) && run.status !== "SAMPLED" && run.result?.preview?.scope !== "sample").length;
      const targetFailures = entries.filter(({ run }) => checkFailures(run, check.id) > 0).length;
      const failureEvents = entries.reduce((total, { run }) => total + checkFailures(run, check.id), 0);
      const status = targetFailures ? "FAILED" : complete === entries.length ? "PASSED" : evaluated ? "PARTIAL" : "NOT RUN";
      rows.push([label, check.id, check.category, check.description, status, evaluated, targetFailures, failureEvents]);
      styles.push([6, 6, 6, 13, status === "FAILED" ? 10 : status === "PASSED" ? 7 : status === "PARTIAL" ? 8 : 11]);
    }
  }
  if (!rows.length) return undefined;
  return { name: safeSheetName("Rules", used), headers: ["Test file", "Rule", "Type", "What was tested", "Status", "Targets evaluated", "Targets failed", "Failure events"], rows, styles, wrapColumns: [3] };
}

function matrixRows(run: BadRowsRun): { rows: MatrixRow[]; aggregateIssues: ValidationIssue[] } {
  const rows = new Map<string, MatrixRow>();
  const aggregateIssues: ValidationIssue[] = [];
  for (const issue of run.result?.issues ?? []) {
    const samples = issue.evidence?.samples ?? [];
    if (!samples.some(sample => sample.primary)) { aggregateIssues.push(issue); continue; }
    for (const sample of samples) {
      if (!sample.primary) continue;
      const primary = sample.primary;
      const key = JSON.stringify([primary.label ?? "", primary.row ?? null, primary.values]);
      const row = rows.get(key) ?? { source: primary.label ?? runLabel(run, 0), row: primary.row, values: primary.values, related: {}, failed: new Set<string>() };
      const relatedLabels = new Map<string, number>();
      for (const [relatedIndex, related] of (sample.related ?? []).entries()) {
        const baseLabel = related.label ?? `Related ${relatedIndex + 1}`;
        const occurrence = (relatedLabels.get(baseLabel) ?? 0) + 1;
        relatedLabels.set(baseLabel, occurrence);
        const label = occurrence === 1 ? baseLabel : `${baseLabel} #${occurrence}`;
        for (const [column, value] of Object.entries(related.values)) row.related[`${label} - ${column}`] = value;
      }
      row.failed.add(issueCheckId(issue));
      rows.set(key, row);
    }
  }
  return { rows: [...rows.values()], aggregateIssues };
}

function safeSheetName(value: string, used: Set<string>): string {
  const base = value.replace(/[\\/?*:[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 31) || "Bad rows";
  let candidate = base;
  for (let suffix = 2; used.has(candidate.toLocaleLowerCase()); suffix++) candidate = `${base.slice(0, Math.max(1, 31 - String(suffix).length - 1))} ${suffix}`;
  used.add(candidate.toLocaleLowerCase());
  return candidate;
}

function xml(value: unknown): string {
  const legal = [...String(value ?? "")].filter(character => {
    const code = character.charCodeAt(0);
    return code >= 32 || code === 9 || code === 10 || code === 13;
  }).join("");
  return legal.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!);
}

function columnName(index: number): string {
  let value = "";
  for (let current = index + 1; current > 0; current = Math.floor((current - 1) / 26)) value = String.fromCharCode(65 + (current - 1) % 26) + value;
  return value;
}

function cell(value: EvidenceValue | undefined, row: number, column: number, style = 0): string {
  if (value === undefined || value === null) return "";
  const reference = `${columnName(column)}${row}`;
  const effectiveStyle = style || (typeof value === "string" ? 6 : 0);
  const styleAttribute = effectiveStyle ? ` s="${effectiveStyle}"` : "";
  if (typeof value === "boolean") return `<c r="${reference}" t="b"${styleAttribute}><v>${value ? 1 : 0}</v></c>`;
  if (typeof value === "number" && Number.isFinite(value)) return `<c r="${reference}"${styleAttribute}><v>${value}</v></c>`;
  const text = String(value).slice(0, textLimit);
  const preserve = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : "";
  return `<c r="${reference}" t="inlineStr"${styleAttribute}><is><t${preserve}>${xml(text)}</t></is></c>`;
}

function worksheet(sheet: SheetDefinition): string {
  if (!sheet.headers.length || sheet.headers.length > maximumColumns) throw new Error(`Excel sheet '${sheet.name}' has an invalid column count.`);
  if (sheet.rows.length + 1 > maximumRows) throw new Error(`Excel sheet '${sheet.name}' exceeds ${maximumRows.toLocaleString()} rows.`);
  const widths = sheet.headers.map((header, column) => {
    const longest = sheet.rows.slice(0, 500).reduce((length, row) => Math.max(length, String(row[column] ?? "").length), header.length);
    return Math.min(sheet.checkStart !== undefined && column >= sheet.checkStart ? 28 : 42, Math.max(10, longest + 2));
  });
  const rows = [`<row r="1">${sheet.headers.map((header, column) => cell(header, 1, column, sheet.readme ? 5 : sheet.checkStart !== undefined && column >= sheet.checkStart ? 2 : 1)).join("")}</row>`];
  for (const [rowIndex, values] of sheet.rows.entries()) rows.push(`<row r="${rowIndex + 2}">${values.map((value, column) => cell(value, rowIndex + 2, column,
    sheet.styles?.[rowIndex]?.[column] ?? (sheet.checkStart !== undefined && column >= sheet.checkStart && value === false ? 3 : sheet.checkStart !== undefined && column >= sheet.checkStart && value === true ? 4 : sheet.wrapColumns?.includes(column) ? 13 : 0))).join("")}</row>`);
  const last = `${columnName(sheet.headers.length - 1)}${sheet.rows.length + 1}`;
  const frozenPane = sheet.freezeColumns
    ? `<pane xSplit="${sheet.freezeColumns}" ySplit="1" topLeftCell="${columnName(sheet.freezeColumns)}2" activePane="bottomRight" state="frozen"/>`
    : '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0">${sheet.readme ? "" : frozenPane}</sheetView></sheetViews><cols>${widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join("")}</cols><sheetData>${rows.join("")}</sheetData>${sheet.readme ? "" : `<autoFilter ref="A1:${last}"/>`}</worksheet>`;
}

function styles(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="4"><font><sz val="11"/><name val="Aptos"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Aptos"/></font><font><b/><color rgb="FF9C0006"/><name val="Aptos"/></font><font><b/><color rgb="FF006100"/><name val="Aptos"/></font></fonts><fills count="10"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF26344A"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FF5B3F8C"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFC7CE"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFC6EFCE"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF4CE"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFE4C7"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFBE8EA"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8EBF2"/></patternFill></fill></fills><borders count="2"><border/><border><left style="thin"><color rgb="FFD9DEE7"/></left><right style="thin"><color rgb="FFD9DEE7"/></right><top style="thin"><color rgb="FFD9DEE7"/></top><bottom style="thin"><color rgb="FFD9DEE7"/></bottom></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="14"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="0" fontId="1" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="0" fontId="2" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="0" fontId="3" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" quotePrefix="1"/><xf numFmtId="0" fontId="3" fillId="5" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="0" fillId="6" borderId="0" xfId="0" applyFill="1"/><xf numFmtId="0" fontId="0" fillId="7" borderId="0" xfId="0" applyFill="1"/><xf numFmtId="0" fontId="2" fillId="8" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="0" fillId="9" borderId="0" xfId="0" applyFill="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" quotePrefix="1"><alignment wrapText="1" vertical="top"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
}

function workbookPackage(sheets: SheetDefinition[], title: string): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const overrides = sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("");
  files["[Content_Types].xml"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>${overrides}</Types>`);
  files["_rels/.rels"] = strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>');
  files["xl/workbook.xml"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView activeTab="0"/></bookViews><sheets>${sheets.map((sheet, index) => `<sheet name="${xml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets><calcPr calcId="0" fullCalcOnLoad="1"/></workbook>`);
  files["xl/_rels/workbook.xml.rels"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  files["xl/styles.xml"] = strToU8(styles());
  sheets.forEach((sheet, index) => { files[`xl/worksheets/sheet${index + 1}.xml`] = strToU8(worksheet(sheet)); });
  const timestamp = new Date().toISOString();
  files["docProps/core.xml"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(title)}</dc:title><dc:creator>CSV Contract Workbench</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:modified></cp:coreProperties>`);
  files["docProps/app.xml"] = strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>CSV Contract Workbench</Application><AppVersion>1.0</AppVersion></Properties>');
  return zipSync(files, { level: 6 });
}

/** Build a workbook from retained evidence without querying the source again. */
export function badRowsXlsx(runs: BadRowsRun[], options: BadRowsWorkbookOptions): Uint8Array {
  const used = new Set<string>();
  const readmeName = safeSheetName("Read Me", used);
  const sheets: SheetDefinition[] = [overviewSheet(runs, options, used)];
  const ruleSummary = rulesSheet(runs, options, used);
  if (ruleSummary) sheets.push(ruleSummary);
  let badRowCount = 0;
  let aggregateCount = 0;
  const aggregates: Array<Array<EvidenceValue | undefined>> = [];
  const targetSheets: SheetDefinition[] = [];
  const groupedTargets = new Map<string, { label: string; entries: Array<{ run: BadRowsRun; index: number }> }>();
  runs.forEach((run, runIndex) => {
    const label = targetLabel(run, runIndex);
    const key = label.trim().toLocaleLowerCase();
    const group = groupedTargets.get(key) ?? { label, entries: [] };
    group.entries.push({ run, index: runIndex });
    groupedTargets.set(key, group);
    const matrix = matrixRows(run);
    aggregateCount += matrix.aggregateIssues.length;
    for (const issue of matrix.aggregateIssues) aggregates.push([run.member ?? "", runLabel(run, runIndex), issueCheckId(issue), issue.message, issue.actual, issue.expected]);
  });
  const sortedTargets = [...groupedTargets.values()].sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: "base" }));
  for (const target of sortedTargets) {
    const entries = [...target.entries].sort((left, right) => testLabel(left.run, left.index, options).localeCompare(testLabel(right.run, right.index, options), undefined, { sensitivity: "base" }) || left.index - right.index);
    const rows = new Map<string, ConsolidatedMatrixRow>();
    const checkIds: string[] = [];
    for (const { run, index } of entries) {
      const test = testLabel(run, index, options);
      const matrix = matrixRows(run);
      const configured = options.checkCatalog?.(run, index).map(check => check.id) ?? options.checkIds?.(run, index) ?? [];
      for (const checkId of unique([...configured, ...matrix.rows.flatMap(row => [...row.failed])])) checkIds.push(`${test}\u0000${checkId}`);
      for (const item of matrix.rows) {
        const valuesKey = Object.entries(item.values).sort(([left], [right]) => left.localeCompare(right)).map(([column, value]) => [column, value]);
        const key = JSON.stringify([item.source, item.row ?? null, valuesKey]);
        const row = rows.get(key) ?? { source: item.source, row: item.row, values: item.values, related: {}, failed: new Set<string>(), tests: new Set<string>() };
        row.tests.add(test);
        for (const [column, value] of Object.entries(item.related)) row.related[`${test} - ${column}`] = value;
        for (const failed of item.failed) row.failed.add(`${test}\u0000${failed}`);
        rows.set(key, row);
      }
    }
    const matrixRowsForTarget = [...rows.values()];
    if (!matrixRowsForTarget.length) continue;
    badRowCount += matrixRowsForTarget.length;
    const sourceColumns = unique(matrixRowsForTarget.flatMap(row => Object.keys(row.values)));
    const relatedColumns = unique(matrixRowsForTarget.flatMap(row => Object.keys(row.related)));
    const distinctCheckIds = unique(checkIds);
    const headers = ["Test files", "Source", "Source row", ...sourceColumns, ...relatedColumns, ...distinctCheckIds.map(id => {
      const [test, check] = id.split("\u0000");
      return `Check - ${test} - ${check}`;
    })];
    const checkStart = 3 + sourceColumns.length + relatedColumns.length;
    targetSheets.push({
      name: safeSheetName(`Bad - ${target.label}`, used), headers, checkStart, freezeColumns: 3,
      rows: matrixRowsForTarget.map(row => [[...row.tests].sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" })).join(", "), row.source, row.row,
        ...sourceColumns.map(column => row.values[column]), ...relatedColumns.map(column => row.related[column]), ...distinctCheckIds.map(id => row.failed.has(id) ? false : undefined)])
    });
  }
  const readmeRows: Array<Array<EvidenceValue | undefined>> = [
    ["Workbook", options.title], ["Exported UTC", new Date().toISOString()], ["Target results", runs.length], ["Targets with bad rows", targetSheets.length], ["Retained bad rows", badRowCount],
    ["Package layout", "Overview summarizes every test and target. Rules explains configured checks. Each Bad sheet consolidates retained failing rows for one target across all test files. Aggregate Findings contains findings without a primary row."],
    ["Aggregate-only findings", aggregateCount], ["Matrix meaning", "FALSE (red) means this check failed the retained row. Blank means not failed in retained evidence, not applicable, or not provably evaluated for that row."],
    ["Merged rows", "A source row is merged across test files only when its source label, row number, and source values match. Check columns include the test file name so repeated rule IDs remain separate."],
    ["Data handling", "Sheets can contain every retained source and joined value. Protect this workbook like the source data."],
    ["Evidence boundary", "The workbook uses retained run evidence and does not query the source again. Limited evidence remains limited."],
    ["Excel limits", "At most 1,048,575 data rows and 16,384 columns per sheet. Text cells are limited to 32,767 characters."]
  ];
  sheets.push(...targetSheets);
  if (aggregates.length) sheets.push({ name: safeSheetName("Aggregate Findings", used), headers: ["Member", "Target", "Check", "Message", "Actual", "Expected"], rows: aggregates });
  if (!targetSheets.length && !aggregates.length) sheets.push({ name: safeSheetName("No bad rows", used), headers: ["Status"], rows: [["No retained bad-row evidence was available in the selected results."]] });
  sheets.push({ name: readmeName, headers: ["Item", "Details"], rows: readmeRows, readme: true });
  return workbookPackage(sheets, options.title);
}

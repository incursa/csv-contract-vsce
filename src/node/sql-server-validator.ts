import sql from "mssql";
import Papa from "papaparse";
import { validateCsv } from "../core/contract";
import type { CountExpectation, CsvContract, ValidationIssue, ValidationResult } from "../core/model";
import { generateSqlServerValidation, sqlIdentifier } from "../core/sql-server-generator";
import type { ResolvedSqlServerTarget } from "../core/sql-server-targets";

export interface SqlServerValidationOptions {
  maxIssues?: number;
  scopeValue?: string;
}

interface SummaryRow {
  RuleId: string;
  RuleName: string;
  Severity: "error" | "warning";
  Code: string;
  ColumnName: string;
  FailureCount: number | string;
}

interface MetadataRow {
  name: string;
  ordinal: number;
}

export class SqlServerValidationSession {
  private readonly pools = new Map<string, sql.ConnectionPool>();

  public constructor(private readonly resolveConnectionString: (profile: string) => Promise<string> | string) {}

  public async dispose(): Promise<void> {
    await Promise.all([...this.pools.values()].map((pool) => pool.close()));
    this.pools.clear();
  }

  public async validate(
    contract: CsvContract,
    target: ResolvedSqlServerTarget,
    options: SqlServerValidationOptions = {}
  ): Promise<ValidationResult> {
    const pool = await this.getPool(target.connection);
    const metadata = await readMetadata(pool, target);
    if (metadata.length === 0) throw new Error(`SQL Server table ${target.schema}.${target.table} does not exist or is not visible to this connection.`);
    const metadataIssues = validateMetadata(contract, metadata);
    const generated = generateSqlServerValidation(contract, {
      target,
      declareScopeParameter: false,
      includeDetailQueries: false
    });
    const declared = Object.keys(contract.schema.columns);
    const present = new Set(metadata.map((column) => column.name));
    const mustFallback = generated.warnings.length > 0 || declared.some((column) => !present.has(column));
    const scopeValue = resolveScopeValue(target, options.scopeValue);
    if (mustFallback) {
      const fallback = await validateClientSide(pool, contract, target, metadata, scopeValue);
      const reason = generated.warnings.length
        ? generated.warnings.join(" ")
        : "One or more declared columns are absent, so rules that reference optional columns must preserve CSV-compatible behavior.";
      const fallbackNotice: ValidationIssue = {
        level: "file",
        code: "SQL_CLIENT_FALLBACK",
        message: `Used an exact read-only client fallback for this table. ${reason}`,
        severity: "warning"
      };
      const withNotice: ValidationResult = {
        ...fallback,
        issueCount: fallback.issueCount + 1,
        warningCount: fallback.warningCount + 1,
        issues: [fallbackNotice, ...fallback.issues]
      };
      return mergeMetadataIssues(withNotice, metadataIssues, metadata.length, options.maxIssues ?? 1000);
    }

    const request = pool.request();
    bindScope(request, target, scopeValue);
    const executed = await request.query(generated.sql);
    const summaries = (((executed.recordsets as sql.IRecordSet<unknown>[])[0]) ?? []) as unknown as SummaryRow[];
    const issues = [...metadataIssues];
    let errorCount = metadataIssues.filter((issue) => issue.severity !== "warning").length;
    let warningCount = metadataIssues.length - errorCount;
    for (const summary of summaries) {
      const failures = Number(summary.FailureCount);
      if (!Number.isFinite(failures) || failures <= 0) continue;
      const issue: ValidationIssue = {
        level: summary.ColumnName ? "cell" : "row",
        code: summary.Code,
        message: `${summary.RuleName} failed for ${failures.toLocaleString()} ${failures === 1 ? "row or group" : "rows or groups"}.`,
        column: summary.ColumnName || undefined,
        testId: summary.RuleId,
        actual: failures,
        expected: 0,
        severity: summary.Severity
      };
      if (issues.length < (options.maxIssues ?? 1000)) issues.push(issue);
      if (summary.Severity === "warning") warningCount += failures;
      else errorCount += failures;
    }
    const rowCount = await readRowCount(pool, target, scopeValue);
    const issueCount = errorCount + warningCount;
    return {
      valid: errorCount === 0,
      rowCount,
      columnCount: metadata.length,
      testCount: contractTestCount(contract),
      issueCount,
      errorCount,
      warningCount,
      truncated: issueCount > issues.length,
      issues
    };
  }

  private async getPool(profile: string): Promise<sql.ConnectionPool> {
    const existing = this.pools.get(profile);
    if (existing) return existing;
    const connectionString = await this.resolveConnectionString(profile);
    if (!connectionString.trim()) throw new Error(`SQL Server connection profile '${profile}' is empty.`);
    const pool = await new sql.ConnectionPool(connectionString).connect();
    this.pools.set(profile, pool);
    return pool;
  }
}

function contractTestCount(contract: CsvContract): number {
  return Object.keys(contract.schema.columns).length + (contract.rowTests?.length ?? 0) +
    (contract.rules?.length ?? 0) + (contract.groupRules?.length ?? 0) +
    (contract.sqlServer?.conditionalRules?.length ?? 0);
}

function resolveScopeValue(target: ResolvedSqlServerTarget, explicit: string | undefined): string | undefined {
  if (!target.scope) return undefined;
  const value = explicit ?? (target.scope.valueEnvironment ? process.env[target.scope.valueEnvironment] : undefined);
  if (value === undefined) {
    const source = target.scope.valueEnvironment ? ` environment variable ${target.scope.valueEnvironment}` : " runtime scope value";
    throw new Error(`SQL Server target ${target.schema}.${target.table} requires${source} for @${target.scope.parameter}.`);
  }
  return value;
}

function bindScope(request: sql.Request, target: ResolvedSqlServerTarget, value: string | undefined): void {
  if (target.scope) request.input(target.scope.parameter, sql.NVarChar(sql.MAX), value);
}

async function readMetadata(pool: sql.ConnectionPool, target: ResolvedSqlServerTarget): Promise<MetadataRow[]> {
  const result = await pool.request()
    .input("schema", sql.NVarChar(128), target.schema)
    .input("table", sql.NVarChar(128), target.table)
    .query<MetadataRow>(`
SELECT c.name, c.column_id AS ordinal
FROM sys.columns AS c
JOIN sys.tables AS t ON t.object_id = c.object_id
JOIN sys.schemas AS s ON s.schema_id = t.schema_id
WHERE s.name = @schema AND t.name = @table
ORDER BY c.column_id;`);
  return result.recordset;
}

async function readRowCount(pool: sql.ConnectionPool, target: ResolvedSqlServerTarget, scopeValue: string | undefined): Promise<number> {
  const request = pool.request();
  bindScope(request, target, scopeValue);
  const scope = target.scope
    ? `WHERE CONVERT(nvarchar(max), t.${sqlIdentifier(target.scope.column)}) = CONVERT(nvarchar(max), @${target.scope.parameter})`
    : "";
  const result = await request.query<{ count: number | string }>(`SELECT COUNT_BIG(*) AS count FROM ${sqlIdentifier(target.schema)}.${sqlIdentifier(target.table)} AS t ${scope};`);
  return Number(result.recordset[0]?.count ?? 0);
}

function countIssues(name: string, actual: number, expectation: CountExpectation | undefined): ValidationIssue[] {
  if (!expectation) return [];
  const issues: ValidationIssue[] = [];
  if (expectation.exact !== undefined && actual !== expectation.exact) issues.push({ level: "file", code: `${name}_EXACT`, message: `${name.toLowerCase()} is ${actual}; expected exactly ${expectation.exact}.`, actual, expected: expectation.exact });
  if (expectation.min !== undefined && actual < expectation.min) issues.push({ level: "file", code: `${name}_MIN`, message: `${name.toLowerCase()} is ${actual}; expected at least ${expectation.min}.`, actual, expected: expectation.min });
  if (expectation.max !== undefined && actual > expectation.max) issues.push({ level: "file", code: `${name}_MAX`, message: `${name.toLowerCase()} is ${actual}; expected at most ${expectation.max}.`, actual, expected: expectation.max });
  return issues;
}

function validateMetadata(contract: CsvContract, metadata: MetadataRow[]): ValidationIssue[] {
  const issues = countIssues("COLUMN_COUNT", metadata.length, contract.schema.columnCount);
  const actual = metadata.map((column) => column.name);
  const actualSet = new Set(actual);
  const declared = Object.keys(contract.schema.columns);
  for (const [column, definition] of Object.entries(contract.schema.columns)) {
    if (definition.presence === "required" && !actualSet.has(column)) {
      issues.push({ level: "column", code: "REQUIRED_COLUMN_MISSING", message: `Required column "${column}" is missing.`, column });
    }
  }
  if (contract.schema.allowAdditionalColumns === false) {
    const declaredSet = new Set(declared);
    for (const column of actual) if (!declaredSet.has(column)) issues.push({ level: "column", code: "ADDITIONAL_COLUMN", message: `Undeclared column "${column}" is not allowed.`, column });
  }
  if (contract.schema.columnOrder === "exact") {
    const expected = declared.filter((column) => actualSet.has(column));
    const filteredActual = actual.filter((column) => new Set(declared).has(column));
    if (expected.some((column, index) => filteredActual[index] !== column) || expected.length !== filteredActual.length) {
      issues.push({ level: "file", code: "COLUMN_ORDER_MISMATCH", message: "SQL Server columns do not follow the declaration order in schema.columns." });
    }
  }
  return issues;
}

async function validateClientSide(
  pool: sql.ConnectionPool,
  contract: CsvContract,
  target: ResolvedSqlServerTarget,
  metadata: MetadataRow[],
  scopeValue: string | undefined
): Promise<ValidationResult> {
  const present = new Set(metadata.map((column) => column.name));
  const columns = Object.keys(contract.schema.columns).filter((column) => present.has(column));
  if (columns.length === 0) {
    return { valid: false, rowCount: await readRowCount(pool, target, scopeValue), columnCount: metadata.length, testCount: contractTestCount(contract), issueCount: 0, errorCount: 0, warningCount: 0, truncated: false, issues: [] };
  }
  const projection = columns.map((column) => `CONVERT(nvarchar(max), t.${sqlIdentifier(column)}) AS ${sqlIdentifier(column)}`).join(", ");
  const scope = target.scope
    ? `WHERE CONVERT(nvarchar(max), t.${sqlIdentifier(target.scope.column)}) = CONVERT(nvarchar(max), @${target.scope.parameter})`
    : "";
  const request = pool.request();
  bindScope(request, target, scopeValue);
  const result = await request.query<Record<string, string | null>>(`SELECT ${projection} FROM ${sqlIdentifier(target.schema)}.${sqlIdentifier(target.table)} AS t ${scope};`);
  const rows = result.recordset.map((row) => columns.map((column) => row[column] ?? ""));
  const fallbackContract: CsvContract = {
    ...contract,
    schema: { ...contract.schema, allowAdditionalColumns: true, columnCount: undefined, columnOrder: undefined },
    rules: [...(contract.rules ?? []), ...((contract.sqlServer?.conditionalRules ?? []) as NonNullable<CsvContract["rules"]>)]
  };
  return validateCsv(fallbackContract, Papa.unparse({ fields: columns, data: rows }));
}

function mergeMetadataIssues(result: ValidationResult, metadataIssues: ValidationIssue[], actualColumnCount: number, maxIssues: number): ValidationResult {
  const freshMetadata = metadataIssues.filter((metadata) => !result.issues.some((issue) =>
    issue.code === metadata.code && issue.column === metadata.column && issue.testId === metadata.testId
  ));
  const errors = freshMetadata.filter((issue) => issue.severity !== "warning").length;
  const warnings = freshMetadata.length - errors;
  const issues = [...freshMetadata, ...result.issues].slice(0, maxIssues);
  return {
    ...result,
    columnCount: actualColumnCount,
    valid: result.valid && errors === 0,
    issueCount: result.issueCount + freshMetadata.length,
    errorCount: result.errorCount + errors,
    warningCount: result.warningCount + warnings,
    truncated: result.truncated || result.issueCount + freshMetadata.length > issues.length,
    issues
  };
}

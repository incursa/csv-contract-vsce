import sql from "mssql";
import { assertCompleteSqlSummaries } from "../core/sql-server-results";
import Papa from "papaparse";
import { validateCsv } from "../core/contract";
import type { CountExpectation, CsvContract, SqlServerIntegratedConnection, SqlServerObjectInfo, ValidationIssue, ValidationResult } from "../core/model";
import { generateSqlServerValidation, sqlIdentifier } from "../core/sql-server-generator";
import { canonicalSqlServerColumn, physicalSqlServerColumn, type ResolvedSqlServerTarget } from "../core/sql-server-targets";

export interface SqlServerValidationOptions {
  maxIssues?: number;
  scopeValue?: string;
}

type SqlApi = typeof sql;

interface SqlPoolHandle {
  api: SqlApi;
  pool: sql.ConnectionPool;
}

interface ObjectMetadataRow {
  schemaName: string;
  objectName: string;
  objectType: "table" | "view";
  columnName: string;
  ordinal: number;
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
  private readonly pools = new Map<string, SqlPoolHandle>();

  public constructor(private readonly resolveConnectionString: (profile: string) => Promise<string> | string) {}

  public async dispose(): Promise<void> {
    await Promise.all([...this.pools.values()].map(({ pool }) => pool.close()));
    this.pools.clear();
  }

  public async validate(
    contract: CsvContract,
    target: ResolvedSqlServerTarget,
    options: SqlServerValidationOptions = {}
  ): Promise<ValidationResult> {
    const handle = await this.getPool(target.connection, target.integratedConnection);
    const metadata = await readMetadata(handle, target);
    if (metadata.length === 0) throw new Error(`SQL Server object ${target.schema}.${target.table} does not exist or is not visible to this connection.`);
    const metadataIssues = validateMetadata(contract, target, metadata);
    const generated = generateSqlServerValidation(contract, {
      target,
      declareScopeParameter: false,
      includeDetailQueries: false
    });
    const declared = Object.keys(contract.schema.columns);
    const present = new Set(metadata.map((column) => column.name));
    const mustFallback = generated.warnings.length > 0 || declared.some((column) => !present.has(physicalSqlServerColumn(target, column)));
    const scopeValue = resolveScopeValue(target, options.scopeValue);
    if (mustFallback) {
      const fallback = await validateClientSide(handle, contract, target, metadata, scopeValue);
      const reason = generated.warnings.length
        ? generated.warnings.join(" ")
        : "One or more declared columns are absent, so rules that reference optional columns must preserve CSV-compatible behavior.";
      const fallbackNotice: ValidationIssue = {
        level: "file",
        code: "SQL_CLIENT_FALLBACK",
        message: `Used an exact read-only client fallback for this database object. ${reason}`,
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

    const request = handle.pool.request();
    bindScope(request, handle.api, target, scopeValue);
    const executed = await request.query(generated.sql);
    const summaries = (((executed.recordsets as sql.IRecordSet<unknown>[])[0]) ?? []) as unknown as SummaryRow[];
    assertCompleteSqlSummaries(generated.rules.map((rule) => rule.id), summaries);
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
        column: summary.ColumnName ? canonicalSqlServerColumn(target, summary.ColumnName) : undefined,
        testId: summary.RuleId,
        actual: failures,
        expected: 0,
        severity: summary.Severity
      };
      if (issues.length < (options.maxIssues ?? 1000)) issues.push(issue);
      if (summary.Severity === "warning") warningCount += failures;
      else errorCount += failures;
    }
    const rowCount = await readRowCount(handle, target, scopeValue);
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

  public async listObjects(profile: string): Promise<SqlServerObjectInfo[]> {
    const handle = await this.getPool(profile);
    const result = await handle.pool.request().query<ObjectMetadataRow>(`
SELECT
  s.name AS schemaName,
  o.name AS objectName,
  CASE WHEN o.type = N'V' THEN N'view' ELSE N'table' END AS objectType,
  c.name AS columnName,
  c.column_id AS ordinal
FROM sys.objects AS o
JOIN sys.schemas AS s ON s.schema_id = o.schema_id
JOIN sys.columns AS c ON c.object_id = o.object_id
WHERE o.type IN (N'U', N'V') AND o.is_ms_shipped = 0
ORDER BY s.name, o.name, c.column_id;`);
    const objects = new Map<string, SqlServerObjectInfo>();
    for (const row of result.recordset) {
      const key = `${row.schemaName}\u0000${row.objectName}`;
      const object = objects.get(key) ?? {
        schema: row.schemaName,
        name: row.objectName,
        objectType: row.objectType,
        columns: []
      };
      object.columns.push(row.columnName);
      objects.set(key, object);
    }
    return [...objects.values()];
  }

  private async getPool(profile: string, integrated?: SqlServerIntegratedConnection): Promise<SqlPoolHandle> {
    const key = integrated ? `integrated:${JSON.stringify(integrated)}` : `profile:${profile}`;
    const existing = this.pools.get(key);
    if (existing) return existing;
    let handle: SqlPoolHandle;
    if (integrated) {
      if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Bundled Windows integrated authentication requires Windows x64. Use a connection profile on other platforms.");
      const nativeSql = (await import("mssql/msnodesqlv8")).default;
      const connectionString = integratedConnectionString(integrated);
      const nativeConfig = {
        server: integrated.server,
        database: integrated.database,
        driver: "msnodesqlv8",
        connectionString,
        options: {
          trustedConnection: true,
          encrypt: integrated.encrypt ?? true,
          trustServerCertificate: integrated.trustServerCertificate ?? false
        }
      } as sql.config & { connectionString: string };
      const pool = await new nativeSql.ConnectionPool(nativeConfig).connect();
      handle = { api: nativeSql as SqlApi, pool: pool as sql.ConnectionPool };
    } else {
      const connectionString = await this.resolveConnectionString(profile);
      if (!connectionString.trim()) throw new Error(`SQL Server connection profile '${profile}' is empty.`);
      handle = { api: sql, pool: await new sql.ConnectionPool(connectionString).connect() };
    }
    this.pools.set(key, handle);
    return handle;
  }
}

function odbcValue(value: string): string {
  if (!value.trim() || [...value].some((character) => character.charCodeAt(0) < 32)) {
    throw new Error("Integrated SQL Server connection values must be non-empty and cannot contain control characters.");
  }
  return `{${value.replaceAll("}", "}}")}}`;
}

export function integratedConnectionString(connection: SqlServerIntegratedConnection): string {
  const driver = connection.odbcDriver?.trim() || "ODBC Driver 18 for SQL Server";
  return [
    `Driver=${odbcValue(driver)}`,
    `Server=${odbcValue(connection.server)}`,
    `Database=${odbcValue(connection.database)}`,
    "Trusted_Connection=Yes",
    `Encrypt=${connection.encrypt ?? true ? "Yes" : "No"}`,
    `TrustServerCertificate=${connection.trustServerCertificate ?? false ? "Yes" : "No"}`,
    `Application Name=${odbcValue("CSV Contract Workbench")}`
  ].join(";") + ";";
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

function bindScope(request: sql.Request, api: SqlApi, target: ResolvedSqlServerTarget, value: string | undefined): void {
  if (target.scope) request.input(target.scope.parameter, api.NVarChar(api.MAX), value);
}

async function readMetadata(handle: SqlPoolHandle, target: ResolvedSqlServerTarget): Promise<MetadataRow[]> {
  const result = await handle.pool.request()
    .input("schema", handle.api.NVarChar(128), target.schema)
    .input("table", handle.api.NVarChar(128), target.table)
    .query<MetadataRow>(`
SELECT c.name, c.column_id AS ordinal
FROM sys.columns AS c
JOIN sys.objects AS o ON o.object_id = c.object_id AND o.type IN (N'U', N'V')
JOIN sys.schemas AS s ON s.schema_id = o.schema_id
WHERE s.name = @schema AND o.name = @table
ORDER BY c.column_id;`);
  return result.recordset;
}

async function readRowCount(handle: SqlPoolHandle, target: ResolvedSqlServerTarget, scopeValue: string | undefined): Promise<number> {
  const request = handle.pool.request();
  bindScope(request, handle.api, target, scopeValue);
  const scope = target.scope
    ? `WHERE CONVERT(nvarchar(max), t.${sqlIdentifier(physicalSqlServerColumn(target, target.scope.column))}) = CONVERT(nvarchar(max), @${target.scope.parameter})`
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

function validateMetadata(contract: CsvContract, target: ResolvedSqlServerTarget, metadata: MetadataRow[]): ValidationIssue[] {
  const issues = countIssues("COLUMN_COUNT", metadata.length, contract.schema.columnCount);
  const actual = metadata.map((column) => column.name);
  const actualSet = new Set(actual);
  const declared = Object.keys(contract.schema.columns);
  for (const [column, definition] of Object.entries(contract.schema.columns)) {
    const physical = physicalSqlServerColumn(target, column);
    if (definition.presence === "required" && !actualSet.has(physical)) {
      issues.push({ level: "column", code: "REQUIRED_COLUMN_MISSING", message: `Required column "${column}" is missing (expected SQL column "${physical}").`, column });
    }
  }
  if (contract.schema.allowAdditionalColumns === false) {
    const declaredSet = new Set(declared.map((column) => physicalSqlServerColumn(target, column)));
    for (const column of actual) if (!declaredSet.has(column)) issues.push({ level: "column", code: "ADDITIONAL_COLUMN", message: `Undeclared column "${column}" is not allowed.`, column });
  }
  if (contract.schema.columnOrder === "exact") {
    const expected = declared.map((column) => physicalSqlServerColumn(target, column)).filter((column) => actualSet.has(column));
    const filteredActual = actual.filter((column) => new Set(declared.map((name) => physicalSqlServerColumn(target, name))).has(column));
    if (expected.some((column, index) => filteredActual[index] !== column) || expected.length !== filteredActual.length) {
      issues.push({ level: "file", code: "COLUMN_ORDER_MISMATCH", message: "SQL Server columns do not follow the declaration order in schema.columns." });
    }
  }
  return issues;
}

async function validateClientSide(
  handle: SqlPoolHandle,
  contract: CsvContract,
  target: ResolvedSqlServerTarget,
  metadata: MetadataRow[],
  scopeValue: string | undefined
): Promise<ValidationResult> {
  const present = new Set(metadata.map((column) => column.name));
  const columns = Object.keys(contract.schema.columns).filter((column) => present.has(physicalSqlServerColumn(target, column)));
  if (columns.length === 0) {
    return { valid: false, rowCount: await readRowCount(handle, target, scopeValue), columnCount: metadata.length, testCount: contractTestCount(contract), issueCount: 0, errorCount: 0, warningCount: 0, truncated: false, issues: [] };
  }
  const projection = columns.map((column) => `CONVERT(nvarchar(max), t.${sqlIdentifier(physicalSqlServerColumn(target, column))}) AS ${sqlIdentifier(column)}`).join(", ");
  const scope = target.scope
    ? `WHERE CONVERT(nvarchar(max), t.${sqlIdentifier(physicalSqlServerColumn(target, target.scope.column))}) = CONVERT(nvarchar(max), @${target.scope.parameter})`
    : "";
  const request = handle.pool.request();
  bindScope(request, handle.api, target, scopeValue);
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

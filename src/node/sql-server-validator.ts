import { errorDetails } from "../core/error-details";
import { resolveEvaluation } from "../core/evaluation";
import { validatePreviewOptions, type PreviewOptions } from "../core/preview";
import { crossResult, type CrossPlan } from "../core/cross-checks";
import { baselineIssues, type BaselineColumn, type SchemaBaseline } from "../core/baseline";
import sql from "mssql";
import { assertCompleteSqlSummaries } from "../core/sql-server-results";
import Papa from "papaparse";
import { validateCsv } from "../core/contract";
import type { CountExpectation, CsvContract, SqlServerIntegratedConnection, SqlServerObjectInfo, ValidationIssue, ValidationResult } from "../core/model";
import { generateSqlServerValidation, sqlIdentifier } from "../core/sql-server-generator";
import { canonicalSqlServerColumn, physicalSqlServerColumn, type ResolvedSqlServerTarget } from "../core/sql-server-targets";
import { OrderedRuleEvaluator, orderedColumns, compareOrderedRows } from "../core/ordered-rule";
import { RowSortStore } from "./row-sort-store";
import { GroupTestRunner, type GroupSummary } from "./group-runner";

export interface SqlServerValidationOptions {
  preview?: PreviewOptions;
  evaluatedAt?: string;
  signal?: AbortSignal;
  maxIssues?: number;
  scopeValue?: string;
}

type SqlApi = typeof sql;

interface SqlPoolHandle {
  api: SqlApi;
  pool: sql.ConnectionPool;
  closeFailures?: unknown[];
}

async function closePool(handle: SqlPoolHandle): Promise<void> {
  await handle.pool.close();
  if (handle.closeFailures?.length) throw new AggregateError(handle.closeFailures, "SQL driver could not confirm connection closure.");
}

interface ObjectMetadataRow {
  schemaName: string;
  objectName: string;
  objectType: "table" | "view";
  columnName: string;
  ordinal: number;
}

interface SummaryRow {
  SelectedCount?: number | string | null;
  RuleId: string;
  RuleName: string;
  Severity: "error" | "warning";
  Code: string;
  ColumnName: string;
  FailureCount: number | string;
}

type MetadataRow = BaselineColumn;

export async function queryWithCancellation<T>(request: Pick<sql.Request, "query" | "cancel">, query: string, signal?: AbortSignal): Promise<sql.IResult<T>> {
  signal?.throwIfAborted();
  const cancel = () => { request.cancel(); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const retries = runtimeInteger("CSV_CONTRACT_SQL_RETRIES", 0, 2);
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      try { return await request.query<T>(`SET IMPLICIT_TRANSACTIONS OFF;\n${query}`); }
      catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
        if (signal?.aborted || attempt >= retries || !["ETIMEOUT", "ESOCKET", "ECONNRESET"].includes(code)) throw error;
        await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
  }
  finally { signal?.removeEventListener("abort", cancel); }
}

function runtimeInteger(name: string, fallback: number, maximum: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) > maximum) throw new Error(`${name} must be an integer from 0 to ${maximum}.`);
  return Number(value);
}

export class SqlServerValidationSession {
  public async validateCross(plan: CrossPlan, signal?: AbortSignal): Promise<ValidationResult> {
    const fromValue = resolveScopeValue(plan.from), toValue = resolveScopeValue(plan.to);
    const handle = await this.getPool(plan.from.connection, plan.from.integratedConnection);
    const request = handle.pool.request();
    bindScope(request, handle.api, plan.from, fromValue);
    bindScope(request, handle.api, plan.to, toValue);
    const result = await queryWithCancellation<{ FailureCount: number | string }>(request, plan.sql, signal);
    if (result.recordset.length !== 1) throw new Error("Cross-check did not return one aggregate summary.");
    return crossResult(plan.check, result.recordset[0].FailureCount);
  }
  private readonly pools = new Map<string, SqlPoolHandle>();
  private closed = false;

  public constructor(private readonly resolveConnectionString: (profile: string) => Promise<string> | string) {}

  public async dispose(): Promise<void> {
    this.closed = true;
    const outcomes = await Promise.allSettled([...this.pools.values()].map(closePool));
    this.pools.clear();
    const failures = outcomes.flatMap(outcome => outcome.status === "rejected" ? [outcome.reason] : []);
    if (failures.length) throw new AggregateError(failures, "One or more SQL connection pools failed to close.");
  }

  public async validate(
    contract: CsvContract,
    target: ResolvedSqlServerTarget,
    options: SqlServerValidationOptions = {}
  ): Promise<ValidationResult> {
    const evaluatedAt = options.evaluatedAt ?? new Date().toISOString();
    const result = await this.validateResolved(resolveEvaluation(contract, evaluatedAt), target, options);
    return { ...result, evaluatedAt };
  }
  private async validateResolved(contract: CsvContract, target: ResolvedSqlServerTarget, options: SqlServerValidationOptions): Promise<ValidationResult> {
    if (target.baseline) contract = { ...contract, baseline: target.baseline };
    if (options.preview) validatePreviewOptions(options.preview);
    if (options.preview && (contract.groupTests?.length || contract.orderedRules?.length)) {
      throw new Error("SQL preview does not support grouped or ordered rules; run the complete contract.");
    }
    const handle = await this.getPool(target.connection, target.integratedConnection);
    const metadata = await readMetadata(handle, target, options.signal);
    if (metadata.length === 0) throw new Error(`SQL Server object ${target.schema}.${target.table} does not exist or is not visible to this connection.`);
    const metadataIssues = validateMetadata(contract, target, metadata);
    if (contract.baseline) metadataIssues.push(...baselineIssues(contract, sqlSchemaSnapshot(target, metadata), target.columnMap));
    const generated = generateSqlServerValidation(contract, {
      target,
      declareScopeParameter: false,
      includeDetailQueries: false
    });
    const declared = Object.keys(contract.schema.columns);
    const present = new Set(metadata.map((column) => column.name));
    const mustFallback = generated.warnings.length > 0 || declared.some((column) => !present.has(physicalSqlServerColumn(target, column)));
    const scopeValue = resolveScopeValue(target, options.scopeValue);
    const sequence = contract.orderedRules?.length ? await validateSqlSequences(handle, contract, target, metadata, scopeValue,
      options.maxIssues ?? 1000, options.signal) : undefined;
    const grouped = contract.groupTests?.length ? await validateSqlGroups(handle, contract, target, metadata, scopeValue,
      options.maxIssues ?? 1000, options.signal) : undefined;
    if (mustFallback || options.preview) {
      const fallback = await validateClientSide(handle, { ...contract, baseline: undefined, orderedRules: undefined, groupTests: undefined }, target, metadata, scopeValue, options.signal, options.preview);
      const reason = options.preview ? "Explicit preview uses the shared predicate engine to collect bounded examples." : generated.warnings.length
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
      return mergeGroups(mergeSequence(mergeMetadataIssues(withNotice, metadataIssues, metadata.length, options.maxIssues ?? 1000), sequence, options.maxIssues ?? 1000), grouped, options.maxIssues ?? 1000);
    }

    if (generated.rules.length === 0) {
      const rowCount = await readRowCount(handle, target, scopeValue, options.signal);
      const errors = metadataIssues.filter(issue => issue.severity !== "warning").length;
      const warnings = metadataIssues.length - errors;
      return mergeGroups(mergeSequence({ valid: errors === 0, rowCount, columnCount: metadata.length,
        testCount: contractTestCount(contract), issueCount: metadataIssues.length, errorCount: errors,
        warningCount: warnings, truncated: metadataIssues.length > (options.maxIssues ?? 1000),
        issues: metadataIssues.slice(0, options.maxIssues ?? 1000) }, sequence, options.maxIssues ?? 1000), grouped, options.maxIssues ?? 1000);
    }
    const request = handle.pool.request();
    bindScope(request, handle.api, target, scopeValue);
    const executed = await queryWithCancellation(request, generated.sql, options.signal);
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
    const rowCount = await readRowCount(handle, target, scopeValue, options.signal);
    const issueCount = errorCount + warningCount;
    return mergeGroups(mergeSequence({
      valid: errorCount === 0,
      ruleOutcomes: summaries.filter(s => s.SelectedCount != null).map(s => {
        const selected = Number(s.SelectedCount), failed = Number(s.FailureCount);
        if (!Number.isSafeInteger(selected) || selected < failed) throw new Error(`Invalid selected-row count for ${s.RuleId}.`);
        return { id: s.RuleId, selected, failed, passed: selected - failed };
      }),
      rowCount,
      columnCount: metadata.length,
      testCount: contractTestCount(contract),
      issueCount,
      errorCount,
      warningCount,
      truncated: issueCount > issues.length,
      issues
    }, sequence, options.maxIssues ?? 1000), grouped, options.maxIssues ?? 1000);
  }

  public async listObjects(profile: string): Promise<SqlServerObjectInfo[]> {
    const handle = await this.getPool(profile);
    const result = await queryWithCancellation<ObjectMetadataRow>(handle.pool.request(), `
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

  public async captureSchema(target: ResolvedSqlServerTarget): Promise<SchemaBaseline> {
    const columns = await readMetadata(await this.getPool(target.connection, target.integratedConnection), target);
    if (!columns.length) throw new Error("Object metadata is empty: object missing or not visible to this connection.");
    return sqlSchemaSnapshot(target, columns);
  }

  private async getPool(profile: string, integrated?: SqlServerIntegratedConnection): Promise<SqlPoolHandle> {
    if (this.closed) throw new Error("SQL session is closed.");
    const requestTimeout = runtimeInteger("CSV_CONTRACT_SQL_TIMEOUT_MS", 15000, 600000);
    if (requestTimeout < 1) throw new Error("CSV_CONTRACT_SQL_TIMEOUT_MS must be at least 1; unbounded queries are not supported.");
    const key = integrated ? `integrated:${JSON.stringify(integrated)}` : `profile:${profile}`;
    const existing = this.pools.get(key);
    if (existing) return existing;
    const closeFailures: unknown[] = [];
    let handle: SqlPoolHandle;
    if (integrated) {
      if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Bundled Windows integrated authentication requires Windows x64. Use a connection profile on other platforms.");
      const nativeSql = (await import("mssql/msnodesqlv8")).default;
      const nativeDriver = (await import("msnodesqlv8")).default;
      const connectionString = integratedConnectionString(integrated);
      const nativeConfig = {
        server: integrated.server,
        database: integrated.database,
        driver: "msnodesqlv8",
        connectionString,
        requestTimeout,
        options: {
          trustedConnection: true,
          encrypt: integrated.encrypt ?? true,
          trustServerCertificate: integrated.trustServerCertificate ?? false
        }
      } as sql.config & { connectionString: string };
      // mssql wraps non-Error ODBC objects with Error(object), losing diagnostics.
      // Keep the normal pool/request lifecycle, but normalize at the open boundary.
      class DiagnosticPool extends nativeSql.ConnectionPool {
        _poolDestroy(connection: { close(callback: (error?: unknown) => void): void }) {
          return new Promise<void>((resolve, reject) => {
            connection.close(error => {
              if (error) { const diagnostic = new Error(errorDetails(error)); closeFailures.push(diagnostic); reject(diagnostic); }
              else resolve();
            });
          });
        }
        _poolCreate() {
          return new Promise<import("msnodesqlv8/types").Connection>((resolve, reject) => {
            nativeDriver.open({ conn_str: connectionString, conn_timeout: 15 }, (error, connection) => {
              if (error) { reject(new Error(errorDetails(error))); return; }
              connection.setUseUTC(true);
              resolve(connection);
            });
          });
        }
      }
      const pool = new DiagnosticPool(nativeConfig);
      handle = { api: nativeSql as SqlApi, pool: pool as sql.ConnectionPool };
    } else {
      const connectionString = await this.resolveConnectionString(profile);
      if (!connectionString.trim()) throw new Error(`SQL Server connection profile '${profile}' is empty.`);
      const pool = new sql.ConnectionPool({ ...sql.ConnectionPool.parseConnectionString(connectionString), requestTimeout });
      handle = { api: sql, pool };
    }
    handle.closeFailures = closeFailures;
    this.pools.set(key, handle);
    try {
      await handle.pool.connect();
      // Tarn logs destroy errors/timeouts instead of rejecting pool.destroy(). Retain them.
      const resources = (handle.pool as unknown as { pool?: { on(event: string, listener: (id: number, resource: unknown, error: unknown) => void): void } }).pool;
      resources?.on("destroyFail", (_id, _resource, error) => { closeFailures.push(error); });
    }
    catch (error) {
      try { await closePool(handle); this.pools.delete(key); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "SQL connection failed and cleanup also failed."); }
      throw error;
    }
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

interface SequenceSummary { issues: ValidationIssue[]; issueCount: number; ruleOutcomes: NonNullable<ValidationResult["ruleOutcomes"]> }

function mergeSequence(result: ValidationResult, summary: SequenceSummary | undefined, maximum: number): ValidationResult {
  if (!summary) return result;
  const issues = [...result.issues, ...summary.issues].slice(0, maximum);
  return { ...result, valid: result.valid && summary.issueCount === 0,
    testCount: result.testCount + summary.ruleOutcomes.length,
    ruleOutcomes: [...(result.ruleOutcomes ?? []), ...summary.ruleOutcomes],
    issueCount: result.issueCount + summary.issueCount,
    errorCount: result.errorCount + summary.issueCount,
    truncated: result.truncated || result.issueCount + summary.issueCount > issues.length, issues };
}

function mergeGroups(result: ValidationResult, summaries: GroupSummary[] | undefined, maximum: number): ValidationResult {
  if (!summaries) return result;
  for (const summary of summaries) {
    const issues = [...result.issues, ...summary.issues].slice(0, maximum);
    result = { ...result, valid: result.valid && summary.errorCount === 0,
      testCount: result.testCount + summary.testCount,
      ruleOutcomes: [...(result.ruleOutcomes ?? []), ...summary.ruleOutcomes],
      groupOutcomes: [...(result.groupOutcomes ?? []), { id: summary.groupCounts[0].id,
        groups: summary.groupCounts[0].count, passed: summary.passedGroups, failed: summary.failedGroups },
        ...summary.nestedGroupOutcomes],
      issueCount: result.issueCount + summary.issueCount,
      errorCount: result.errorCount + summary.errorCount,
      warningCount: result.warningCount + summary.warningCount,
      truncated: result.truncated || result.issueCount + summary.issueCount > issues.length, issues };
  }
  return result;
}

async function validateSqlGroups(handle: SqlPoolHandle, contract: CsvContract, target: ResolvedSqlServerTarget,
  metadata: MetadataRow[], scopeValue: string | undefined, maximum: number, signal?: AbortSignal): Promise<GroupSummary[]> {
  const headers = [...new Set(metadata.map(m => canonicalSqlServerColumn(target, m.name)))];
  const projection = headers.map(c => `CONVERT(nvarchar(max), t.${sqlIdentifier(physicalSqlServerColumn(target, c))}) AS ${sqlIdentifier(c)}`).join(", ");
  const scope = target.scope ? `WHERE CONVERT(nvarchar(max), t.${sqlIdentifier(physicalSqlServerColumn(target, target.scope.column))}) = CONVERT(nvarchar(max), @${target.scope.parameter})` : "";
  const runners = (contract.groupTests ?? []).map(group => new GroupTestRunner(group, headers, contract.csv ?? {},
    group.resolvedSource ?? "<sql-contract>"));
  try {
    const batch = 2000;
    const locator = contract.sqlServer?.rowLocator;
    if (!locator?.length) throw new Error("Grouped SQL validation requires sqlServer.rowLocator for bounded ordered reads.");
    const order = [...locator, ...headers.filter(c => !locator.includes(c))]
      .map(c => `CONVERT(nvarchar(4000), t.${sqlIdentifier(physicalSqlServerColumn(target, c))}) COLLATE Latin1_General_100_BIN2`).join(", ");
    for (let offset = 0; ; offset += batch) {
      signal?.throwIfAborted();
      const request = handle.pool.request();
      bindScope(request, handle.api, target, scopeValue);
      const rows = await queryWithCancellation<Record<string, string | null>>(request,
        `SELECT ${projection} FROM ${sqlIdentifier(target.schema)}.${sqlIdentifier(target.table)} AS t ${scope} ORDER BY ${order} OFFSET ${offset} ROWS FETCH NEXT ${batch} ROWS ONLY;`, signal);
      rows.recordset.forEach((record, index) => runners.forEach(runner => runner.add(offset + index + 1,
        headers.map(h => record[h] == null ? "" : String(record[h])))));
      if (rows.recordset.length < batch) break;
    }
    return await Promise.all(runners.map(runner => runner.finish(maximum)));
  } finally { runners.forEach(runner => runner.dispose()); }
}

async function validateSqlSequences(handle: SqlPoolHandle, contract: CsvContract, target: ResolvedSqlServerTarget,
  metadata: MetadataRow[], scopeValue: string | undefined, maximum: number, signal?: AbortSignal): Promise<SequenceSummary> {
  const issues: ValidationIssue[] = [];
  let issueCount = 0;
  const add = (issue: ValidationIssue): void => { issueCount++; if (issues.length < maximum) issues.push(issue); };
  const present = new Set(metadata.map(m => m.name));
  const outcomes: NonNullable<ValidationResult["ruleOutcomes"]> = [];
  for (const rule of contract.orderedRules ?? []) {
    const columns = orderedColumns(rule);
    const missing = columns.filter(c => !present.has(physicalSqlServerColumn(target, c)));
    if (missing.length) {
      for (const column of missing) add({ level: "column", code: "SEQUENCE_COLUMN_MISSING", testId: rule.id,
        column, message: `Sequence ${rule.id} requires SQL column ${physicalSqlServerColumn(target, column)}.` });
      continue;
    }
    const store = new RowSortStore((a, b) => compareOrderedRows(a, b, rule, contract.csv ?? {}));
    try {
      const projection = columns.map(c => `CONVERT(nvarchar(max), t.${sqlIdentifier(physicalSqlServerColumn(target, c))}) AS ${sqlIdentifier(c)}`).join(", ");
      const order = [...(rule.partitionBy ?? []).map(c => `t.${sqlIdentifier(physicalSqlServerColumn(target, c))}`),
        ...rule.orderBy.map(k => k.type === "date" ? `TRY_CONVERT(date, t.${sqlIdentifier(physicalSqlServerColumn(target, k.column))}, 111)` :
          k.type === "number" ? `TRY_CONVERT(decimal(38, 10), t.${sqlIdentifier(physicalSqlServerColumn(target, k.column))})` :
            `t.${sqlIdentifier(physicalSqlServerColumn(target, k.column))}`),
        ...columns.map(c => `CONVERT(nvarchar(4000), t.${sqlIdentifier(physicalSqlServerColumn(target, c))}) COLLATE Latin1_General_100_BIN2`)].join(", ");
      const scope = target.scope ? `WHERE CONVERT(nvarchar(max), t.${sqlIdentifier(physicalSqlServerColumn(target, target.scope.column))}) = CONVERT(nvarchar(max), @${target.scope.parameter})` : "";
      const batch = 2000;
      for (let offset = 0; ; offset += batch) {
        signal?.throwIfAborted();
        const request = handle.pool.request();
        bindScope(request, handle.api, target, scopeValue);
        const result = await queryWithCancellation<Record<string, string | null>>(request,
          `SELECT ${projection} FROM ${sqlIdentifier(target.schema)}.${sqlIdentifier(target.table)} AS t ${scope} ORDER BY ${order} OFFSET ${offset} ROWS FETCH NEXT ${batch} ROWS ONLY;`, signal);
        result.recordset.forEach((record, index) => store.add({ row: offset + index + 1,
          values: Object.fromEntries(columns.map(c => [c, record[c] == null ? "" : String(record[c])])) }));
        if (result.recordset.length < batch) break;
      }
      const evaluator = new OrderedRuleEvaluator(rule, contract.csv ?? {}, add);
      for await (const row of store.rows()) evaluator.add(row);
      evaluator.finish();
      outcomes.push(...evaluator.ruleOutcomes);
    } finally { store.dispose(); }
  }
  return { issues, issueCount, ruleOutcomes: outcomes };
}

function resolveScopeValue(target: ResolvedSqlServerTarget, explicit?: string): string | undefined {
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

async function readMetadata(handle: SqlPoolHandle, target: ResolvedSqlServerTarget, signal?: AbortSignal): Promise<MetadataRow[]> {
  const request = handle.pool.request()
    .input("schema", handle.api.NVarChar(128), target.schema)
    .input("table", handle.api.NVarChar(128), target.table);
  const result = await queryWithCancellation<MetadataRow>(request, `
SELECT c.name, c.column_id AS ordinal, TYPE_NAME(c.user_type_id) AS sqlType,
  CONVERT(int, c.max_length) AS maxLength, CONVERT(int, c.precision) AS precision,
  CONVERT(int, c.scale) AS scale, c.is_nullable AS nullable,
  c.is_identity AS [identity], c.is_computed AS computed, c.collation_name AS collation,
  (SELECT i.name, ic.key_ordinal AS ordinal FROM sys.index_columns ic
    JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
    WHERE ic.object_id = c.object_id AND ic.column_id = c.column_id AND i.is_unique = 1 AND ic.key_ordinal > 0
    ORDER BY i.name, ic.key_ordinal FOR JSON PATH) AS uniqueKeys,
  COALESCE((SELECT ic.key_ordinal FROM sys.index_columns ic
    JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
    WHERE ic.object_id = c.object_id AND ic.column_id = c.column_id AND i.is_primary_key = 1), 0) AS primaryKeyOrdinal
FROM sys.columns AS c
JOIN sys.objects AS o ON o.object_id = c.object_id AND o.type IN (N'U', N'V')
JOIN sys.schemas AS s ON s.schema_id = o.schema_id
WHERE s.name = @schema AND o.name = @table
ORDER BY c.column_id;`, signal);
  return result.recordset;
}

export function sqlSchemaSnapshot(target: { schema: string; table: string }, columns: BaselineColumn[]): SchemaBaseline {
  return { baselineVersion: 1, revision: 1, capturedAt: new Date().toISOString(), sourceKind: "sql", captureMethod: "sql-metadata",
    object: { schema: target.schema, name: target.table }, columns: structuredClone(columns) };
}

async function readRowCount(handle: SqlPoolHandle, target: ResolvedSqlServerTarget, scopeValue: string | undefined, signal?: AbortSignal): Promise<number> {
  const request = handle.pool.request();
  bindScope(request, handle.api, target, scopeValue);
  const scope = target.scope
    ? `WHERE CONVERT(nvarchar(max), t.${sqlIdentifier(physicalSqlServerColumn(target, target.scope.column))}) = CONVERT(nvarchar(max), @${target.scope.parameter})`
    : "";
  const result = await queryWithCancellation<{ count: number | string }>(request, `SELECT COUNT_BIG(*) AS count FROM ${sqlIdentifier(target.schema)}.${sqlIdentifier(target.table)} AS t ${scope};`, signal);
  const count = result.recordset[0]?.count;
  if (count === undefined || count === null || !Number.isSafeInteger(Number(count)) || Number(count) < 0) throw new Error("SQL row-count query did not return a valid count.");
  return Number(count);
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
  scopeValue: string | undefined,
  signal?: AbortSignal,
  preview?: PreviewOptions
): Promise<ValidationResult> {
  const present = new Set(metadata.map((column) => column.name));
  const columns = Object.keys(contract.schema.columns).filter((column) => present.has(physicalSqlServerColumn(target, column)));
  if (columns.length === 0) {
    return { valid: false, rowCount: await readRowCount(handle, target, scopeValue, signal), columnCount: metadata.length, testCount: contractTestCount(contract), issueCount: 0, errorCount: 0, warningCount: 0, truncated: false, issues: [] };
  }
  const projections = columns.map((column) => `CONVERT(nvarchar(max), t.${sqlIdentifier(physicalSqlServerColumn(target, column))}) AS ${sqlIdentifier(column)}`);
  const dateAliases = new Map<string, string>();
  for (const column of columns) {
    const physical = physicalSqlServerColumn(target, column);
    const type = metadata.find(m => m.name === physical)?.sqlType?.toLowerCase();
    if (!type || !["date", "datetime", "datetime2", "smalldatetime", "datetimeoffset"].includes(type)) continue;
    let alias = `__csv_contract_date_${dateAliases.size}`;
    while (columns.includes(alias) || [...dateAliases.values()].includes(alias)) alias += "_";
    dateAliases.set(column, alias);
    // Date predicates receive ISO values; ordinary string rules retain the legacy representation.
    const iso = `CONVERT(nvarchar(40), t.${sqlIdentifier(physical)}, 127)`;
    projections.push(`${type === "date" || type === "datetimeoffset" ? iso : `${iso} + N'Z'`} AS ${sqlIdentifier(alias)}`);
  }
  const projection = projections.join(", ");
  const scope = target.scope
    ? `WHERE CONVERT(nvarchar(max), t.${sqlIdentifier(physicalSqlServerColumn(target, target.scope.column))}) = CONVERT(nvarchar(max), @${target.scope.parameter})`
    : "";
  const request = handle.pool.request();
  bindScope(request, handle.api, target, scopeValue);
  const result = await queryWithCancellation<Record<string, string | null>>(request, `SELECT ${preview?.rowLimit ? `TOP (${preview.rowLimit}) ` : ""}${projection} FROM ${sqlIdentifier(target.schema)}.${sqlIdentifier(target.table)} AS t ${scope};`, signal);
  const rows = result.recordset.map((row) => columns.map((column) => row[column] ?? ""));
  const fallbackContract: CsvContract = {
    ...contract,
    schema: { ...contract.schema, allowAdditionalColumns: true, columnCount: undefined, columnOrder: undefined },
    rules: [...(contract.rules ?? []), ...((contract.sqlServer?.conditionalRules ?? []) as NonNullable<CsvContract["rules"]>)]
  };
  const nativeDates = Object.fromEntries([...dateAliases].map(([column, alias]) => [column, result.recordset.map(row => row[alias] ?? undefined)]));
  return validateCsv(fallbackContract, Papa.unparse({ fields: columns, data: rows }), nativeDates, undefined, preview);
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

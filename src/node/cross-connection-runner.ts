import { evaluateCsvCrossCheck, type CrossExecutor, type CrossPlan, type CsvCrossPlan, type SqlCrossConnectionParticipant, type SqlCrossConnectionPlan } from "../core/cross-checks";
import type { ParsedCsv, ValidationResult } from "../core/model";
import { physicalSqlServerColumn } from "../core/sql-server-targets";
import { safeSqlType, sqlIdentifier } from "../core/sql-server-generator";

export const DEFAULT_CROSS_CONNECTION_MAX_ROWS = 50_000;
export const HARD_CROSS_CONNECTION_MAX_ROWS = 250_000;
export const HARD_CROSS_CONNECTION_MAX_PARTICIPANTS = 16;
export const HARD_CROSS_CONNECTION_MAX_TOTAL_ROWS = 500_000;
export const HARD_CROSS_CONNECTION_MAX_BYTES = 64 * 1024 * 1024;
export const HARD_CROSS_CONNECTION_MAX_VALUE_LENGTH = 64 * 1024;
const SQL_NULL = "\u0000__csv_contract_sql_null__";

export type CrossConnectionValue = string | number | boolean | bigint | Date | null | undefined;
export type CrossConnectionRow = Record<string, CrossConnectionValue>;

export interface CrossConnectionReadRequest {
  participant: string;
  /** A read-only SELECT against exactly one target. It never joins across connections. */
  sql: string;
  columns: ReadonlyArray<{ logical: string; physical: string }>;
  /** maxRows + 1, so overflow is detectable rather than silently truncated. */
  rowLimit: number;
  target: SqlCrossConnectionParticipant["target"];
  scope?: { parameter: "cross_scope"; sqlType: string; value: string };
  readOnly: true;
}

export interface CrossConnectionReadResult {
  rows: CrossConnectionRow[];
  /** Adapters must set this if they impose any lower limit than rowLimit. */
  limited?: boolean;
}

export interface CrossConnectionSourceAdapter {
  read(request: CrossConnectionReadRequest, signal?: AbortSignal): Promise<CrossConnectionReadResult>;
}

export interface CrossConnectionQueryBinding { name: "cross_scope"; sqlType: string; value: string }
export type CrossConnectionQuery = (
  target: SqlCrossConnectionParticipant["target"],
  sql: string,
  bindings: readonly CrossConnectionQueryBinding[],
  rowLimit: number,
  signal?: AbortSignal
) => Promise<CrossConnectionReadResult>;

/** Adapts a host/session bounded query primitive without duplicating connection or cancellation logic. */
export function createCrossConnectionSourceAdapter(query: CrossConnectionQuery): CrossConnectionSourceAdapter {
  return {
    read: (request, signal) => query(request.target, request.sql,
      request.scope ? [{ name: request.scope.parameter, sqlType: request.scope.sqlType, value: request.scope.value }] : [],
      request.rowLimit, signal)
  };
}

export interface CrossConnectionRunOptions {
  /** Host-level ceiling. It can lower, but never raise, the contract limit. */
  maxRows?: number;
  /** Required for every scoped participant, keyed by suite member id. */
  scopeValues?: Readonly<Record<string, string>>;
  maxTotalRows?: number;
  maxBytes?: number;
  maxValueLength?: number;
}

export function createCrossConnectionExecutor(adapter: CrossConnectionSourceAdapter, options: CrossConnectionRunOptions = {}): CrossExecutor {
  return async (plan, signal) => {
    if (plan.mode !== "sql-cross-connection") throw new Error(`Cross-connection executor does not support '${plan.mode}' plans.`);
    return runCrossConnectionCheck(plan, adapter, { ...options, signal });
  };
}

/** Routes only the explicit cross-connection plan to this runner and preserves the host's existing executor for all other modes. */
export function withCrossConnectionExecutor(base: CrossExecutor, adapter: CrossConnectionSourceAdapter, options: CrossConnectionRunOptions = {}): CrossExecutor {
  const crossConnection = createCrossConnectionExecutor(adapter, options);
  return (plan, signal) => plan.mode === "sql-cross-connection" ? crossConnection(plan, signal) : base(plan, signal);
}

export async function runCrossConnectionCheck(
  plan: SqlCrossConnectionPlan,
  adapter: CrossConnectionSourceAdapter,
  options: CrossConnectionRunOptions & { signal?: AbortSignal } = {}
): Promise<ValidationResult> {
  const contractLimit = boundedLimit(plan.maxRows, "crossConnection.maxRows", DEFAULT_CROSS_CONNECTION_MAX_ROWS);
  const hostLimit = boundedLimit(options.maxRows, "host maxRows", HARD_CROSS_CONNECTION_MAX_ROWS);
  const maxRows = Math.min(contractLimit, hostLimit, HARD_CROSS_CONNECTION_MAX_ROWS);
  const maxTotalRows = boundedResource(options.maxTotalRows, "maxTotalRows", HARD_CROSS_CONNECTION_MAX_TOTAL_ROWS);
  const maxBytes = boundedResource(options.maxBytes, "maxBytes", HARD_CROSS_CONNECTION_MAX_BYTES);
  const maxValueLength = boundedResource(options.maxValueLength, "maxValueLength", HARD_CROSS_CONNECTION_MAX_VALUE_LENGTH);
  const byMember = new Map<string, SqlCrossConnectionParticipant>();
  const targetKey = (participant: SqlCrossConnectionParticipant) => JSON.stringify({ ...participant.target,
    scope: participant.target.scope ? { ...participant.target.scope, parameter: "cross_scope" } : undefined });
  for (const participant of [plan.from, plan.to, ...Object.values(plan.participants)]) {
    const existing = byMember.get(participant.member);
    if (!existing) byMember.set(participant.member, { ...participant, columns: [...participant.columns] });
    else {
      if (targetKey(existing) !== targetKey(participant)) throw new Error(`Cross-check ${plan.check.id}: reused member '${participant.member}' resolved to incompatible targets.`);
      existing.columns = [...new Set([...existing.columns, ...participant.columns])].sort((a, b) => a.localeCompare(b));
    }
  }
  const ordered = [...byMember.values()];
  if (ordered.length > HARD_CROSS_CONNECTION_MAX_PARTICIPANTS) throw new Error(`Cross-check ${plan.check.id}: ${ordered.length} participants exceed the controlled ${HARD_CROSS_CONNECTION_MAX_PARTICIPANTS}-participant limit.`);
  if (ordered.some(participant => participant.columns.length > 256)) throw new Error(`Cross-check ${plan.check.id}: a participant exceeds the controlled 256-column limit.`);
  // Validate every scope and build every request before reading any source.
  const requests = ordered.map(participant => ({ participant, request: buildCrossConnectionReadRequest(participant, maxRows, options.scopeValues) }));
  const loaded = new Map<string, ParsedCsv>();
  const materialized = { rows: 0, bytes: 0 };
  for (const { participant, request } of requests) {
    throwIfCanceled(options.signal, participant.member);
    const result = await adapter.read(request, options.signal);
    throwIfCanceled(options.signal, participant.member);
    if (!result || !Array.isArray(result.rows)) throw new Error(`Cross-check ${plan.check.id}: source '${participant.member}' returned an invalid row collection.`);
    if (result.limited || result.rows.length > maxRows) {
      throw new Error(`Cross-check ${plan.check.id}: source '${participant.member}' exceeded the controlled ${maxRows}-row limit; result is unsupported and was not evaluated.`);
    }
    materialized.rows += result.rows.length;
    if (materialized.rows > maxTotalRows) throw new Error(`Cross-check ${plan.check.id}: total materialization exceeded the controlled ${maxTotalRows}-row limit.`);
    loaded.set(participant.member, rowsAsParsedCsv(participant.columns, result.rows, participant.member, materialized, maxBytes, maxValueLength, options.signal));
  }
  throwIfCanceled(options.signal, "evaluation");
  const fromCsv = loaded.get(plan.from.member)!, toCsv = loaded.get(plan.to.member)!;
  const csvPlan: CsvCrossPlan = {
    mode: "csv",
    check: plan.check,
    from: { contract: withSqlNull(plan.from.contract), source: plan.from.member, target: { path: plan.from.member } },
    to: { contract: withSqlNull(plan.to.contract), source: plan.to.member, target: { path: plan.to.member } },
    participants: Object.fromEntries(Object.entries(plan.participants).map(([id, participant]) => [id, {
      contract: withSqlNull(participant.contract), source: participant.member, target: { path: participant.member }
    }]))
  };
  const evaluated = evaluateCsvCrossCheck(csvPlan, fromCsv, toCsv,
    Object.fromEntries(Object.keys(plan.participants).map(id => [id, loaded.get(id)!])));
  throwIfCanceled(options.signal, "evaluation");
  return evaluated;
}

export function buildCrossConnectionReadRequest(
  participant: SqlCrossConnectionParticipant,
  maxRows: number,
  scopeValues: Readonly<Record<string, string>> | undefined
): CrossConnectionReadRequest {
  boundedLimit(maxRows, "maxRows", maxRows);
  const columns = participant.columns.map(logical => ({ logical, physical: physicalSqlServerColumn(participant.target, logical) }));
  const projection = columns.length
    // Text projection prevents SQL bigint/decimal values from being rounded by a JavaScript driver.
    // Style 126 also gives date/time values a stable ISO-compatible representation.
    ? columns.map(column => `LEFT(CONVERT(nvarchar(max), ${sqlIdentifier(column.physical)}, 126), ${HARD_CROSS_CONNECTION_MAX_VALUE_LENGTH + 1}) AS ${sqlIdentifier(column.logical)}`).join(", ")
    : `CAST(1 AS bit) AS [__csv_contract_row]`;
  const target = `${sqlIdentifier(participant.target.schema)}.${sqlIdentifier(participant.target.table)}`;
  let scope: CrossConnectionReadRequest["scope"];
  let where = "";
  if (participant.target.scope) {
    const value = scopeValues?.[participant.member];
    if (value === undefined) throw new Error(`Cross-connection source '${participant.member}' requires a runtime scope value.`);
    scope = { parameter: "cross_scope", sqlType: participant.target.scope.sqlType, value };
    where = ` WHERE ${sqlIdentifier(physicalSqlServerColumn(participant.target, participant.target.scope.column))} = TRY_CONVERT(${safeSqlType(participant.target.scope.sqlType)}, @cross_scope)`;
  }
  return {
    participant: participant.member,
    sql: `SELECT TOP (${maxRows + 1}) ${projection} FROM ${target}${where};`,
    columns,
    rowLimit: maxRows + 1,
    target: participant.target,
    ...(scope ? { scope } : {}),
    readOnly: true
  };
}

function boundedLimit(value: number | undefined, label: string, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > HARD_CROSS_CONNECTION_MAX_ROWS) {
    throw new Error(`${label} must be an integer from 1 through ${HARD_CROSS_CONNECTION_MAX_ROWS}.`);
  }
  return resolved;
}

function boundedResource(value: number | undefined, label: string, maximum: number): number {
  const resolved = value ?? maximum;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) throw new Error(`${label} must be an integer from 1 through ${maximum}.`);
  return resolved;
}

function throwIfCanceled(signal: AbortSignal | undefined, participant: string): void {
  if (signal?.aborted) throw new Error(`Cross-connection source '${participant}' was canceled.`);
}

function rowsAsParsedCsv(headers: string[], rows: CrossConnectionRow[], participant: string, materialized: { bytes: number }, maxBytes: number, maxValueLength: number, signal?: AbortSignal): ParsedCsv {
  const scalar = (value: CrossConnectionValue): string => {
    if (value === null || value === undefined) return SQL_NULL;
    if (value instanceof Date) {
      if (!Number.isFinite(value.getTime())) throw new Error(`Cross-connection source '${participant}' returned an invalid Date value.`);
      return value.toISOString();
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value)) {
        throw new Error(`Cross-connection source '${participant}' returned a numeric value that cannot be represented exactly; the adapter must project it as text.`);
      }
      return String(value);
    }
    if (["string", "boolean", "bigint"].includes(typeof value)) return String(value);
    throw new Error(`Cross-connection source '${participant}' returned an unsupported non-scalar value.`);
  };
  return {
    headers: [...headers],
    rows: rows.map((row, rowIndex) => headers.map(header => {
      if ((rowIndex & 255) === 0) throwIfCanceled(signal, participant);
      const value = scalar(row[header]);
      if (value.length > maxValueLength) throw new Error(`Cross-connection source '${participant}' returned a value longer than the controlled ${maxValueLength}-character limit.`);
      materialized.bytes += Buffer.byteLength(value, "utf8");
      if (materialized.bytes > maxBytes) throw new Error(`Cross-connection materialization exceeded the controlled ${maxBytes}-byte limit.`);
      return value;
    })),
    sourceRowNumbers: rows.map((_, index) => index + 1),
    parseErrors: []
  };
}

function withSqlNull(contract: SqlCrossConnectionParticipant["contract"]): SqlCrossConnectionParticipant["contract"] {
  const nullValues = [...new Set([...(contract.csv?.nullValues ?? [""]), SQL_NULL])];
  return { ...contract, csv: { ...contract.csv, nullValues } };
}

// Compile-time assurance that adding another plan mode cannot silently route here.
export type CrossConnectionCompatiblePlan = Extract<CrossPlan, { mode: "sql-cross-connection" }>;

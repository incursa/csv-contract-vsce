import type { CsvContract, ValidationResult } from "./model";
import { resolveSqlServerTargets, physicalSqlServerColumn, type ResolvedSqlServerTarget } from "./sql-server-targets";
import { sqlIdentifier } from "./sql-server-generator";
export interface CrossCheck {
  id: string;
  kind: "foreignKey" | "equalPopulation" | "equalTotal";
  from: string;
  to: string;
  keys?: { from: string; to: string }[];
  valueColumns?: { from: string; to: string };
  /** Nonnegative decimal tolerance, retained as a literal string. */
  tolerance?: string;
  nulls?: "ignore" | "fail";
  severity?: "error" | "warning";
}
export interface CrossPlan { check: CrossCheck; from: ResolvedSqlServerTarget; to: ResolvedSqlServerTarget; sql: string }
export type CrossExecutor = (plan: CrossPlan, signal?: AbortSignal) => Promise<ValidationResult>;
export function planCrossCheck(check: CrossCheck, members: { id: string; contract?: CsvContract; error?: string }[]): CrossPlan {
  const find = (id: string) => {
    const member = members.find(m => m.id === id);
    if (!member?.contract || member.error) throw new Error(`Cross-check ${check.id}: member '${id}' is unavailable.`);
    const targets = resolveSqlServerTargets(member.contract);
    if (targets.length !== 1) throw new Error(`Cross-check ${check.id}: '${id}' requires exactly one SQL target.`);
    if (targets[0].scope) throw new Error(`Cross-check ${check.id}: scoped comparisons require an explicit cross-table scope design; this version only supports complete objects.`);
    return { target: targets[0], contract: member.contract };
  };
  const left = find(check.from), right = find(check.to);
  const from = left.target, to = right.target;
  if (JSON.stringify(from.integratedConnection ?? from.connection) !== JSON.stringify(to.integratedConnection ?? to.connection)) throw new Error(`Cross-check ${check.id}: targets must use the same connection and database.`);
  const object = (t: ResolvedSqlServerTarget) => `${sqlIdentifier(t.schema)}.${sqlIdentifier(t.table)}`;
  let sql: string;
  if (check.kind === "equalPopulation") sql = `SELECT ABS((SELECT COUNT_BIG(*) FROM ${object(from)}) - (SELECT COUNT_BIG(*) FROM ${object(to)})) AS FailureCount;`;
  else if (check.kind === "equalTotal") {
    const columns = check.valueColumns;
    if (!columns || !left.contract.schema.columns[columns.from] || !right.contract.schema.columns[columns.to]) throw new Error(`Cross-check ${check.id}: equalTotal requires declared valueColumns.`);
    const tolerance = check.tolerance ?? "0";
    if (!/^(?:0|[1-9]\d{0,17})(?:\.\d{1,10})?$/.test(tolerance)) throw new Error("Total tolerance must be a nonnegative decimal with at most 18 integer and 10 fractional digits.");
    const aggregate = (target: ResolvedSqlServerTarget, column: string) => {
      const field = sqlIdentifier(physicalSqlServerColumn(target, column));
      // Invalid values must not disappear through SUM's null-elision behavior.
      return `SELECT CAST(COALESCE(SUM(TRY_CONVERT(decimal(28,10), ${field})), 0) AS decimal(28,10)) AS Total, SUM(CAST(CASE WHEN ${field} IS NULL THEN ${check.nulls === "fail" ? 1 : 0} WHEN NULLIF(LTRIM(RTRIM(CONVERT(nvarchar(max), ${field}))), N'') IS NULL OR TRY_CONVERT(decimal(28,10), ${field}) IS NULL THEN 1 ELSE 0 END AS bigint)) AS Invalid FROM ${object(target)}`;
    };
    sql = `SELECT CASE WHEN COALESCE(a.Invalid,0) + COALESCE(b.Invalid,0) > 0 OR ABS(a.Total-b.Total) > CAST('${tolerance}' AS decimal(38,10)) THEN 1 ELSE 0 END AS FailureCount FROM (${aggregate(from, columns.from)}) a CROSS JOIN (${aggregate(to, columns.to)}) b;`;
  }
  else {
    if (!check.keys?.length) throw new Error(`Cross-check ${check.id}: foreignKey requires keys.`);
    for (const key of check.keys) if (!left.contract.schema.columns[key.from] || !right.contract.schema.columns[key.to]) throw new Error(`Cross-check ${check.id}: undeclared key column.`);
    const keys = check.keys.map(k => ({ from: `a.${sqlIdentifier(physicalSqlServerColumn(from, k.from))}`, to: `b.${sqlIdentifier(physicalSqlServerColumn(to, k.to))}` }));
    const present = keys.map(k => `${k.from} IS NOT NULL`).join(" AND ");
    const equality = keys.map(k => `${k.from} = ${k.to}`).join(" AND ");
    const missing = `NOT EXISTS (SELECT 1 FROM ${object(to)} AS b WHERE ${equality})`;
    sql = `SELECT COUNT_BIG(*) AS FailureCount FROM ${object(from)} AS a WHERE ${check.nulls === "fail" ? `NOT (${present}) OR (${missing})` : `(${present}) AND (${missing})`};`;
  }
  return { check, from, to, sql };
}
export function crossResult(check: CrossCheck, count: unknown): ValidationResult {
  const failures = Number(count);
  if (count === null || count === undefined || String(count).trim() === "" || !Number.isSafeInteger(failures) || failures < 0) throw new Error(`Invalid cross-check summary for ${check.id}.`);
  const warning = check.severity === "warning";
  return { valid: !failures || warning, rowCount: 0, columnCount: 0, testCount: 1, issueCount: failures, errorCount: warning ? 0 : failures, warningCount: warning ? failures : 0,
    truncated: false, issues: failures ? [{ level: "row", code: "CROSS_CHECK_FAILED", testId: check.id, severity: check.severity ?? "error", actual: failures, expected: 0, message: `${check.kind}: ${failures} ${check.kind === "foreignKey" ? "orphan rows" : check.kind === "equalTotal" ? "total mismatch or invalid numeric/null inputs" : "rows of population difference"} (${check.from} → ${check.to}). Aggregate only; no example rows retrieved.` }] : [] };
}

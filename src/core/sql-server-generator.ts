import type {
  ConditionalRule,
  CsvContract,
  Predicate,
  PredicateLeaf,
  RuleSeverity,
  SqlConditionalRule
} from "./model";
import { resolveSqlServerTargets, type ResolvedSqlServerTarget } from "./sql-server-targets";
import { createPhysicalSqlContract } from "./sql-server-column-mapping";
import { resolveEvaluation } from "./evaluation";

export interface SqlGeneratedRule {
  id: string;
  name: string;
  severity: RuleSeverity;
  code: string;
  column?: string;
}

export interface SqlGenerationOptions {
  evaluatedAt?: string;
  target?: ResolvedSqlServerTarget;
  /** Adds provenance columns without changing any check predicate. */
  suite?: { id: string; member: string };
  /** Generated files declare a placeholder. Runtime execution supplies a bound parameter instead. */
  declareScopeParameter?: boolean;
  /** Standalone scripts include diagnostic rows; direct report execution only needs aggregate results. */
  includeDetailQueries?: boolean;
}

export interface SqlGenerationResult {
  sql: string;
  ruleCount: number;
  warnings: string[];
  rules: SqlGeneratedRule[];
}

interface GeneratedRule extends SqlGeneratedRule {
  selected?: string;
  violation?: string;
  failureCountSql?: string;
}

export function sqlIdentifier(value: string): string {
  if (!value.trim()) throw new Error("SQL Server identifiers cannot be blank.");
  return `[${value.replaceAll("]", "]]")}]`;
}

function sqlString(value: string): string {
  return `N'${value.replace(/'/g, "''")}'`;
}

function text(column: string, alias = "t"): string {
  return `CONVERT(nvarchar(max), ${alias}.${sqlIdentifier(column)})`;
}

function normalizedText(column: string, caseSensitive: boolean, trimValues: boolean, alias = "t"): string {
  let value = text(column, alias);
  if (trimValues) value = `LTRIM(RTRIM(${value}))`;
  return caseSensitive ? `${value} COLLATE Latin1_General_100_BIN2` : `LOWER(${value}) COLLATE Latin1_General_100_BIN2`;
}

function normalizedLiteral(value: string, caseSensitive: boolean, trimValues: boolean): string {
  const normalized = trimValues ? value.trim() : value;
  return caseSensitive ? `${sqlString(normalized)} COLLATE Latin1_General_100_BIN2` : `LOWER(${sqlString(normalized)}) COLLATE Latin1_General_100_BIN2`;
}

function requireLeafShape(predicate: PredicateLeaf): void {
  const valueOperators = new Set([
    "equals", "notEquals", "contains", "notContains", "startsWith", "endsWith", "matches",
    "greaterThan", "greaterThanOrEqual", "lessThan", "lessThanOrEqual"
  ]);
  if (valueOperators.has(predicate.operator) && predicate.value === undefined && !predicate.otherColumn) throw new Error(`${predicate.operator} on ${predicate.column} requires value or otherColumn.`);
  if ((predicate.operator === "in" || predicate.operator === "notIn") && (!predicate.values || predicate.values.length === 0)) {
    throw new Error(`${predicate.operator} on ${predicate.column} requires at least one value.`);
  }
  if ((predicate.operator === "equalsColumn" || predicate.operator === "notEqualsColumn") && !predicate.otherColumn) {
    throw new Error(`${predicate.operator} on ${predicate.column} requires otherColumn.`);
  }
}

function predicateColumns(predicate: Predicate): string[] {
  if ("all" in predicate) return predicate.all.flatMap(predicateColumns);
  if ("any" in predicate) return predicate.any.flatMap(predicateColumns);
  return [predicate.column, predicate.otherColumn].filter((value): value is string => value !== undefined);
}

function predicateSql(predicate: Predicate, caseSensitive: boolean, trimValues: boolean, nullValues: string[]): string | undefined {
  if ("all" in predicate) {
    if (!Array.isArray(predicate.all) || predicate.all.length === 0) throw new Error("A conditional rule 'all' group cannot be empty.");
    const parts = predicate.all.map((item) => predicateSql(item, caseSensitive, trimValues, nullValues));
    return parts.some((part) => part === undefined) ? undefined : `(${parts.join(" AND ")})`;
  }
  if ("any" in predicate) {
    if (!Array.isArray(predicate.any) || predicate.any.length === 0) throw new Error("A conditional rule 'any' group cannot be empty.");
    const parts = predicate.any.map((item) => predicateSql(item, caseSensitive, trimValues, nullValues));
    return parts.some((part) => part === undefined) ? undefined : `(${parts.join(" OR ")})`;
  }
  requireLeafShape(predicate);
  if (predicate.operator === "matches" || predicate.operator.startsWith("date") || (predicate.valueType && predicate.valueType !== "string") || predicate.caseSensitive !== undefined || predicate.decimalPlaces !== undefined) return undefined;
  const column = `t.${sqlIdentifier(predicate.column)}`;
  const columnText = normalizedText(predicate.column, caseSensitive, trimValues);
  const comparable = `COALESCE(${columnText}, ${normalizedLiteral("", caseSensitive, trimValues)})`;
  const value = predicate.value === undefined ? "" : String(predicate.value);
  switch (predicate.operator) {
    case "equals": return `(${comparable} = ${normalizedLiteral(value, caseSensitive, trimValues)})`;
    case "notEquals": return `(${comparable} <> ${normalizedLiteral(value, caseSensitive, trimValues)})`;
    case "in":
    case "notIn": {
      const values = predicate.values!.map((item) => normalizedLiteral(item, caseSensitive, trimValues)).join(", ");
      return `(${comparable} ${predicate.operator === "notIn" ? "NOT " : ""}IN (${values}))`;
    }
    case "isNull": return nullViolation(predicate.column, nullValues, caseSensitive, trimValues);
    case "notNull": return `(NOT ${nullViolation(predicate.column, nullValues, caseSensitive, trimValues)})`;
    case "isBlank": return `(${column} IS NULL OR LTRIM(RTRIM(${text(predicate.column)})) = N'')`;
    case "notBlank": return `(${column} IS NOT NULL AND LTRIM(RTRIM(${text(predicate.column)})) <> N'')`;
    case "equalsColumn":
    case "notEqualsColumn": {
      const otherText = `COALESCE(${normalizedText(predicate.otherColumn!, caseSensitive, trimValues)}, ${normalizedLiteral("", caseSensitive, trimValues)})`;
      return `(${comparable} ${predicate.operator === "equalsColumn" ? "=" : "<>"} ${otherText})`;
    }
    case "contains": return `(CHARINDEX(${normalizedLiteral(value, caseSensitive, trimValues)}, ${comparable}) > 0)`;
    case "notContains": return `(CHARINDEX(${normalizedLiteral(value, caseSensitive, trimValues)}, ${comparable}) = 0)`;
    case "startsWith": return `(LEFT(${comparable}, LEN(${normalizedLiteral(value, caseSensitive, trimValues)})) = ${normalizedLiteral(value, caseSensitive, trimValues)})`;
    case "endsWith": return `(RIGHT(${comparable}, LEN(${normalizedLiteral(value, caseSensitive, trimValues)})) = ${normalizedLiteral(value, caseSensitive, trimValues)})`;
    case "greaterThan":
    case "greaterThanOrEqual":
    case "lessThan":
    case "lessThanOrEqual": {
      const operator = { greaterThan: ">", greaterThanOrEqual: ">=", lessThan: "<", lessThanOrEqual: "<=" }[predicate.operator];
      const right = predicate.value !== undefined ? sqlString(value) : text(predicate.otherColumn!);
      return `(CASE WHEN LEN(LTRIM(RTRIM(${text(predicate.column)}))) > 0 AND LEN(LTRIM(RTRIM(${right}))) > 0 AND TRY_CONVERT(float, ${text(predicate.column)}) ${operator} TRY_CONVERT(float, ${right}) THEN 1 ELSE 0 END = 1)`;
    }
  }
}

function nullViolation(column: string, nullValues: string[], caseSensitive: boolean, trimValues: boolean): string {
  const markers = nullValues.length
    ? ` OR ${normalizedText(column, caseSensitive, trimValues)} IN (${nullValues.map((value) => normalizedLiteral(value, caseSensitive, trimValues)).join(", ")})`
    : "";
  return `(t.${sqlIdentifier(column)} IS NULL${markers})`;
}

function addConditionalRule(
  output: GeneratedRule[], warnings: string[], rule: ConditionalRule | SqlConditionalRule,
  caseSensitive: boolean, trimValues: boolean, nullValues: string[]
): void {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(rule.id)) throw new Error(`Conditional rule ID '${rule.id}' is invalid.`);
  const expected = predicateSql(rule.expect as Predicate, caseSensitive, trimValues, nullValues);
  const when = rule.when ? predicateSql(rule.when as Predicate, caseSensitive, trimValues, nullValues) : "(1 = 1)";
  if (!expected || !when) {
    warnings.push(`${rule.id} uses a regex, date, typed, case or precision policy that requires exact client-side fallback when executed.`);
    return;
  }
  output.push({
    id: rule.id, name: rule.name ?? rule.id, severity: rule.severity ?? "error",
    code: "RULE_EXPECTATION_FAILED", violation: `(${when} AND NOT ${expected})`, selected: when
  });
}

export function safeSqlType(value: string): string {
  const type = value.trim();
  if (!/^(?:bigint|int|smallint|tinyint|bit|uniqueidentifier|date|datetime2(?:\([0-7]\))?|nvarchar\((?:max|[1-9][0-9]{0,3})\)|varchar\((?:max|[1-9][0-9]{0,3})\))$/i.test(type)) {
    throw new Error(`Scope sqlType '${value}' is not in the supported safe type list.`);
  }
  return type;
}

function countRule(id: string, name: string, comparison: string): GeneratedRule {
  return { id, name, severity: "error", code: id.toUpperCase().replaceAll("-", "_"), failureCountSql: `CASE WHEN ${comparison} THEN CONVERT(bigint, 1) ELSE CONVERT(bigint, 0) END` };
}

function addCountExpectations(rules: GeneratedRule[], prefix: string, name: string, countSql: string, expectation: { exact?: number; min?: number; max?: number } | undefined): void {
  if (expectation?.exact !== undefined) rules.push(countRule(`${prefix}-exact`, `${name} is exactly ${expectation.exact}`, `${countSql} <> ${expectation.exact}`));
  if (expectation?.min !== undefined) rules.push(countRule(`${prefix}-min`, `${name} is at least ${expectation.min}`, `${countSql} < ${expectation.min}`));
  if (expectation?.max !== undefined) rules.push(countRule(`${prefix}-max`, `${name} is at most ${expectation.max}`, `${countSql} > ${expectation.max}`));
}

export function generateSqlServerValidation(contract: CsvContract, options: SqlGenerationOptions = {}): SqlGenerationResult {
  contract = resolveEvaluation(contract, options.evaluatedAt ?? new Date().toISOString());
  if (!contract.sqlServer) throw new Error("The contract must declare sqlServer before SQL can be generated.");
  const logicalTarget = options.target ?? resolveSqlServerTargets(contract, false)[0];
  const mapped = createPhysicalSqlContract(contract, logicalTarget);
  const generated = generatePhysicalSqlServerValidation(mapped.contract, { ...options, target: mapped.target });
  let sql = generated.sql;
  if (contract.baseline || logicalTarget.baseline) sql = "-- Schema baseline validation requires the Workbench/CLI runtime metadata comparison; this script alone is incomplete.\n" + sql;
  const rules = generated.rules.map((rule) => {
    if (!rule.column) return rule;
    const canonical = mapped.physicalToCanonical[rule.column] ?? rule.column;
    if (canonical === rule.column) return rule;
    let id = rule.id;
    if (id.startsWith(`${rule.column}.`)) id = `${canonical}${id.slice(rule.column.length)}`;
    else if (id.endsWith(`-${rule.column}`)) id = `${id.slice(0, -rule.column.length)}${canonical}`;
    const name = rule.name.replaceAll(rule.column, canonical);
    sql = sql.replaceAll(`${sqlString(rule.id)} AS RuleId`, `${sqlString(id)} AS RuleId`)
      .replaceAll(`${sqlString(rule.name)} AS RuleName`, `${sqlString(name)} AS RuleName`)
      .replaceAll(`${sqlString(rule.column)} AS ColumnName`, `${sqlString(canonical)} AS ColumnName`);
    return { ...rule, id, name, column: canonical };
  });
  const warnings = generated.warnings.map((warning) => Object.entries(mapped.physicalToCanonical)
    .reduce((message, [physical, canonical]) => message.replaceAll(physical, canonical), warning));
  for (const [index, warning] of generated.warnings.entries()) {
    sql = sql.replaceAll(`-- WARNING: ${warning}`, `-- WARNING: ${warnings[index]}`);
  }
  return { ...generated, sql, warnings, rules };
}

function generatePhysicalSqlServerValidation(contract: CsvContract, options: SqlGenerationOptions): SqlGenerationResult {
  const config = contract.sqlServer;
  if (!config) throw new Error("The contract must declare sqlServer before SQL can be generated.");
  const target = options.target ?? resolveSqlServerTargets(contract, false)[0];
  const detailLimit = config.detailLimit ?? 100;
  if (!Number.isInteger(detailLimit) || detailLimit < 1 || detailLimit > 10000) throw new Error("sqlServer.detailLimit must be an integer from 1 through 10000.");
  const caseSensitive = contract.csv?.caseSensitive ?? true;
  const trimValues = contract.csv?.trimValues ?? false;
  const nullValues = contract.csv?.nullValues ?? [""];
  const rules: GeneratedRule[] = [];
  const warnings: string[] = [];
  const declaredColumns = new Set(Object.keys(contract.schema.columns));
  const referencedColumns = [
    ...(config.rowLocator ?? []), ...(target.scope ? [target.scope.column] : []),
    ...(config.conditionalRules ?? []).flatMap((rule) => [...(rule.when ? predicateColumns(rule.when as Predicate) : []), ...predicateColumns(rule.expect as Predicate)])
  ];
  const undeclaredColumns = [...new Set(referencedColumns.filter((column) => !declaredColumns.has(column)))];
  if (undeclaredColumns.length) throw new Error(`SQL Server configuration references undeclared contract columns: ${undeclaredColumns.join(", ")}.`);

  const table = `${sqlIdentifier(target.schema)}.${sqlIdentifier(target.table)}`;
  const scope = target.scope;
  if (scope && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(scope.parameter)) throw new Error("sqlServer.scope.parameter must be a valid SQL variable name without @.");
  const parameter = scope ? `@${scope.parameter}` : undefined;
  const scopeSql = scope ? `t.${sqlIdentifier(scope.column)} = ${parameter}` : "1 = 1";
  addCountExpectations(rules, "row-count", "Row count", `(SELECT COUNT_BIG(*) FROM ${table} AS t WHERE ${scopeSql})`, contract.schema.rowCount);

  for (const [column, definition] of Object.entries(contract.schema.columns)) {
    const constraints = definition.constraints ?? {};
    const nullCheck = nullViolation(column, nullValues, caseSensitive, trimValues);
    if (constraints.notNull) rules.push({ id: `${column}.not-null`, name: `${column} is required`, severity: "error", code: "NULL_VALUE", column, violation: nullCheck });
    if (constraints.minLength !== undefined) rules.push({ id: `${column}.min-length`, name: `${column} minimum length`, severity: "error", code: "MIN_LENGTH", column, violation: `(NOT ${nullCheck} AND LEN(${text(column)} + N'#') - 1 < ${constraints.minLength})` });
    if (constraints.maxLength !== undefined) rules.push({ id: `${column}.max-length`, name: `${column} maximum length`, severity: "error", code: "MAX_LENGTH", column, violation: `(NOT ${nullCheck} AND LEN(${text(column)} + N'#') - 1 > ${constraints.maxLength})` });
    if (constraints.allowedValues?.length) {
      const allowed = constraints.allowedValues.map((value) => normalizedLiteral(value, caseSensitive, trimValues)).join(", ");
      rules.push({ id: `${column}.allowed-values`, name: `${column} has an expected value`, severity: "error", code: "NOT_ALLOWED", column, violation: `(NOT ${nullCheck} AND ${normalizedText(column, caseSensitive, trimValues)} NOT IN (${allowed}))` });
    }
    if (constraints.unique) {
      const grouped = normalizedText(column, caseSensitive, trimValues);
      const duplicateCounts = `SELECT COUNT_BIG(*) AS duplicate_count FROM ${table} AS t WHERE (${scopeSql}) AND NOT ${nullCheck} GROUP BY ${grouped} HAVING COUNT_BIG(*) > 1`;
      rules.push({ id: `${column}.unique`, name: `${column} is unique`, severity: "error", code: "NOT_UNIQUE", column, failureCountSql: `(SELECT COALESCE(SUM(duplicate_count - 1), 0) FROM (${duplicateCounts}) AS duplicates)` });
    }
    if (constraints.matches) warnings.push(`${column}.matches uses a JavaScript regular expression and requires exact client-side fallback when executed.`);
  }

  if (contract.identity?.nulls) warnings.push("Explicit identity null policies require exact client-side fallback.");
  if (contract.identity?.unique !== false && contract.identity?.columns.length) {
    const groups = contract.identity.columns.map((column) => `COALESCE(${normalizedText(column, caseSensitive, trimValues)}, ${normalizedLiteral("", caseSensitive, trimValues)})`).join(", ");
    const duplicateCounts = `SELECT COUNT_BIG(*) AS duplicate_count FROM ${table} AS t WHERE (${scopeSql}) GROUP BY ${groups} HAVING COUNT_BIG(*) > 1`;
    rules.push({ id: contract.identity.id ?? "identity.unique", name: "Composite identity is unique", severity: "error", code: "IDENTITY_NOT_UNIQUE", failureCountSql: `(SELECT COALESCE(SUM(duplicate_count - 1), 0) FROM (${duplicateCounts}) AS duplicates)` });
  }
  for (const rule of contract.rules ?? []) addConditionalRule(rules, warnings, rule, caseSensitive, trimValues, nullValues);
  for (const rule of config.conditionalRules ?? []) addConditionalRule(rules, warnings, rule, caseSensitive, trimValues, nullValues);

  for (const test of contract.rowTests ?? []) {
    const selector = Object.entries(test.select).map(([column, value]) => `COALESCE(${normalizedText(column, caseSensitive, trimValues)}, ${normalizedLiteral("", caseSensitive, trimValues)}) = ${normalizedLiteral(value, caseSensitive, trimValues)}`).join(" AND ");
    const selectedCount = `(SELECT COUNT_BIG(*) FROM ${table} AS t WHERE (${scopeSql}) AND (${selector}))`;
    addCountExpectations(rules, `${test.id}-count`, `${test.name ?? test.id} selected row count`, selectedCount, test.expect.count ?? { exact: 1 });
    for (const [column, expectation] of Object.entries(test.expect.cells ?? {})) {
      rules.push({ id: `${test.id}-${column}`, name: `${test.name ?? test.id}: ${column} equals ${expectation.equals}`, severity: "error", code: "CELL_MISMATCH", column, violation: `((${selector}) AND COALESCE(${normalizedText(column, caseSensitive, trimValues)}, ${normalizedLiteral("", caseSensitive, trimValues)}) <> ${normalizedLiteral(expectation.equals, caseSensitive, trimValues)})` });
    }
  }

  for (const rule of contract.groupRules ?? []) {
    const when = rule.when ? predicateSql(rule.when, caseSensitive, trimValues, nullValues) : "(1 = 1)";
    if (!when) {
      warnings.push(`${rule.id} uses a JavaScript regular expression and requires exact client-side fallback when executed.`);
      continue;
    }
    const groupColumns = rule.groupBy.map((column) => `t.${sqlIdentifier(column)}`).join(", ");
    const addGroupRequirement = (required: string, contains: boolean): void => {
      const observed = contains
        ? `CHARINDEX(${normalizedLiteral(required, caseSensitive, trimValues)}, COALESCE(${normalizedText(rule.require.column, caseSensitive, trimValues)}, ${normalizedLiteral("", caseSensitive, trimValues)})) > 0`
        : `COALESCE(${normalizedText(rule.require.column, caseSensitive, trimValues)}, ${normalizedLiteral("", caseSensitive, trimValues)}) = ${normalizedLiteral(required, caseSensitive, trimValues)}`;
      const inner = `SELECT ${groupColumns} FROM ${table} AS t WHERE (${scopeSql}) AND (${when}) GROUP BY ${groupColumns} HAVING SUM(CASE WHEN ${observed} THEN 1 ELSE 0 END) = 0`;
      rules.push({ id: `${rule.id}-${contains ? "contains" : "value"}-${rules.length}`, name: `${rule.name ?? rule.id} requires ${required}`, severity: rule.severity ?? "error", code: "GROUP_REQUIRED_VALUE_MISSING", column: rule.require.column, failureCountSql: `(SELECT COUNT_BIG(*) FROM (${inner}) AS missing_groups)` });
    };
    for (const required of rule.require.values ?? []) addGroupRequirement(required, false);
    for (const required of rule.require.contains ?? []) addGroupRequirement(required, true);
  }

  const lines = [
    "/* Generated by CSV Contract Workbench. Read-only: this script performs SELECT validation only.",
    `   Target: ${sqlIdentifier(target.schema)}.${sqlIdentifier(target.table)}`,
    "   Review this script and set any declared scope parameter before execution.",
    "*/", "SET NOCOUNT ON;", ""
  ];
  if (scope && options.declareScopeParameter !== false) lines.push(`DECLARE ${parameter} ${safeSqlType(scope.sqlType)} = NULL; -- REQUIRED: set the load/batch value.`, `IF ${parameter} IS NULL THROW 50001, 'Set ${parameter} before running staging validation.', 1;`, "");
  if (rules.length) {
    lines.push(
      "-- One row per validation rule. FailureCount = 0 means the rule passed.",
      ...rules.flatMap((rule, index) => [
        index === 0 ? "SELECT" : "UNION ALL SELECT",
        `  ${options.suite ? `${sqlString(options.suite.id)} AS SuiteId, ${sqlString(options.suite.member)} AS MemberId, ${sqlString(`${target.schema}.${target.table}`)} AS TableName, ` : ""}${sqlString(rule.id)} AS RuleId, ${sqlString(rule.name)} AS RuleName, ${sqlString(rule.severity)} AS Severity, ${sqlString(rule.code)} AS Code,`,
        `  ${sqlString(rule.column ?? "")} AS ColumnName, ${rule.failureCountSql ?? `(SELECT COUNT_BIG(*) FROM ${table} AS t WHERE (${scopeSql}) AND (${rule.violation}))`} AS FailureCount, ${rule.selected ? `(SELECT COUNT_BIG(*) FROM ${table} AS t WHERE (${scopeSql}) AND (${rule.selected}))` : "CAST(NULL AS bigint)"} AS SelectedCount`
      ]),
      "ORDER BY Severity, RuleId;"
    );
    if (options.includeDetailQueries !== false) {
      lines.push("", `-- Bounded failing-row samples. At most ${detailLimit} rows are returned per rule.`);
      for (const rule of rules.filter((candidate) => candidate.violation)) {
        const locator = config.rowLocator?.length ? `${config.rowLocator.map((column) => `t.${sqlIdentifier(column)}`).join(", ")}, ` : "";
        lines.push("", `SELECT TOP (${detailLimit}) ${sqlString(rule.id)} AS RuleId, ${locator}t.*`, `FROM ${table} AS t`, `WHERE (${scopeSql}) AND (${rule.violation});`);
      }
    }
  }
  if (warnings.length) lines.push("", "-- Translation warnings:", ...warnings.map((warning) => `-- WARNING: ${warning}`));
  return {
    sql: `${lines.join("\n")}\n`,
    ruleCount: rules.length,
    warnings,
    rules: rules.map((rule) => ({ id: rule.id, name: rule.name, severity: rule.severity, code: rule.code, column: rule.column }))
  };
}

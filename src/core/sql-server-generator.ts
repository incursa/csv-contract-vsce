import type {
  CsvContract,
  SqlConditionalRule,
  SqlPredicate,
  SqlPredicateLeaf
} from "./model";

export interface SqlGenerationResult {
  sql: string;
  ruleCount: number;
  warnings: string[];
}

interface GeneratedRule {
  id: string;
  name: string;
  severity: "error" | "warning";
  violation: string;
}

function identifier(value: string): string {
  if (!value.trim()) throw new Error("SQL Server identifiers cannot be blank.");
  return `[${value.replace(/]/g, ']]')}]`;
}

function sqlString(value: string): string {
  return `N'${value.replace(/'/g, "''")}'`;
}

function text(column: string): string {
  return `CONVERT(nvarchar(max), t.${identifier(column)})`;
}

function normalizedText(column: string, caseSensitive: boolean, trimValues: boolean): string {
  let value = text(column);
  if (trimValues) value = `LTRIM(RTRIM(${value}))`;
  return caseSensitive ? `${value} COLLATE Latin1_General_100_BIN2` : `LOWER(${value})`;
}

function normalizedLiteral(value: string, caseSensitive: boolean, trimValues: boolean): string {
  const normalized = trimValues ? value.trim() : value;
  return caseSensitive ? `${sqlString(normalized)} COLLATE Latin1_General_100_BIN2` : `LOWER(${sqlString(normalized)})`;
}

function requireLeafShape(predicate: SqlPredicateLeaf): void {
  const valueOperators = new Set(["equals", "notEquals"]);
  const valuesOperators = new Set(["in", "notIn"]);
  const columnOperators = new Set(["equalsColumn", "notEqualsColumn"]);
  if (valueOperators.has(predicate.operator) && predicate.value === undefined) {
    throw new Error(`${predicate.operator} on ${predicate.column} requires value.`);
  }
  if (valuesOperators.has(predicate.operator) && (!predicate.values || predicate.values.length === 0)) {
    throw new Error(`${predicate.operator} on ${predicate.column} requires at least one value.`);
  }
  if (columnOperators.has(predicate.operator) && !predicate.otherColumn) {
    throw new Error(`${predicate.operator} on ${predicate.column} requires otherColumn.`);
  }
}

function predicateColumns(predicate: SqlPredicate): string[] {
  if ("all" in predicate) return predicate.all.flatMap(predicateColumns);
  if ("any" in predicate) return predicate.any.flatMap(predicateColumns);
  return [predicate.column, predicate.otherColumn].filter((value): value is string => value !== undefined);
}

function predicateSql(predicate: SqlPredicate, caseSensitive: boolean, trimValues: boolean): string {
  if ("all" in predicate) {
    if (!Array.isArray(predicate.all) || predicate.all.length === 0) throw new Error("A conditional rule 'all' group cannot be empty.");
    return `(${predicate.all.map((item) => predicateSql(item, caseSensitive, trimValues)).join(" AND ")})`;
  }
  if ("any" in predicate) {
    if (!Array.isArray(predicate.any) || predicate.any.length === 0) throw new Error("A conditional rule 'any' group cannot be empty.");
    return `(${predicate.any.map((item) => predicateSql(item, caseSensitive, trimValues)).join(" OR ")})`;
  }
  requireLeafShape(predicate);
  const column = `t.${identifier(predicate.column)}`;
  const columnText = normalizedText(predicate.column, caseSensitive, trimValues);
  switch (predicate.operator) {
    case "equals":
      return `(${column} IS NOT NULL AND ${columnText} = ${normalizedLiteral(predicate.value!, caseSensitive, trimValues)})`;
    case "notEquals":
      return `(${column} IS NOT NULL AND ${columnText} <> ${normalizedLiteral(predicate.value!, caseSensitive, trimValues)})`;
    case "in":
    case "notIn": {
      const values = predicate.values!.map((value) => normalizedLiteral(value, caseSensitive, trimValues)).join(", ");
      return `(${column} IS NOT NULL AND ${columnText} ${predicate.operator === "notIn" ? "NOT " : ""}IN (${values}))`;
    }
    case "isNull": return `(${column} IS NULL)`;
    case "notNull": return `(${column} IS NOT NULL)`;
    case "isBlank": return `(${column} IS NOT NULL AND LTRIM(RTRIM(${text(predicate.column)})) = N'')`;
    case "notBlank": return `(${column} IS NOT NULL AND LTRIM(RTRIM(${text(predicate.column)})) <> N'')`;
    case "equalsColumn":
    case "notEqualsColumn": {
      const other = `t.${identifier(predicate.otherColumn!)}`;
      const otherText = normalizedText(predicate.otherColumn!, caseSensitive, trimValues);
      return `(${column} IS NOT NULL AND ${other} IS NOT NULL AND ${columnText} ${predicate.operator === "equalsColumn" ? "=" : "<>"} ${otherText})`;
    }
  }
}

function nullViolation(column: string, nullValues: string[], caseSensitive: boolean, trimValues: boolean): string {
  const sqlNull = `t.${identifier(column)} IS NULL`;
  const markers = nullValues.length
    ? ` OR ${normalizedText(column, caseSensitive, trimValues)} IN (${nullValues.map((value) => normalizedLiteral(value, caseSensitive, trimValues)).join(", ")})`
    : "";
  return `(${sqlNull}${markers})`;
}

function addConditionalRule(
  output: GeneratedRule[],
  rule: SqlConditionalRule,
  caseSensitive: boolean,
  trimValues: boolean
): void {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(rule.id)) throw new Error(`Conditional rule ID '${rule.id}' is invalid.`);
  const expected = predicateSql(rule.expect, caseSensitive, trimValues);
  const when = rule.when ? predicateSql(rule.when, caseSensitive, trimValues) : "(1 = 1)";
  output.push({
    id: rule.id,
    name: rule.name ?? rule.id,
    severity: rule.severity ?? "error",
    violation: `(${when} AND NOT ${expected})`
  });
}

function safeSqlType(value: string): string {
  const type = value.trim();
  if (!/^(?:bigint|int|smallint|tinyint|bit|uniqueidentifier|date|datetime2(?:\([0-7]\))?|nvarchar\((?:max|[1-9][0-9]{0,3})\)|varchar\((?:max|[1-9][0-9]{0,3})\))$/i.test(type)) {
    throw new Error(`Scope sqlType '${value}' is not in the supported safe type list.`);
  }
  return type;
}

export function generateSqlServerValidation(contract: CsvContract): SqlGenerationResult {
  const target = contract.sqlServer;
  if (!target) throw new Error("The contract must declare sqlServer.schema and sqlServer.table before SQL can be generated.");
  const detailLimit = target.detailLimit ?? 100;
  if (!Number.isInteger(detailLimit) || detailLimit < 1 || detailLimit > 10000) {
    throw new Error("sqlServer.detailLimit must be an integer from 1 through 10000.");
  }
  const caseSensitive = contract.csv?.caseSensitive ?? true;
  const trimValues = contract.csv?.trimValues ?? false;
  const nullValues = contract.csv?.nullValues ?? [""];
  const rules: GeneratedRule[] = [];
  const warnings: string[] = [];
  const declaredColumns = new Set(Object.keys(contract.schema.columns));
  const referencedColumns = [
    ...(target.rowLocator ?? []),
    ...(target.scope ? [target.scope.column] : []),
    ...(target.conditionalRules ?? []).flatMap((rule) => [
      ...(rule.when ? predicateColumns(rule.when) : []),
      ...predicateColumns(rule.expect)
    ])
  ];
  const undeclaredColumns = [...new Set(referencedColumns.filter((column) => !declaredColumns.has(column)))];
  if (undeclaredColumns.length) {
    throw new Error(`SQL Server configuration references undeclared contract columns: ${undeclaredColumns.join(", ")}.`);
  }

  for (const [column, definition] of Object.entries(contract.schema.columns)) {
    const constraints = definition.constraints ?? {};
    const nullCheck = nullViolation(column, nullValues, caseSensitive, trimValues);
    if (constraints.notNull) rules.push({ id: `${column}.not-null`, name: `${column} is required`, severity: "error", violation: nullCheck });
    if (constraints.minLength !== undefined) {
      rules.push({ id: `${column}.min-length`, name: `${column} minimum length`, severity: "error", violation: `(NOT ${nullCheck} AND LEN(${text(column)} + N'#') - 1 < ${constraints.minLength})` });
    }
    if (constraints.maxLength !== undefined) {
      rules.push({ id: `${column}.max-length`, name: `${column} maximum length`, severity: "error", violation: `(NOT ${nullCheck} AND LEN(${text(column)} + N'#') - 1 > ${constraints.maxLength})` });
    }
    if (constraints.allowedValues?.length) {
      const allowed = constraints.allowedValues.map((value) => normalizedLiteral(value, caseSensitive, trimValues)).join(", ");
      rules.push({ id: `${column}.allowed-values`, name: `${column} has an expected value`, severity: "error", violation: `(NOT ${nullCheck} AND ${normalizedText(column, caseSensitive, trimValues)} NOT IN (${allowed}))` });
    }
    if (constraints.unique) {
      const value = normalizedText(column, caseSensitive, trimValues);
      rules.push({ id: `${column}.unique`, name: `${column} is unique`, severity: "error", violation: `(NOT ${nullCheck} AND EXISTS (SELECT 1 FROM ${identifier(target.schema)}.${identifier(target.table)} AS d WHERE ${normalizedText(column, caseSensitive, trimValues).replaceAll("t.", "d.")} = ${value}${target.scope ? ` AND CONVERT(nvarchar(max), d.${identifier(target.scope.column)}) = CONVERT(nvarchar(max), @${target.scope.parameter})` : ""} GROUP BY ${normalizedText(column, caseSensitive, trimValues).replaceAll("t.", "d.")} HAVING COUNT_BIG(*) > 1))` });
    }
    if (constraints.matches) warnings.push(`${column}.matches was not generated because JavaScript regular expressions do not have an exact SQL Server equivalent.`);
  }

  if (contract.identity?.unique !== false && contract.identity?.columns.length) {
    const joins = contract.identity.columns.map((column) => `${normalizedText(column, caseSensitive, trimValues).replaceAll("t.", "d.")} = ${normalizedText(column, caseSensitive, trimValues)}`).join(" AND ");
    const groups = contract.identity.columns.map((column) => normalizedText(column, caseSensitive, trimValues).replaceAll("t.", "d.")).join(", ");
    rules.push({ id: "identity.unique", name: "Composite identity is unique", severity: "error", violation: `EXISTS (SELECT 1 FROM ${identifier(target.schema)}.${identifier(target.table)} AS d WHERE ${joins}${target.scope ? ` AND CONVERT(nvarchar(max), d.${identifier(target.scope.column)}) = CONVERT(nvarchar(max), @${target.scope.parameter})` : ""} GROUP BY ${groups} HAVING COUNT_BIG(*) > 1)` });
  }
  for (const rule of target.conditionalRules ?? []) addConditionalRule(rules, rule, caseSensitive, trimValues);
  if (contract.rowTests?.length) warnings.push("rowTests were not generated; they remain CSV-only because their exact row-count and cell semantics require a separate SQL rule model.");
  if (rules.length === 0) throw new Error("The contract does not contain any SQL-generatable constraints or conditional rules.");

  const table = `${identifier(target.schema)}.${identifier(target.table)}`;
  const scope = target.scope;
  const parameter = scope ? `@${scope.parameter}` : undefined;
  if (scope && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(scope.parameter)) throw new Error("sqlServer.scope.parameter must be a valid SQL variable name without @.");
  const scopeSql = scope ? `CONVERT(nvarchar(max), t.${identifier(scope.column)}) = CONVERT(nvarchar(max), ${parameter})` : "1 = 1";
  const lines = [
    "/* Generated by CSV Contract Workbench. Read-only: this script performs SELECT validation only.",
    `   Target: ${identifier(target.schema)}.${identifier(target.table)}`,
    "   Review this script and set any declared scope parameter before execution.",
    "*/",
    "SET NOCOUNT ON;",
    ""
  ];
  if (scope) {
    lines.push(`DECLARE ${parameter} ${safeSqlType(scope.sqlType)} = NULL; -- REQUIRED: set the load/batch value.`, `IF ${parameter} IS NULL THROW 50001, 'Set ${parameter} before running staging validation.', 1;`, "");
  }
  lines.push(
    "-- One row per validation rule. FailureCount = 0 means the rule passed.",
    ...rules.flatMap((rule, index) => [
      index === 0 ? "SELECT" : "UNION ALL SELECT",
      `  ${sqlString(rule.id)} AS RuleId, ${sqlString(rule.name)} AS RuleName, ${sqlString(rule.severity)} AS Severity,`,
      `  (SELECT COUNT_BIG(*) FROM ${table} AS t WHERE (${scopeSql}) AND (${rule.violation})) AS FailureCount`
    ]),
    "ORDER BY Severity, RuleId;",
    "",
    `-- Bounded failing-row samples. At most ${detailLimit} rows are returned per rule.`
  );
  for (const rule of rules) {
    const locator = target.rowLocator?.length ? `${target.rowLocator.map((column) => `t.${identifier(column)}`).join(", ")}, ` : "";
    lines.push(
      "",
      `SELECT TOP (${detailLimit}) ${sqlString(rule.id)} AS RuleId, ${locator}t.*`,
      `FROM ${table} AS t`,
      `WHERE (${scopeSql}) AND (${rule.violation});`
    );
  }
  if (warnings.length) lines.push("", "-- Translation warnings:", ...warnings.map((warning) => `-- WARNING: ${warning}`));
  return { sql: `${lines.join("\n")}\n`, ruleCount: rules.length, warnings };
}

import type { CsvContract, CsvTarget, FailureEvidence, ParsedCsv, ValidationResult } from "./model";
import { resolveSqlServerTargets, physicalSqlServerColumn, type ResolvedSqlServerTarget } from "./sql-server-targets";
import { sqlIdentifier } from "./sql-server-generator";
export interface CrossCheck {
  id: string;
  kind: "foreignKey" | "equalPopulation" | "equalTotal" | "rowReconciliation" | "relationship";
  from: string;
  to: string;
  keys?: { from: string; to: string }[];
  valueColumns?: { from: string; to: string };
  valueMappings?: { from: string; to: string; blankTo?: string; otherwise?: "preserve" }[];
  /** Nonnegative decimal tolerance, retained as a literal string. */
  tolerance?: string;
  nulls?: "ignore" | "fail";
  severity?: "error" | "warning";
  lookup?: { orderBy: Array<{ column: string; type: "date" | "number" | "string"; direction?: "asc" | "desc" }> };
  when?: CrossPredicate;
  expect?: CrossPredicate;
  missing?: "fail" | "ignore";
}
export interface CrossPredicateLeaf {
  side: "from" | "to";
  column: string;
  operator: "equals" | "notEquals" | "in" | "notIn" | "isNull" | "notNull" | "isBlank" | "notBlank" |
    "equalsColumn" | "notEqualsColumn" | "greaterThan" | "greaterThanOrEqual" | "lessThan" | "lessThanOrEqual" |
    "dateOnOrAfter" | "dateOnOrBefore" | "dateAfter" | "dateBefore";
  value?: string | number;
  values?: string[];
  valueType?: "string" | "number";
  other?: { side: "from" | "to"; column: string };
}
export type CrossPredicate = CrossPredicateLeaf | { all: CrossPredicate[] } | { any: CrossPredicate[] };
export interface SqlCrossPlan { mode: "sql"; check: CrossCheck; from: ResolvedSqlServerTarget; to: ResolvedSqlServerTarget; sql: string; detailSql?: string }
export interface CsvCrossParticipant { contract: CsvContract; source: string; target: CsvTarget }
export interface CsvCrossPlan { mode: "csv"; check: CrossCheck; from: CsvCrossParticipant; to: CsvCrossParticipant }
export type CrossPlan = SqlCrossPlan | CsvCrossPlan;
export type CrossExecutor = (plan: CrossPlan, signal?: AbortSignal) => Promise<ValidationResult>;
export function planCrossCheck(check: CrossCheck, members: { id: string; source?: string; contract?: CsvContract; error?: string }[]): CrossPlan {
  const find = (id: string) => {
    const member = members.find(m => m.id === id);
    if (!member?.contract || member.error) throw new Error(`Cross-check ${check.id}: member '${id}' is unavailable.`);
    const targets = resolveSqlServerTargets(member.contract);
    const files = (member.contract.targets ?? []).filter(target => target.enabled !== false);
    if (targets.length + files.length !== 1) throw new Error(`Cross-check ${check.id}: '${id}' requires exactly one enabled SQL or CSV target.`);
    return { target: targets[0], file: files[0], contract: member.contract, source: member.source ?? "" };
  };
  const left = find(check.from), right = find(check.to);
  validateCrossCheckColumns(check, left.contract, right.contract);
  if (left.file || right.file) {
    if (!left.file || !right.file) throw new Error(`Cross-check ${check.id}: mixed CSV and SQL participants are not supported; use two CSV targets or two compatible SQL targets.`);
    return { mode: "csv", check, from: { contract: left.contract, source: left.source, target: left.file }, to: { contract: right.contract, source: right.source, target: right.file } };
  }
  // Parameter namespaces are independent even when both contracts call theirs LoadId.
  const scoped = (target: ResolvedSqlServerTarget, parameter: string): ResolvedSqlServerTarget => ({ ...target, scope: target.scope ? { ...target.scope, parameter } : undefined });
  const from = scoped(left.target!, "cross_from"), to = scoped(right.target!, "cross_to");
  if (JSON.stringify(from.integratedConnection ?? from.connection) !== JSON.stringify(to.integratedConnection ?? to.connection)) throw new Error(`Cross-check ${check.id}: targets must use the same connection and database.`);
  const object = (t: ResolvedSqlServerTarget) => {
    const name = `${sqlIdentifier(t.schema)}.${sqlIdentifier(t.table)}`;
    return t.scope ? `(SELECT * FROM ${name} WHERE CONVERT(nvarchar(max), ${sqlIdentifier(physicalSqlServerColumn(t, t.scope.column))}) = CONVERT(nvarchar(max), @${t.scope.parameter}))` : name;
  };
  let sql: string;
  let detailSql: string | undefined;
  if (check.kind === "equalPopulation") sql = `SELECT ABS((SELECT COUNT_BIG(*) FROM ${object(from)} AS a) - (SELECT COUNT_BIG(*) FROM ${object(to)} AS b)) AS FailureCount;`;
  else if (check.kind === "equalTotal") {
    const columns = check.valueColumns;
    if (!columns || !left.contract.schema.columns[columns.from] || !right.contract.schema.columns[columns.to]) throw new Error(`Cross-check ${check.id}: equalTotal requires declared valueColumns.`);
    const tolerance = check.tolerance ?? "0";
    if (!/^(?:0|[1-9]\d{0,17})(?:\.\d{1,10})?$/.test(tolerance)) throw new Error("Total tolerance must be a nonnegative decimal with at most 18 integer and 10 fractional digits.");
    const aggregate = (target: ResolvedSqlServerTarget, column: string) => {
      const field = sqlIdentifier(physicalSqlServerColumn(target, column));
      // Invalid values must not disappear through SUM's null-elision behavior.
      return `SELECT CAST(COALESCE(SUM(TRY_CONVERT(decimal(28,10), ${field})), 0) AS decimal(28,10)) AS Total, SUM(CAST(CASE WHEN ${field} IS NULL THEN ${check.nulls === "fail" ? 1 : 0} WHEN NULLIF(LTRIM(RTRIM(CONVERT(nvarchar(max), ${field}))), N'') IS NULL OR TRY_CONVERT(decimal(28,10), ${field}) IS NULL THEN 1 ELSE 0 END AS bigint)) AS Invalid FROM ${object(target)} AS scoped_total`;
    };
    sql = `SELECT CASE WHEN COALESCE(a.Invalid,0) + COALESCE(b.Invalid,0) > 0 OR ABS(a.Total-b.Total) > CAST('${tolerance}' AS decimal(38,10)) THEN 1 ELSE 0 END AS FailureCount FROM (${aggregate(from, columns.from)}) a CROSS JOIN (${aggregate(to, columns.to)}) b;`;
  }
  else if (check.kind === "foreignKey") {
    if (!check.keys?.length) throw new Error(`Cross-check ${check.id}: foreignKey requires keys.`);
    for (const key of check.keys) if (!left.contract.schema.columns[key.from] || !right.contract.schema.columns[key.to]) throw new Error(`Cross-check ${check.id}: undeclared key column.`);
    const keys = check.keys.map(k => ({ from: `a.${sqlIdentifier(physicalSqlServerColumn(from, k.from))}`, to: `b.${sqlIdentifier(physicalSqlServerColumn(to, k.to))}` }));
    const present = keys.map(k => `${k.from} IS NOT NULL`).join(" AND ");
    const equality = keys.map(k => `${k.from} = ${k.to}`).join(" AND ");
    const missing = `NOT EXISTS (SELECT 1 FROM ${object(to)} AS b WHERE ${equality})`;
    const failure = check.nulls === "fail" ? `NOT (${present}) OR (${missing})` : `(${present}) AND (${missing})`;
    sql = `SELECT COUNT_BIG(*) AS FailureCount FROM ${object(from)} AS a WHERE ${failure};`;
    detailSql = `SELECT TOP (100) (SELECT a.* FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS PrimaryRowJson, CAST(NULL AS nvarchar(max)) AS RelatedRowJson FROM ${object(from)} AS a WHERE ${failure};`;
  }
  else if (check.kind === "rowReconciliation") {
    if (!check.keys?.length || !check.valueMappings?.length) throw new Error(`Cross-check ${check.id}: rowReconciliation requires keys and valueMappings.`);
    for (const key of check.keys) if (!left.contract.schema.columns[key.from] || !right.contract.schema.columns[key.to]) throw new Error(`Cross-check ${check.id}: undeclared key column.`);
    for (const mapping of check.valueMappings) {
      if (!left.contract.schema.columns[mapping.from] || !right.contract.schema.columns[mapping.to]) throw new Error(`Cross-check ${check.id}: undeclared value-mapping column.`);
      if (mapping.blankTo === undefined && mapping.otherwise !== "preserve") throw new Error(`Cross-check ${check.id}: each value mapping requires blankTo, otherwise: preserve, or both.`);
    }
    const keys = check.keys.map(k => ({ from: `a.${sqlIdentifier(physicalSqlServerColumn(from, k.from))}`, to: `b.${sqlIdentifier(physicalSqlServerColumn(to, k.to))}` }));
    const present = keys.map(k => `${k.from} IS NOT NULL`).join(" AND ");
    const equality = keys.map(k => `${k.from} = ${k.to}`).join(" AND ");
    const literal = (value: string) => `N'${value.replaceAll("'", "''")}' COLLATE Latin1_General_100_BIN2`;
    const text = (expression: string) => `CONVERT(nvarchar(max), ${expression}) COLLATE Latin1_General_100_BIN2`;
    const violations = check.valueMappings.flatMap(mapping => {
      const source = `a.${sqlIdentifier(physicalSqlServerColumn(from, mapping.from))}`;
      const target = `b.${sqlIdentifier(physicalSqlServerColumn(to, mapping.to))}`;
      const blank = `(${source} IS NULL OR NULLIF(LTRIM(RTRIM(${text(source)})), N'') IS NULL)`;
      const rules: string[] = [];
      if (mapping.blankTo !== undefined) rules.push(`(${blank} AND CASE WHEN ${text(target)} = ${literal(mapping.blankTo)} THEN 0 ELSE 1 END = 1)`);
      if (mapping.otherwise === "preserve") rules.push(`(NOT ${blank} AND CASE WHEN ${text(target)} = ${text(source)} THEN 0 ELSE 1 END = 1)`);
      return rules;
    });
    const missing = `NOT EXISTS (SELECT 1 FROM ${object(to)} AS b WHERE ${equality})`;
    const mismatch = `EXISTS (SELECT 1 FROM ${object(to)} AS b WHERE ${equality} AND (${violations.join(" OR ")}))`;
    const failure = `(${missing}) OR (${mismatch})`;
    sql = `SELECT COUNT_BIG(*) AS FailureCount FROM ${object(from)} AS a WHERE ${check.nulls === "fail" ? `NOT (${present}) OR (${failure})` : `(${present}) AND (${failure})`};`;
    const detailEquality = equality.replaceAll("b.", "candidate.");
    const detailViolations = violations.join(" OR ").replaceAll("b.", "candidate.");
    const selected = `OUTER APPLY (SELECT TOP (1) candidate.* FROM ${object(to)} AS candidate WHERE ${detailEquality} ORDER BY CASE WHEN ${detailViolations} THEN 0 ELSE 1 END) AS b`;
    const matched = `b.${sqlIdentifier(physicalSqlServerColumn(to, check.keys[0].to))} IS NOT NULL`;
    const detailFailure = `(NOT (${matched})) OR (${violations.join(" OR ")})`;
    const detailWhere = check.nulls === "fail" ? `NOT (${present}) OR (${detailFailure})` : `(${present}) AND (${detailFailure})`;
    detailSql = `SELECT TOP (100) (SELECT a.* FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS PrimaryRowJson, CASE WHEN ${matched} THEN (SELECT b.* FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) END AS RelatedRowJson FROM ${object(from)} AS a ${selected} WHERE ${detailWhere};`;
  }
  else {
    if (!check.keys?.length || !check.expect || !check.lookup?.orderBy.length) throw new Error(`Cross-check ${check.id}: relationship requires keys, lookup.orderBy, and expect.`);
    const keys = check.keys.map(k => ({ from: `a.${sqlIdentifier(physicalSqlServerColumn(from, k.from))}`, to: `candidate.${sqlIdentifier(physicalSqlServerColumn(to, k.to))}` }));
    const present = keys.map(k => `${k.from} IS NOT NULL`).join(" AND ");
    const equality = keys.map(k => `${k.from} = ${k.to}`).join(" AND ");
    const order = (check.lookup?.orderBy ?? []).map(item => {
      const column = `candidate.${sqlIdentifier(physicalSqlServerColumn(to, item.column))}`;
      const expression = item.type === "date" ? `TRY_CONVERT(datetime2, ${column})` : item.type === "number" ? `TRY_CONVERT(decimal(38,10), ${column})` : column;
      return `${expression} ${(item.direction ?? "asc").toUpperCase()}`;
    }).join(", ");
    const lookup = `OUTER APPLY (SELECT TOP (1) CONVERT(bit, 1) AS [__csv_contract_match], candidate.* FROM ${object(to)} AS candidate WHERE ${equality}${order ? ` ORDER BY ${order}` : ""}) AS b`;
    const when = crossPredicateSql(check.when, from, to, "a", "b") ?? "1 = 1";
    const expect = crossPredicateSql(check.expect, from, to, "a", "b")!;
    const missing = check.missing === "ignore" ? "1 = 0" : "b.[__csv_contract_match] IS NULL";
    const violation = `(b.[__csv_contract_match] = 1 AND (${when}) AND NOT (${expect}))`;
    const failure = check.nulls === "fail" ? `NOT (${present}) OR (${missing}) OR ${violation}` : `((${present}) AND ((${missing}) OR ${violation}))`;
    sql = `SELECT COUNT_BIG(*) AS FailureCount FROM ${object(from)} AS a ${lookup} WHERE ${failure};`;
    detailSql = `SELECT TOP (100) (SELECT a.* FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS PrimaryRowJson, CASE WHEN b.[__csv_contract_match] = 1 THEN (SELECT b.* FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) END AS RelatedRowJson FROM ${object(from)} AS a ${lookup} WHERE ${failure};`;
  }
  return { mode: "sql", check, from, to, sql, detailSql };
}

function predicateLeaves(predicate: CrossPredicate | undefined): CrossPredicateLeaf[] {
  if (!predicate) return [];
  if ("all" in predicate) return predicate.all.flatMap(predicateLeaves);
  if ("any" in predicate) return predicate.any.flatMap(predicateLeaves);
  return [predicate];
}
function validateCrossPredicate(check: CrossCheck, predicate: CrossPredicate | undefined, from: CsvContract, to: CsvContract): void {
  const noOperand = new Set(["isNull", "notNull", "isBlank", "notBlank"]);
  const valuesOperand = new Set(["in", "notIn"]);
  const columnOperand = new Set(["equalsColumn", "notEqualsColumn"]);
  const validateShape = (item: CrossPredicate): void => {
    if ("all" in item || "any" in item) {
      const children = "all" in item ? item.all : item.any;
      if (!children.length) throw new Error(`Cross-check ${check.id}: predicate groups cannot be empty.`);
      children.forEach(validateShape);
      return;
    }
    const operands = Number(item.value !== undefined) + Number(item.other !== undefined);
    if (noOperand.has(item.operator) && (operands || item.values !== undefined) ||
        valuesOperand.has(item.operator) && (!item.values?.length || operands) ||
        columnOperand.has(item.operator) && (!item.other || item.value !== undefined || item.values !== undefined) ||
        !noOperand.has(item.operator) && !valuesOperand.has(item.operator) && !columnOperand.has(item.operator) && (operands !== 1 || item.values !== undefined)) {
      throw new Error(`Cross-check ${check.id}: invalid or ambiguous predicate operands.`);
    }
    if (item.valueType === "number" && !["equals", "notEquals", "greaterThan", "greaterThanOrEqual", "lessThan", "lessThanOrEqual"].includes(item.operator)) throw new Error(`Cross-check ${check.id}: numeric valueType requires a numeric comparison operator.`);
  };
  if (predicate) validateShape(predicate);
  for (const leaf of predicateLeaves(predicate)) {
    const contract = leaf.side === "from" ? from : to;
    if (!contract.schema.columns[leaf.column]) throw new Error(`Cross-check ${check.id}: undeclared ${leaf.side} predicate column '${leaf.column}'.`);
    if (leaf.other) {
      const other = leaf.other.side === "from" ? from : to;
      if (!other.schema.columns[leaf.other.column]) throw new Error(`Cross-check ${check.id}: undeclared ${leaf.other.side} comparison column '${leaf.other.column}'.`);
    }
  }
}
function validateCrossCheckColumns(check: CrossCheck, from: CsvContract, to: CsvContract): void {
  if (check.kind === "equalPopulation") return;
  if (check.kind === "equalTotal") {
    if (!check.valueColumns || !from.schema.columns[check.valueColumns.from] || !to.schema.columns[check.valueColumns.to]) throw new Error(`Cross-check ${check.id}: equalTotal requires declared valueColumns.`);
    return;
  }
  if (!check.keys?.length) throw new Error(`Cross-check ${check.id}: ${check.kind} requires keys.`);
  for (const key of check.keys) if (!from.schema.columns[key.from] || !to.schema.columns[key.to]) throw new Error(`Cross-check ${check.id}: undeclared key column.`);
  if (check.kind === "rowReconciliation") {
    if (!check.valueMappings?.length) throw new Error(`Cross-check ${check.id}: rowReconciliation requires valueMappings.`);
    for (const mapping of check.valueMappings) if (!from.schema.columns[mapping.from] || !to.schema.columns[mapping.to]) throw new Error(`Cross-check ${check.id}: undeclared value-mapping column.`);
    return;
  }
  if (check.kind === "relationship") {
    if (!check.expect || !check.lookup?.orderBy.length) throw new Error(`Cross-check ${check.id}: relationship requires lookup.orderBy and expect.`);
    validateCrossPredicate(check, check.when, from, to);
    validateCrossPredicate(check, check.expect, from, to);
    for (const order of check.lookup.orderBy) if (!to.schema.columns[order.column]) throw new Error(`Cross-check ${check.id}: undeclared lookup order column '${order.column}'.`);
  }
}
function crossPredicateSql(predicate: CrossPredicate | undefined, from: ResolvedSqlServerTarget, to: ResolvedSqlServerTarget, fromAlias: string, toAlias: string): string | undefined {
  if (!predicate) return undefined;
  if ("all" in predicate) return `(${predicate.all.map(item => crossPredicateSql(item, from, to, fromAlias, toAlias)).join(" AND ")})`;
  if ("any" in predicate) return `(${predicate.any.map(item => crossPredicateSql(item, from, to, fromAlias, toAlias)).join(" OR ")})`;
  const target = predicate.side === "from" ? from : to;
  const alias = predicate.side === "from" ? fromAlias : toAlias;
  const column = `${alias}.${sqlIdentifier(physicalSqlServerColumn(target, predicate.column))}`;
  const text = (expression: string) => `CONVERT(nvarchar(max), ${expression}) COLLATE Latin1_General_100_BIN2`;
  const literal = (value: string | number) => `N'${String(value).replaceAll("'", "''")}'`;
  const otherTarget = predicate.other?.side === "from" ? from : to;
  const otherAlias = predicate.other?.side === "from" ? fromAlias : toAlias;
  const other = predicate.other ? `${otherAlias}.${sqlIdentifier(physicalSqlServerColumn(otherTarget, predicate.other.column))}` : undefined;
  const right = other ?? literal(predicate.value ?? "");
  const validPair = (conversion: string) => `TRY_CONVERT(${conversion}, ${column}) IS NOT NULL AND TRY_CONVERT(${conversion}, ${right}) IS NOT NULL`;
  if (predicate.valueType === "number" || ["greaterThan", "greaterThanOrEqual", "lessThan", "lessThanOrEqual"].includes(predicate.operator)) {
    const operators: Partial<Record<CrossPredicateLeaf["operator"], string>> = { equals: "=", notEquals: "<>", greaterThan: ">", greaterThanOrEqual: ">=", lessThan: "<", lessThanOrEqual: "<=" };
    const operator = operators[predicate.operator];
    if (!operator) throw new Error(`Unsupported numeric relationship operator '${predicate.operator}'.`);
    return `((${validPair("decimal(38,10)")}) AND TRY_CONVERT(decimal(38,10), ${column}) ${operator} TRY_CONVERT(decimal(38,10), ${right}))`;
  }
  if (predicate.operator.startsWith("date")) {
    const operators: Partial<Record<CrossPredicateLeaf["operator"], string>> = { dateOnOrAfter: ">=", dateOnOrBefore: "<=", dateAfter: ">", dateBefore: "<" };
    const operator = operators[predicate.operator];
    if (!operator) throw new Error(`Unsupported date relationship operator '${predicate.operator}'.`);
    return `((${validPair("datetime2")}) AND TRY_CONVERT(datetime2, ${column}) ${operator} TRY_CONVERT(datetime2, ${right}))`;
  }
  const leftText = text(column);
  const rightText = other ? text(other) : `${right} COLLATE Latin1_General_100_BIN2`;
  switch (predicate.operator) {
    case "equals": return `(${column} IS NOT NULL${other ? ` AND ${other} IS NOT NULL` : ""} AND ${leftText} = ${rightText})`;
    case "notEquals": return `(${column} IS NOT NULL${other ? ` AND ${other} IS NOT NULL` : ""} AND ${leftText} <> ${rightText})`;
    case "in": return `(${column} IS NOT NULL AND ${leftText} IN (${(predicate.values ?? []).map(value => `${literal(value)} COLLATE Latin1_General_100_BIN2`).join(", ")}))`;
    case "notIn": return `(${column} IS NOT NULL AND ${leftText} NOT IN (${(predicate.values ?? []).map(value => `${literal(value)} COLLATE Latin1_General_100_BIN2`).join(", ")}))`;
    case "isNull": return `(${column} IS NULL)`;
    case "notNull": return `(${column} IS NOT NULL)`;
    case "isBlank": return `(${column} IS NULL OR LTRIM(RTRIM(${leftText})) = N'')`;
    case "notBlank": return `(${column} IS NOT NULL AND LTRIM(RTRIM(${leftText})) <> N'')`;
    case "equalsColumn": return `(${column} IS NOT NULL AND ${other} IS NOT NULL AND ${leftText} = ${rightText})`;
    case "notEqualsColumn": return `(${column} IS NOT NULL AND ${other} IS NOT NULL AND ${leftText} <> ${rightText})`;
    default: throw new Error(`Unsupported relationship operator '${predicate.operator}'.`);
  }
}

export function evaluateCsvCrossCheck(plan: CsvCrossPlan, fromCsv: ParsedCsv, toCsv: ParsedCsv): ValidationResult {
  if (fromCsv.parseErrors.length || toCsv.parseErrors.length) throw new Error(`Cross-check ${plan.check.id}: CSV parsing failed.`);
  const objects = (csv: ParsedCsv) => csv.rows.map(row => Object.fromEntries(csv.headers.map((header, index) => [header, row[index] ?? ""])));
  const fromRows = objects(fromCsv), toRows = objects(toCsv), check = plan.check;
  const rowNumber = new WeakMap<Record<string, string>, number>();
  fromRows.forEach((row, index) => rowNumber.set(row, fromCsv.sourceRowNumbers[index]));
  toRows.forEach((row, index) => rowNumber.set(row, toCsv.sourceRowNumbers[index]));
  const evidenceSamples: FailureEvidence["samples"] = [];
  const retain = (primary: Record<string, string>, related: Record<string, string>[] = []) => {
    if (evidenceSamples.length >= 100) return;
    evidenceSamples.push({
      primary: { label: check.from, row: rowNumber.get(primary), values: primary },
      related: related.map(row => ({ label: check.to, row: rowNumber.get(row), values: row }))
    });
  };
  const nullValue = (side: "from" | "to", candidate: string) => ((side === "from" ? plan.from.contract : plan.to.contract).csv?.nullValues ?? [""]).includes(candidate);
  const value = (leaf: CrossPredicateLeaf, from: Record<string, string>, to: Record<string, string>) => (leaf.side === "from" ? from : to)[leaf.column] ?? "";
  const evaluate = (predicate: CrossPredicate | undefined, from: Record<string, string>, to: Record<string, string>): boolean => {
    if (!predicate) return true;
    if ("all" in predicate) return predicate.all.every(item => evaluate(item, from, to));
    if ("any" in predicate) return predicate.any.some(item => evaluate(item, from, to));
    const actual = value(predicate, from, to);
    const expected = predicate.other ? (predicate.other.side === "from" ? from : to)[predicate.other.column] ?? "" : String(predicate.value ?? "");
    const numeric = (compare: (a: number, b: number) => boolean) => actual.trim() !== "" && expected.trim() !== "" && Number.isFinite(Number(actual)) && Number.isFinite(Number(expected)) && compare(Number(actual), Number(expected));
    if (predicate.valueType === "number") {
      switch (predicate.operator) {
        case "equals": return numeric((a, b) => a === b); case "notEquals": return numeric((a, b) => a !== b);
        case "greaterThan": return numeric((a, b) => a > b); case "greaterThanOrEqual": return numeric((a, b) => a >= b);
        case "lessThan": return numeric((a, b) => a < b); case "lessThanOrEqual": return numeric((a, b) => a <= b);
        default: throw new Error(`Unsupported numeric CSV relationship operator '${predicate.operator}'.`);
      }
    }
    switch (predicate.operator) {
      case "equals": return actual === expected; case "notEquals": return actual !== expected;
      case "in": return (predicate.values ?? []).includes(actual); case "notIn": return !(predicate.values ?? []).includes(actual);
      case "isNull": return nullValue(predicate.side, actual); case "notNull": return !nullValue(predicate.side, actual);
      case "isBlank": return actual.trim() === ""; case "notBlank": return actual.trim() !== "";
      case "equalsColumn": return actual === expected; case "notEqualsColumn": return actual !== expected;
      case "greaterThan": return numeric((a, b) => a > b); case "greaterThanOrEqual": return numeric((a, b) => a >= b);
      case "lessThan": return numeric((a, b) => a < b); case "lessThanOrEqual": return numeric((a, b) => a <= b);
      case "dateOnOrAfter": return Date.parse(actual) >= Date.parse(expected); case "dateOnOrBefore": return Date.parse(actual) <= Date.parse(expected);
      case "dateAfter": return Date.parse(actual) > Date.parse(expected); case "dateBefore": return Date.parse(actual) < Date.parse(expected);
      default: throw new Error(`Unsupported CSV relationship operator '${predicate.operator}'.`);
    }
  };
  const key = (row: Record<string, string>, mappings: { from: string; to: string }[], side: "from" | "to") => mappings.map(mapping => row[side === "from" ? mapping.from : mapping.to] ?? "").join("\u0000");
  if (check.kind === "equalPopulation") {
    const failures = Math.abs(fromRows.length - toRows.length);
    return crossResult(check, failures, failures ? { samples: [], aggregate: { fromRows: fromRows.length, toRows: toRows.length } } : undefined);
  }
  if (!check.keys?.length) throw new Error(`Cross-check ${check.id}: keys are required for CSV execution.`);
  const index = new Map<string, Record<string, string>[]>();
  for (const row of toRows) { const id = key(row, check.keys, "to"); const rows = index.get(id) ?? []; rows.push(row); index.set(id, rows); }
  let failures = 0;
  const hasKeys = (row: Record<string, string>) => check.keys!.every(mapping => !nullValue("from", row[mapping.from] ?? ""));
  if (check.kind === "foreignKey") failures = fromRows.filter(row => {
    const failed = !hasKeys(row) ? check.nulls === "fail" : !index.has(key(row, check.keys!, "from"));
    if (failed) retain(row);
    return failed;
  }).length;
  else if (check.kind === "rowReconciliation") failures = fromRows.filter(row => {
    if (!hasKeys(row)) { if (check.nulls === "fail") retain(row); return check.nulls === "fail"; }
    const matches = index.get(key(row, check.keys!, "from")) ?? [];
    const failed = !matches.length || matches.some(match => check.valueMappings!.some(mapping => {
      const source = row[mapping.from] ?? "", target = match[mapping.to] ?? "", blank = source.trim() === "" || nullValue("from", source);
      return blank && mapping.blankTo !== undefined && target !== mapping.blankTo || !blank && mapping.otherwise === "preserve" && target !== source;
    }));
    if (failed) retain(row, matches);
    return failed;
  }).length;
  else if (check.kind === "equalTotal") {
    const columns = check.valueColumns!;
    const aggregate = (rows: Record<string, string>[], column: string, side: "from" | "to") => rows.reduce((state, row) => {
      const raw = row[column] ?? "";
      if (nullValue(side, raw)) { if (check.nulls === "fail") state.invalid = true; return state; }
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) state.invalid = true; else state.total += parsed;
      return state;
    }, { total: 0, invalid: false });
    const left = aggregate(fromRows, columns.from, "from"), right = aggregate(toRows, columns.to, "to");
    failures = !left.invalid && !right.invalid && Math.abs(left.total - right.total) <= Number(check.tolerance ?? "0") ? 0 : 1;
    if (failures) return crossResult(check, failures, { samples: [], aggregate: { fromTotal: left.total, toTotal: right.total, fromInvalid: left.invalid, toInvalid: right.invalid } });
  } else failures = fromRows.filter(row => {
    if (!hasKeys(row)) { if (check.nulls === "fail") retain(row); return check.nulls === "fail"; }
    const matches = [...(index.get(key(row, check.keys!, "from")) ?? [])];
    if (check.lookup?.orderBy.length && matches.length > 1) matches.sort((a, b) => compareLookupRows(a, b, check.lookup!.orderBy));
    const selected = check.lookup ? matches.slice(0, 1) : matches;
    if (!selected.length) { if (check.missing !== "ignore") retain(row); return check.missing !== "ignore"; }
    const failed = selected.some(match => evaluate(check.when, row, match) && !evaluate(check.expect, row, match));
    if (failed) retain(row, selected);
    return failed;
  }).length;
  return crossResult(check, failures, failures ? { samples: evidenceSamples, totalSamples: failures, limited: evidenceSamples.length < failures } : undefined);
}
function compareLookupRows(left: Record<string, string>, right: Record<string, string>, order: NonNullable<CrossCheck["lookup"]>["orderBy"]): number {
  for (const item of order) {
    const parse = (value: string): string | number | null => {
      if (item.type === "string") return value;
      const parsed = item.type === "date" ? Date.parse(value) : value.trim() === "" ? Number.NaN : Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const a = parse(left[item.column] ?? ""), b = parse(right[item.column] ?? "");
    const compared = a === null && b === null ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : a > b ? 1 : 0;
    if (compared) return (item.direction ?? "asc") === "desc" ? -compared : compared;
  }
  return 0;
}
export function crossResult(check: CrossCheck, count: unknown, evidence?: FailureEvidence): ValidationResult {
  const failures = Number(count);
  if (count === null || count === undefined || String(count).trim() === "" || !Number.isSafeInteger(failures) || failures < 0) throw new Error(`Invalid cross-check summary for ${check.id}.`);
  const warning = check.severity === "warning";
  return { valid: !failures || warning, rowCount: 0, columnCount: 0, testCount: 1, issueCount: failures, errorCount: warning ? 0 : failures, warningCount: warning ? failures : 0,
    truncated: false, issues: failures ? [{ level: "row", code: "CROSS_CHECK_FAILED", testId: check.id, severity: check.severity ?? "error", actual: failures, expected: 0, evidence, message: `${check.kind}: ${failures} ${check.kind === "foreignKey" ? "orphan rows" : check.kind === "equalTotal" ? "total mismatch or invalid numeric/null inputs" : check.kind === "rowReconciliation" ? "missing or value-mismatched source rows" : check.kind === "relationship" ? "relationship violations" : "rows of population difference"} (${check.from} → ${check.to}).${evidence ? " Bounded source evidence is attached." : " No row-level evidence was available."}` }] : [] };
}

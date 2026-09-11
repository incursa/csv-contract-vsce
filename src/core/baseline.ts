import { parse, stringify } from "yaml";
import Ajv from "ajv/dist/2020";
import contractSchema from "../../schemas/csvtest.schema.json";
import type { CsvContract, CsvOptions, ValidationIssue } from "./model";

export type DriftSeverity = "allowed" | "warning" | "error";
export interface BaselineColumn {
  name: string;
  ordinal: number;
  required?: boolean;
  sqlType?: string | null;
  maxLength?: number | null;
  precision?: number | null;
  scale?: number | null;
  nullable?: boolean | null;
  identity?: boolean | null;
  computed?: boolean | null;
  primaryKeyOrdinal?: number | null;
  observedType?: "string" | "number" | "unknown";
  observedNullable?: boolean;
}
export interface SchemaBaseline {
  baselineVersion: 1;
  revision: number;
  capturedAt: string;
  sourceKind: "csv" | "sql" | "manual";
  captureMethod: "csv-header" | "sql-metadata" | "manual";
  object?: { schema: string; name: string };
  interpretation?: CsvOptions;
  inference?: { scope: "complete" | "sample"; rows: number };
  columns: BaselineColumn[];
  policy?: { default?: DriftSeverity; changes?: Record<string, DriftSeverity>; columns?: Record<string, DriftSeverity>; order?: "exact" | "ignore" };
}
export type BaselineBinding = SchemaBaseline | { ref: string };
export interface SchemaChange {
  id: string;
  kind: string;
  column: string;
  physicalColumn: string;
  before?: unknown;
  after?: unknown;
  severity: DriftSeverity;
  affectedRules: string[];
  renameCandidate?: string;
}
const properties = ["sqlType", "maxLength", "precision", "scale", "nullable", "identity", "computed", "primaryKeyOrdinal", "observedType", "observedNullable"] as const;
const shape = new Ajv({ strict: false, allErrors: true, validateFormats: false }).addSchema(contractSchema).compile({ $ref: `${contractSchema.$id}#/properties/baseline` });

export function parseBaseline(text: string): SchemaBaseline {
  const b = parse(text) as SchemaBaseline;
  if (!shape(b)) throw new Error(`Invalid baseline metadata: ${JSON.stringify(shape.errors)}`);
  if (!b || b.baselineVersion !== 1 || !Number.isSafeInteger(b.revision) || b.revision < 1 ||
    !["csv", "sql", "manual"].includes(b.sourceKind) || !["csv-header", "sql-metadata", "manual"].includes(b.captureMethod) ||
    !Number.isFinite(Date.parse(b.capturedAt)) || !Array.isArray(b.columns) ||
    b.columns.some(c => !c || typeof c.name !== "string" || !Number.isSafeInteger(c.ordinal) || c.ordinal < 1)) {
    throw new Error("Invalid schema baseline: expected baselineVersion: 1, positive revision, capture provenance and ordered columns.");
  }
  const allowed = ["baselineVersion", "revision", "capturedAt", "sourceKind", "captureMethod", "object", "interpretation", "inference", "columns", "policy"];
  if (Object.keys(b).some(k => !allowed.includes(k))) throw new Error("Unsupported baseline fields; baselines contain schema metadata only.");
  for (const c of b.columns) {
    if (Object.keys(c).some(k => !["name", "ordinal", "required", ...properties].includes(k))) throw new Error(`Unsupported metadata for baseline column ${c.name}.`);
    for (const key of ["maxLength", "precision", "scale", "primaryKeyOrdinal"] as const) if (c[key] != null && !Number.isSafeInteger(c[key])) throw new Error(`Invalid ${key} metadata.`);
  }
  const severities = [b.policy?.default, ...Object.values(b.policy?.changes ?? {}), ...Object.values(b.policy?.columns ?? {})].filter(v => v !== undefined);
  if (severities.some(v => !["allowed", "warning", "error"].includes(v!))) throw new Error("Invalid drift severity.");
  return b;
}

export function baselineFor(contract: CsvContract): SchemaBaseline | undefined {
  if (!contract.baseline) return undefined;
  if ("ref" in contract.baseline) throw new Error(`Baseline dependency '${contract.baseline.ref}' must be loaded before validation.`);
  return parseBaseline(stringify(contract.baseline));
}

export async function resolveBaseline(contract: CsvContract, source: string, io: { read(p: string): Promise<string>; resolve(p: string, ref: string): string }): Promise<CsvContract> {
  if (!contract.baseline || !("ref" in contract.baseline)) return contract;
  const baseline = parseBaseline(await io.read(io.resolve(source, contract.baseline.ref)));
  return { ...contract, baseline };
}

/** Retains no source rows. Leading-zero identifiers remain strings. */
export class CsvSchemaObservation {
  readonly columns: BaselineColumn[];
  private rows = 0;
  constructor(headers: string[], private readonly options: CsvOptions = {}) {
    this.columns = headers.map((name, index) => ({ name, ordinal: index + 1, observedType: "unknown", observedNullable: false }));
  }
  add(row: string[]): void {
    this.rows++;
    this.columns.forEach((c, index) => {
      const raw = row[index] ?? "";
      const value = this.options.trimValues ? raw.trim() : raw;
      const normalize = (v: string) => { const trimmed = this.options.trimValues ? v.trim() : v; return this.options.caseSensitive === false ? trimmed.toLowerCase() : trimmed; };
      if ((this.options.nullValues ?? [""]).some(marker => normalize(marker) === normalize(value))) { c.observedNullable = true; return; }
      const kind = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value)) ? "number" : "string";
      if (c.observedType === "unknown") c.observedType = kind;
      else if (c.observedType !== kind) c.observedType = "string";
    });
  }
  snapshot(scope: "complete" | "sample" = "complete"): SchemaBaseline {
    return { baselineVersion: 1, revision: 1, capturedAt: new Date().toISOString(), sourceKind: "csv", captureMethod: "csv-header",
      interpretation: structuredClone(this.options), inference: { scope, rows: this.rows }, columns: structuredClone(this.columns) };
  }
}

export function compareBaseline(expected: SchemaBaseline, actual: SchemaBaseline, contract?: CsvContract, columnMap: Record<string, string> = {}): SchemaChange[] {
  if (expected.sourceKind !== "manual" && expected.sourceKind !== actual.sourceKind) throw new Error(`Cannot compare ${expected.sourceKind} baseline with ${actual.sourceKind} source.`);
  const changes: SchemaChange[] = [];
  const rules = [...(contract?.rules ?? []), ...(contract?.rowTests ?? []), ...(contract?.groupRules ?? []), ...(contract?.sqlServer?.conditionalRules ?? [])];
  const canonical = (name: string) => Object.entries(columnMap).find(([, physical]) => physical === name)?.[0] ?? name;
  const observed = actual.columns.map(c => ({ ...c, name: canonical(c.name) }));
  const expectedColumns = expected.columns.map(c => ({ ...c, name: canonical(c.name) }));
  const add = (kind: string, column: string, before?: unknown, after?: unknown): void => {
    changes.push({ id: JSON.stringify([kind, column]), kind, column, physicalColumn: columnMap[column] ?? column, before, after,
      severity: expected.policy?.columns?.[column] ?? expected.policy?.changes?.[kind] ?? expected.policy?.default ?? (kind.startsWith("observed") ? "warning" : "error"),
      affectedRules: rules.filter(r => JSON.stringify(r).includes(JSON.stringify(column))).map(r => r.id) });
  };
  for (const c of expectedColumns) {
    const a = observed.find(v => v.name === c.name);
    if (!a) { if (c.required !== false) add("removed", c.name, c); continue; }
    if (expected.policy?.order !== "ignore" && c.ordinal !== a.ordinal) add("ordinal", c.name, c.ordinal, a.ordinal);
    for (const key of properties) {
      if (c[key] === undefined || c[key] === null) continue;
      if (a[key] === undefined || a[key] === null) add(`unknown:${key}`, c.name, c[key], null);
      else if (c[key] !== a[key]) add(key, c.name, c[key], a[key]);
    }
  }
  for (const c of observed) if (!expectedColumns.some(e => e.name === c.name)) add("added", c.name, undefined, c);
  for (const name of new Set(observed.map(c => c.name))) {
    const before = expectedColumns.filter(c => c.name === name).length;
    const after = observed.filter(c => c.name === name).length;
    if (after > 1 && before !== after) add("duplicated", name, before, after);
  }
  const removed = changes.filter(c => c.kind === "removed");
  for (const addition of changes.filter(c => c.kind === "added")) {
    const candidate = removed.find(c => (c.before as BaselineColumn).ordinal === (addition.after as BaselineColumn).ordinal);
    if (candidate) addition.renameCandidate = candidate.column;
  }
  if (expected.interpretation && JSON.stringify(expected.interpretation) !== JSON.stringify(actual.interpretation)) add("interpretation", "", expected.interpretation, actual.interpretation);
  return changes;
}

export function acceptBaselineChanges(expected: SchemaBaseline, actual: SchemaBaseline, selected: string[], columnMap: Record<string, string> = {}): SchemaBaseline {
  const changes = compareBaseline(expected, actual, undefined, columnMap);
  const canonical = (name: string) => Object.entries(columnMap).find(([, physical]) => physical === name)?.[0] ?? name;
  if (selected.some(id => !changes.some(c => c.id === id))) throw new Error("Drift review is stale or contains unknown selections.");
  const next = structuredClone(expected);
  for (const c of changes.filter(c => selected.includes(c.id))) {
    if (c.kind.startsWith("unknown:")) throw new Error("Unavailable metadata cannot be accepted as an expectation.");
    if (c.kind === "removed") next.columns = next.columns.filter(v => canonical(v.name) !== c.column);
    else if (c.kind === "added") next.columns.push(structuredClone(c.after as BaselineColumn));
    else if (c.kind === "duplicated") {
      next.columns = next.columns.filter(v => canonical(v.name) !== c.column).concat(actual.columns.filter(v => canonical(v.name) === c.column).map(v => structuredClone(v)));
    } else if (c.kind === "interpretation") next.interpretation = structuredClone(actual.interpretation);
    else {
      const column = next.columns.find(v => canonical(v.name) === c.column);
      if (column) Object.assign(column, { [c.kind]: c.after });
    }
  }
  next.columns.sort((a, b) => a.ordinal - b.ordinal);
  next.revision++;
  next.capturedAt = new Date().toISOString();
  return next;
}

export function baselineIssues(contract: CsvContract, actual: SchemaBaseline, columnMap?: Record<string, string>): ValidationIssue[] {
  const baseline = baselineFor(contract);
  return baseline ? compareBaseline(baseline, actual, contract, columnMap).filter(c => c.severity !== "allowed").map(c => ({
    level: "column", code: "SCHEMA_DRIFT", column: c.column, testId: `baseline:${c.id}`, severity: c.severity === "warning" ? "warning" : "error",
    message: `${c.physicalColumn}: ${c.kind}; before ${JSON.stringify(c.before) ?? "absent"}; after ${JSON.stringify(c.after) ?? "absent"}.`,
    actual: JSON.stringify(c.after), expected: JSON.stringify(c.before)
  })) : [];
}

import type { ConditionalRule, CsvContract, Predicate, PredicateOperator } from "./model";
import { isoDate } from "./predicate";

export const presetCatalog = [
  ["neverNull", "Never null"], ["constant", "Always a constant"], ["allowed", "Allowed values"], ["prohibited", "Prohibited values"],
  ["numberRange", "Number range"], ["dateRange", "ISO date range"], ["pattern", "Text pattern"],
  ["requiredWhen", "Required when"], ["compareColumns", "Compare columns"], ["unique", "Unique column"], ["population", "Population / row count"]
] as const;
export type PresetKind = typeof presetCatalog[number][0];
export interface PresetInput {
  kind: PresetKind; id: string; column: string; value?: string; values?: string[];
  minimum?: string; maximum?: string; exclusive?: boolean; otherColumn?: string;
  comparison?: "equalsColumn" | "notEqualsColumn" | "greaterThan" | "greaterThanOrEqual" | "lessThan" | "lessThanOrEqual";
  nulls?: "fail" | "allow" | "ignore";
}
export function insertPreset(contract: CsvContract, input: PresetInput): CsvContract {
  const next = structuredClone(contract);
  if (!next.schema.columns[input.column]) throw new Error("Choose a declared column.");
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(input.id)) throw new Error("Use a stable rule ID with lowercase letters, numbers, dots, underscores or hyphens.");
  const ids = [...(next.rules ?? []), ...(next.rowTests ?? []), ...(next.groupRules ?? []), ...(next.sqlServer?.conditionalRules ?? [])].map(r => r.id);
  if (ids.includes(input.id)) throw new Error(`Rule ID '${input.id}' already exists.`);
  if (input.kind === "unique") {
    (next.schema.columns[input.column].constraints ??= {}).unique = true;
    return next;
  }
  if (input.kind === "population") {
    const count = Number(input.minimum);
    if (!input.minimum || !Number.isSafeInteger(count) || count < 0) throw new Error("Minimum population must be a non-negative integer.");
    next.schema.rowCount = { ...next.schema.rowCount, min: count };
    return next;
  }
  const leaf = (operator: PredicateOperator, value?: string): Predicate => ({ column: input.column, operator, ...(value !== undefined ? { value } : {}) });
  let expect: Predicate;
  let when: Predicate | undefined;
  switch (input.kind) {
    case "neverNull": expect = leaf("notNull"); break;
    case "constant": expect = leaf("equals", input.value ?? ""); break;
    case "allowed": case "prohibited":
      if (!input.values?.length) throw new Error("Enter at least one literal value.");
      expect = { column: input.column, operator: input.kind === "allowed" ? "in" : "notIn", values: [...input.values] }; break;
    case "pattern":
      new RegExp(input.value ?? "");
      expect = leaf("matches", input.value ?? ""); break;
    case "compareColumns":
      if (!input.otherColumn || !next.schema.columns[input.otherColumn]) throw new Error("Choose another declared column.");
      expect = { column: input.column, operator: input.comparison ?? "equalsColumn", otherColumn: input.otherColumn }; break;
    case "requiredWhen":
      if (!input.otherColumn || !next.schema.columns[input.otherColumn]) throw new Error("Choose the condition column.");
      when = { column: input.otherColumn, operator: "equals", value: input.value ?? "" };
      expect = leaf("notNull"); break;
    case "numberRange": case "dateRange": {
      const bounds: Predicate[] = [];
      const date = input.kind === "dateRange";
      const parse = date ? isoDate : Number;
      if (input.minimum && !Number.isFinite(parse(input.minimum)) || input.maximum && !Number.isFinite(parse(input.maximum))) throw new Error(date ? "Use a valid ISO date or instant with explicit timezone." : "Use finite numeric bounds.");
      if (input.minimum && input.maximum && parse(input.minimum) > parse(input.maximum)) throw new Error("Minimum exceeds maximum.");
      if (input.minimum) bounds.push(leaf(date ? input.exclusive ? "dateAfter" : "dateOnOrAfter" : input.exclusive ? "greaterThan" : "greaterThanOrEqual", input.minimum));
      if (input.maximum) bounds.push(leaf(date ? input.exclusive ? "dateBefore" : "dateOnOrBefore" : input.exclusive ? "lessThan" : "lessThanOrEqual", input.maximum));
      if (!bounds.length) throw new Error("Enter at least one bound.");
      expect = { all: bounds }; break;
    }
  }
  if (input.kind !== "neverNull" && input.kind !== "requiredWhen") {
    if (input.nulls === "allow") expect = { any: [leaf("isNull"), expect] };
    else if (input.nulls === "ignore") when = leaf("notNull");
    else expect = { all: [leaf("notNull"), expect] };
  }
  const rule: ConditionalRule = { id: input.id, expect, ...(when ? { when } : {}) };
  (next.rules ??= []).push(rule);
  return next;
}

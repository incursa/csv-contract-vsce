import { predicateColumns } from "./predicate";
import { resolveSqlServerTargets } from "./sql-server-targets";
import { generateSqlServerValidation } from "./sql-server-generator";
import type { CsvContract } from "./model";
export function coverageDiagnostics(contract: CsvContract): string[] {
  const diagnostics: string[] = [];
  const rules = [...(contract.rules ?? []), ...(contract.sqlServer?.conditionalRules ?? [])];
  if (!rules.length && !contract.rowTests?.length && !contract.groupRules?.length && !contract.identity && !contract.schema.rowCount && !Object.values(contract.schema.columns).some(c => c.constraints && Object.values(c.constraints).some(Boolean))) diagnostics.push("No substantive data validations; only schema presence is checked.");
  if (!contract.targets?.length && !contract.sqlServer?.table && !contract.sqlServer?.targets?.length) diagnostics.push("No execution targets configured.");
  const seen = new Map<string, string>();
  for (const rule of rules) {
    const missing = [...predicateColumns(rule.when), ...predicateColumns(rule.expect)].filter(c => !contract.schema.columns[c]);
    if (missing.length) diagnostics.push(`${rule.id}: undeclared columns ${[...new Set(missing)].join(", ")}.`);
    const signature = JSON.stringify([rule.when, rule.expect, rule.severity ?? "error"]);
    if (seen.has(signature)) diagnostics.push(`${rule.id}: duplicates ${seen.get(signature)}.`);
    seen.set(signature, rule.id);
    if (!rule.when && "operator" in rule.expect && rule.expect.operator === "equals") {
      const expected = rule.expect;
      for (const other of rules) if (other !== rule && !other.when && "operator" in other.expect && other.expect.operator === "equals" && other.expect.column === expected.column && other.expect.value !== expected.value) diagnostics.push(`${rule.id} and ${other.id}: conflicting unconditional literal expectations on ${expected.column}.`);
    }
  }
  try {
    for (const target of resolveSqlServerTargets(contract, false)) {
      if (!target.scope) diagnostics.push(`${target.schema}.${target.table}: full object scope; no load/batch restriction.`);
      diagnostics.push(...generateSqlServerValidation(contract, { target, includeDetailQueries: false }).warnings);
    }
  } catch (e) { diagnostics.push(`Execution capability: ${String(e)}`); }
  return [...new Set(diagnostics)];
}

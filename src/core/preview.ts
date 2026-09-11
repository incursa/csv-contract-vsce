import type { CsvContract } from "./model";

/** Isolates an ordinary rule; all parsing, normalization and execution remain in the normal engines. */
export function previewContract(original: CsvContract, id: string): CsvContract {
  const contract = structuredClone(original);
  const rule = contract.rules?.find(r => r.id === id) ?? contract.sqlServer?.conditionalRules?.find(r => r.id === id);
  const row = contract.rowTests?.find(r => r.id === id);
  const group = contract.groupRules?.find(r => r.id === id);
  if (!rule && !row && !group) throw new Error("Preview rule no longer exists.");
  return { ...contract, baseline: undefined, identity: undefined, rowTests: row ? [row] : undefined, groupRules: group ? [group] : undefined, rules: rule ? [rule] : undefined,
    schema: { columns: Object.fromEntries(Object.entries(contract.schema.columns).map(([name, c]) => [name, { presence: c.presence }])) },
    sqlServer: contract.sqlServer ? { ...contract.sqlServer, conditionalRules: undefined } : undefined };
}

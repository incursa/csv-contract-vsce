import type { CsvContract } from "./model";
export interface PreviewOptions { rowLimit?: number; exampleLimit: number }
export function validatePreviewOptions(options: PreviewOptions): void {
  if (!Number.isSafeInteger(options.exampleLimit) || options.exampleLimit < 0 || options.exampleLimit > 100) throw new Error("Preview example limit must be 0–100 per outcome and rule.");
  if (options.rowLimit !== undefined && (!Number.isSafeInteger(options.rowLimit) || options.rowLimit < 1 || options.rowLimit > 100000)) throw new Error("Preview row limit must be 1–100000.");
}

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

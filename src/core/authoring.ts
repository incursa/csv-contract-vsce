import { parse } from "yaml";
import { parseContract } from "./contract";
export { coverageDiagnostics } from "./coverage";


import type { ConditionalRule, CsvContract } from "./model";

export interface RuleTemplate { templateVersion: 1; name: string; parameters?: string[]; rules: ConditionalRule[] }
export function parseTemplate(text: string): RuleTemplate {
  const template = parse(text) as RuleTemplate;
  if (!template || template.templateVersion !== 1 || typeof template.name !== "string" || !Array.isArray(template.rules) || Object.keys(template).some(k => !["templateVersion", "name", "parameters", "rules"].includes(k))) throw new Error("Invalid rule template; expected templateVersion: 1, name, parameters and ordinary rules.");
  if (template.parameters && (!Array.isArray(template.parameters) || template.parameters.some(p => typeof p !== "string" || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(p)))) throw new Error("Invalid template parameter names.");
  return template;
}
export function insertTemplate(contract: CsvContract, template: RuleTemplate, parameters: Record<string, string>): CsvContract {
  for (const p of template.parameters ?? []) if (parameters[p] === undefined) throw new Error(`Missing template parameter '${p}'.`);
  const expand = (value: unknown): unknown => {
    if (typeof value === "string") return value.replace(/\$\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (_, key: string) => {
      if (parameters[key] === undefined) throw new Error(`Unknown template parameter '${key}'.`);
      return parameters[key];
    });
    if (Array.isArray(value)) return value.map(expand);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v)]));
    return value;
  };
  const rules = expand(template.rules) as ConditionalRule[];
  const ids = new Set([...(contract.rules ?? []), ...(contract.rowTests ?? []), ...(contract.groupRules ?? []), ...(contract.sqlServer?.conditionalRules ?? [])].map(r => r.id));
  for (const r of rules) { if (ids.has(r.id)) throw new Error(`Duplicate rule ID '${r.id}'; choose a distinct template ID parameter.`); ids.add(r.id); }
  return parseContract(JSON.stringify({ ...contract, rules: [...(contract.rules ?? []), ...rules] }));
}

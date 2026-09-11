import type { ValidationResult } from "./model";

export interface RuleSummary { id: string; selected?: number; passed?: number; failed?: number; retainedIssues: number }
/** Retains counts and stable IDs only. Missing outcomes never imply success. */
export function summarizeRules(result?: ValidationResult): RuleSummary[] {
  if (!result) return [];
  const ids = new Set([...(result.ruleOutcomes ?? []).map(r => r.id), ...result.issues.flatMap(i => i.testId ? [i.testId] : [])]);
  return [...ids].map(id => {
    const outcome = result.ruleOutcomes?.find(r => r.id === id);
    return { id, selected: outcome?.selected, passed: outcome?.passed, failed: outcome?.failed,
      retainedIssues: result.issues.filter(i => i.testId === id).length };
  });
}
export function compareRules(before: RuleSummary[] = [], after: RuleSummary[] = []) {
  return [...new Set([...before, ...after].map(r => r.id))].map(id => ({ id,
    before: before.find(r => r.id === id), after: after.find(r => r.id === id),
    availability: !before.some(r => r.id === id) ? "only-current" : !after.some(r => r.id === id) ? "only-saved" : "both" }));
}

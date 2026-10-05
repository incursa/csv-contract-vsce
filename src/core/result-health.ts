import type { ValidationResult } from "./model";

export type ResultColorMode = "binary" | "graded";
export type ResultHealthBand = "perfect" | "attention" | "concerning" | "critical";

export interface ResultHealth {
  score: number;
  band: ResultHealthBand;
  label: string;
}

export function resultHealthCategory(health: ResultHealth): string {
  return health.band === "perfect" ? "Clean" : health.band === "attention" ? "Limited impact" :
    health.band === "concerning" ? "Moderate impact" : "High impact";
}

export function resultHealthTitle(health: ResultHealth): string {
  return `${resultHealthCategory(health)} · Health score ${health.score}/100. Based on the share of checks and records affected; warnings have less weight.`;
}

/**
 * Produces a presentation score without changing validation semantics.
 * A clean result is the only way to receive 100. Findings retain a graded
 * score so importance remains visible while validation semantics stay binary.
 */
export function resultHealth(result?: ValidationResult, status?: string, mode: ResultColorMode = "binary"): ResultHealth {
  const executionFailed = status === "ERROR" || status === "CANCELED" || !result;
  if (mode === "binary") {
    const passed = !executionFailed && result.valid;
    return { score: passed ? 100 : 0, band: passed ? "perfect" : "critical", label: passed ? "PASS" : status ?? "FAIL" };
  }
  if (executionFailed) return { score: 0, band: "critical", label: status ?? "ERROR" };
  const hasOutcomeFailure = (result.ruleOutcomes ?? []).some(outcome => outcome.failed > 0) ||
    (result.groupOutcomes ?? []).some(outcome => outcome.failed > 0);
  if (result.errorCount === 0 && result.warningCount === 0 && result.issueCount === 0 && !hasOutcomeFailure) {
    return { score: 100, band: "perfect", label: "PASS" };
  }

  const errorChecks = new Set<string>();
  const warningChecks = new Set<string>();
  for (const issue of result.issues) {
    const id = issue.testId ?? issue.code;
    if (issue.severity === "warning") warningChecks.add(id);
    else errorChecks.add(id);
  }
  for (const outcome of result.ruleOutcomes ?? []) if (outcome.failed > 0 && !warningChecks.has(outcome.id)) errorChecks.add(outcome.id);
  for (const outcome of result.groupOutcomes ?? []) if (outcome.failed > 0 && !warningChecks.has(outcome.id)) errorChecks.add(outcome.id);
  for (const id of errorChecks) warningChecks.delete(id);

  const importanceFor = (id: string): number => {
    const weights = result.issues.filter(issue => (issue.testId ?? issue.code) === id).map(issue => issue.importance ?? 1);
    const outcome = [...(result.ruleOutcomes ?? []), ...(result.groupOutcomes ?? [])].find(item => item.id === id);
    return weights.length ? Math.max(...weights) : outcome?.importance ?? 1;
  };
  const weightedChecks = [...errorChecks].reduce((total, id) => total + importanceFor(id), 0) +
    [...warningChecks].reduce((total, id) => total + importanceFor(id) * 0.25, 0);
  const checkRate = Math.min(1, weightedChecks / Math.max(1, result.testCount, errorChecks.size + warningChecks.size));
  const weightedEvents = result.issues.reduce((total, issue) => total + (issue.importance ?? 1) * (issue.severity === "warning" ? 0.25 : 1), 0);
  const eventRate = Math.min(1, weightedEvents / Math.max(1, result.rowCount, result.issueCount));
  const impact = 0.65 * Math.sqrt(checkRate) + 0.35 * Math.sqrt(eventRate);
  const score = Math.max(0, Math.round(100 * (1 - impact)));
  const band: ResultHealthBand = score >= 75 ? "attention" : score >= 45 ? "concerning" : "critical";
  return { score, band, label: result.valid ? "PASS WITH WARNINGS" : "FAIL" };
}

export function aggregateResultHealth(
  entries: Array<{ result?: ValidationResult; status?: string }>,
  mode: ResultColorMode = "binary"
): ResultHealth {
  if (!entries.length) return { score: 0, band: "critical", label: "NO RESULTS" };
  const health = entries.map(entry => resultHealth(entry.result, entry.status, mode));
  if (mode === "binary") return health.every(item => item.band === "perfect")
    ? { score: 100, band: "perfect", label: "PASS" }
    : { score: 0, band: "critical", label: health.some(item => item.label === "ERROR") ? "ERROR" : "FAIL" };
  const perfect = health.every(item => item.band === "perfect");
  const score = perfect ? 100 : Math.round(health.reduce((total, item) => total + item.score, 0) / health.length);
  const band: ResultHealthBand = perfect ? "perfect" : score >= 75 ? "attention" : score >= 45 ? "concerning" : "critical";
  return { score, band, label: band === "perfect" ? "PASS" : entries.some(entry => entry.status === "ERROR") ? "ERROR" : "ISSUES" };
}

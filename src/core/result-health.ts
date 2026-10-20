import type { ValidationResult } from "./model";

export type ResultColorMode = "binary" | "graded";
export type ResultHealthBand = "perfect" | "attention" | "concerning" | "critical";
export const DEFAULT_IMPORTANCE = 1;

export const MIN_RESULT_IMPORTANCE = 0.1;
export const MAX_RESULT_IMPORTANCE = 10;

export interface ResultHealthOptions {
  /** Optional contract metadata keyed by stable evaluated check id. */
  importanceByCheckId?: Readonly<Record<string, number>>;
  /** Optional severity metadata when it is not carried by the evaluated outcome. */
  severityByCheckId?: Readonly<Record<string, "error" | "warning">>;
}

export interface ResultHealth {
  score: number;
  band: ResultHealthBand;
  label: string;
  /** False means the numeric placeholder must not be displayed as a health score. */
  available?: false;
  reason?: "sampled-evaluation" | "incomplete-evaluation" | "indeterminate-checks" | "no-evaluated-checks";
}

export function resultHealthCategory(health: ResultHealth): string {
  if (health.available === false) return "Health unavailable";
  return health.band === "perfect" ? "Clean" : health.band === "attention" ? "Limited impact" :
    health.band === "concerning" ? "Moderate impact" : "High impact";
}

export function resultHealthTitle(health: ResultHealth): string {
  if (health.available === false) return `Health heuristic unavailable (${health.reason?.replace(/-/g, " ") ?? "insufficient evaluation evidence"}).`;
  return `${resultHealthCategory(health)} · Health heuristic score ${health.score}/100. Based on the share of checks and records affected; warnings have less weight.`;
}

export function validateResultImportance(value: unknown, checkId = "check"): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < MIN_RESULT_IMPORTANCE || value > MAX_RESULT_IMPORTANCE) {
    throw new RangeError(`Importance for "${checkId}" must be a finite number from ${MIN_RESULT_IMPORTANCE} through ${MAX_RESULT_IMPORTANCE}.`);
  }
  return value;
}

type WeightedOutcome = NonNullable<ValidationResult["checkOutcomes"]>[number] & {
  importance?: number;
  severity?: "error" | "warning";
};

export interface WeightedCheckRate {
  rate: number;
  failedWeight: number;
  evaluatedWeight: number;
}

/**
 * Computes an importance-aware failure rate only from explicit evaluated outcomes.
 * Unknown and not-evaluated checks never enter the denominator as implicit passes.
 */
export function weightedCheckFailureRate(
  result: ValidationResult,
  options: ResultHealthOptions = {}
): WeightedCheckRate | undefined {
  let outcomes = (result.checkOutcomes ?? []) as WeightedOutcome[];
  const hasExplicitOutcomes = outcomes.length > 0;
  if (!hasExplicitOutcomes) outcomes = [
    ...(result.ruleOutcomes ?? []).map(outcome => ({ id: outcome.id, status: outcome.failed > 0 ? "fail" as const : "pass" as const, importance: outcome.importance })),
    ...(result.groupOutcomes ?? []).map(outcome => ({ id: outcome.id, status: outcome.failed > 0 ? "fail" as const : "pass" as const, importance: outcome.importance }))
  ];
  if (!outcomes.length && result.issues.some(issue => issue.importance !== undefined)) {
    const failed = new Map<string, number>();
    for (const issue of result.issues) failed.set(issue.testId ?? issue.code, Math.max(failed.get(issue.testId ?? issue.code) ?? 0, issue.importance ?? DEFAULT_IMPORTANCE));
    const failedWeight = [...failed.values()].reduce((total, importance) => total + importance, 0);
    return { rate: Math.min(1, failedWeight / Math.max(1, result.testCount, failed.size)), failedWeight, evaluatedWeight: Math.max(1, result.testCount, failed.size) };
  }
  if (!outcomes.length || outcomes.some(outcome => outcome.status === "unknown" || outcome.status === "not-evaluated")) return undefined;
  const warningIds = new Set(result.issues.filter(issue => issue.severity === "warning").map(issue => issue.testId).filter((id): id is string => Boolean(id)));
  let failedWeight = 0;
  let evaluatedWeight = 0;
  for (const outcome of outcomes) {
    if (outcome.status !== "pass" && outcome.status !== "fail") continue;
    const configured = options.importanceByCheckId?.[outcome.id];
    const importance = validateResultImportance(configured ?? outcome.importance ?? 1, outcome.id);
    evaluatedWeight += importance;
    if (outcome.status === "fail") {
      const severity = options.severityByCheckId?.[outcome.id] ?? outcome.severity ?? (warningIds.has(outcome.id) ? "warning" : "error");
      failedWeight += importance * (severity === "warning" ? 0.25 : 1);
    }
  }
  if (evaluatedWeight === 0) return undefined;
  // Legacy rule/group outcome inventories contain only the rules that produced
  // aggregate counters. Use the known test inventory as their denominator so a
  // lone failed rule with importance 0.25 has less impact than one weighted 1.
  // Explicit check outcomes remain normalized by their own summed importance.
  if (!hasExplicitOutcomes) evaluatedWeight = Math.max(1, result.testCount, outcomes.length);
  else if (outcomes.length === 1) evaluatedWeight = Math.max(1, evaluatedWeight);
  return { rate: Math.min(1, failedWeight / evaluatedWeight), failedWeight, evaluatedWeight };
}

function usesImportance(result: ValidationResult, options: ResultHealthOptions): boolean {
  return Object.keys(options.importanceByCheckId ?? {}).length > 0 ||
    (result.checkOutcomes ?? []).some(outcome => (outcome as WeightedOutcome).importance !== undefined) ||
    result.issues.some(issue => issue.importance !== undefined) ||
    [...(result.ruleOutcomes ?? []), ...(result.groupOutcomes ?? [])].some(outcome => outcome.importance !== undefined);
}

function unavailableHealth(result: ValidationResult, reason: NonNullable<ResultHealth["reason"]>): ResultHealth {
  return { score: 0, band: "critical", label: result.valid ? "PASS WITH WARNINGS" : "FAIL", available: false, reason };
}

/**
 * Produces a presentation score without changing validation semantics.
 * A clean result is the only way to receive 100. Findings retain a graded
 * score so importance remains visible while validation semantics stay binary.
 */
export function resultHealth(
  result?: ValidationResult,
  status?: string,
  mode: ResultColorMode = "binary",
  options: ResultHealthOptions = {}
): ResultHealth {
  const executionFailed = status === "ERROR" || status === "CANCELED" || !result;
  if (mode === "binary") {
    const passed = !executionFailed && result.valid;
    return { score: passed ? 100 : 0, band: passed ? "perfect" : "critical", label: passed ? "PASS" : status ?? "FAIL" };
  }
  if (executionFailed) return { score: 0, band: "critical", label: status ?? "ERROR" };
  const hasOutcomeFailure = (result.ruleOutcomes ?? []).some(outcome => outcome.failed > 0) ||
    (result.groupOutcomes ?? []).some(outcome => outcome.failed > 0);
  const importanceAware = usesImportance(result, options);
  let importanceRate: WeightedCheckRate | undefined;
  if (importanceAware) {
    if (result.preview?.scope === "sample") return unavailableHealth(result, "sampled-evaluation");
    if (result.outcomeRetention?.evaluationComplete === false) {
      return unavailableHealth(result, "incomplete-evaluation");
    }
    const outcomes = result.checkOutcomes ?? [];
    if (outcomes.some(outcome => outcome.status === "unknown" || outcome.status === "not-evaluated")) {
      return unavailableHealth(result, "indeterminate-checks");
    }
    importanceRate = weightedCheckFailureRate(result, options);
    if (!importanceRate) return unavailableHealth(result, "no-evaluated-checks");
  }
  if (result.errorCount === 0 && result.warningCount === 0 && result.issueCount === 0 && !hasOutcomeFailure && (importanceRate?.failedWeight ?? 0) === 0) {
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
    const weights = result.issues.filter(issue => (issue.testId ?? issue.code) === id)
      .map(issue => issue.importance).filter((weight): weight is number => weight !== undefined);
    const outcome = [...(result.ruleOutcomes ?? []), ...(result.groupOutcomes ?? [])].find(item => item.id === id);
    return weights.length ? Math.max(...weights) : outcome?.importance ?? DEFAULT_IMPORTANCE;
  };
  const legacyWeightedChecks = [...errorChecks].reduce((total, id) => total + importanceFor(id), 0) +
    [...warningChecks].reduce((total, id) => total + importanceFor(id) * 0.25, 0);
  const ordinaryWeightedChecks = Math.max(result.errorCount > 0 ? 1 : 0, errorChecks.size) + warningChecks.size * 0.25;
  const weightedChecks = importanceAware ? legacyWeightedChecks : ordinaryWeightedChecks;
  const checkRate = importanceRate?.rate ?? Math.min(1, weightedChecks / Math.max(1, result.testCount, errorChecks.size + warningChecks.size));
  const weightedEvents = result.issues.some(issue => issue.importance !== undefined)
    ? result.issues.reduce((total, issue) => total + (issue.importance ?? DEFAULT_IMPORTANCE) * (issue.severity === "warning" ? 0.25 : 1), 0)
    : result.errorCount + result.warningCount * 0.25;
  const eventRate = Math.min(1, weightedEvents / Math.max(1, result.rowCount, result.issueCount));
  const impact = 0.65 * Math.sqrt(checkRate) + 0.35 * Math.sqrt(eventRate);
  // A zero-importance failure contributes no graded impact, but it is still a
  // validation failure. Keep 100 reserved for the clean-result branch above.
  const score = Math.min(99, Math.max(0, Math.round(100 * (1 - impact))));
  const band: ResultHealthBand = score >= 75 ? "attention" : score >= 45 ? "concerning" : "critical";
  return { score, band, label: result.valid ? "PASS WITH WARNINGS" : "FAIL" };
}

export function aggregateResultHealth(
  entries: Array<{ result?: ValidationResult; status?: string }>,
  mode: ResultColorMode = "binary",
  options: ResultHealthOptions = {}
): ResultHealth {
  if (!entries.length) return { score: 0, band: "critical", label: "NO RESULTS" };
  const health = entries.map(entry => resultHealth(entry.result, entry.status, mode, options));
  if (mode === "binary") return health.every(item => item.band === "perfect")
    ? { score: 100, band: "perfect", label: "PASS" }
    : { score: 0, band: "critical", label: health.some(item => item.label === "ERROR") ? "ERROR" : "FAIL" };
  const unavailable = health.find(item => item.available === false);
  if (unavailable) return { ...unavailable, label: "ISSUES" };
  const perfect = health.every(item => item.band === "perfect");
  const score = perfect ? 100 : Math.round(health.reduce((total, item) => total + item.score, 0) / health.length);
  const band: ResultHealthBand = perfect ? "perfect" : score >= 75 ? "attention" : score >= 45 ? "concerning" : "critical";
  return { score, band, label: band === "perfect" ? "PASS" : entries.some(entry => entry.status === "ERROR") ? "ERROR" : "ISSUES" };
}

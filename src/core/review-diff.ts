import type { ValidationIssue } from "./model";
import type { ReviewPackageTarget, ValidationReviewPackage } from "./review-package";

export type ReviewDiffClassification = "new" | "resolved" | "persistent";

export interface ReviewFailureIdentity {
  workId: string;
  target: string;
  ruleId: string;
}

export interface ReviewFailureDiff {
  classification: ReviewDiffClassification;
  identity: ReviewFailureIdentity;
  /** Complete counts of saved issue objects for this rule, not impacted source records. */
  beforeFindingEvents: number;
  afterFindingEvents: number;
  findingEventDelta: number;
  /** Descriptive fields come only from the already-redacted saved packages. */
  finding: {
    code: string;
    title?: string;
    message: string;
    severity: "error" | "warning";
  };
}

export type ReviewDiffIndeterminateReason =
  | "definitions-missing"
  | "definitions-changed"
  | "target-definitions-missing"
  | "target-definitions-changed"
  | "work-id-missing"
  | "target-changed"
  | "target-missing-before"
  | "target-missing-after"
  | "target-identity-duplicate"
  | "scope-missing"
  | "scope-changed"
  | "evaluation-incomplete"
  | "issue-details-incomplete"
  | "rule-id-missing"
  | "rule-id-ambiguous";

export interface ReviewDiffIndeterminate {
  reason: ReviewDiffIndeterminateReason;
  message: string;
  workId?: string;
  target?: string;
  ruleId?: string;
  beforeIssueEvents?: number;
  afterIssueEvents?: number;
}

export interface ReviewPackageComparison {
  schema: "incursa.validation-review-diff/v1";
  before: { packageId: string; createdAt: string };
  after: { packageId: string; createdAt: string };
  definitionsMatch: boolean;
  newFailures: ReviewFailureDiff[];
  resolvedFailures: ReviewFailureDiff[];
  persistentFailures: ReviewFailureDiff[];
  indeterminate: ReviewDiffIndeterminate[];
  summary: {
    comparableTargets: number;
    newRules: number;
    resolvedRules: number;
    persistentRules: number;
    beforeFindingEvents: number;
    afterFindingEvents: number;
    indeterminateItems: number;
  };
}

interface RuleFailures {
  findingEvents: number;
  issue: ValidationIssue;
  signatures: Set<string>;
}

interface TargetEntry {
  target: ReviewPackageTarget;
  index: number;
}

function definitionIdentity(pkg: ValidationReviewPackage): string[] {
  return pkg.provenance.definitions
    .map(definition => `${definition.source.length}:${definition.source}${definition.fingerprint.length}:${definition.fingerprint}`)
    .sort();
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function targetKey(target: ReviewPackageTarget): string | undefined {
  const workId = target.workId?.trim();
  return workId ? `${workId.length}:${workId}${target.target.length}:${target.target}` : undefined;
}

function indexTargets(pkg: ValidationReviewPackage): { byKey: Map<string, TargetEntry[]>; missingWorkId: TargetEntry[] } {
  const byKey = new Map<string, TargetEntry[]>();
  const missingWorkId: TargetEntry[] = [];
  pkg.targets.forEach((target, index) => {
    const entry = { target, index };
    const key = targetKey(target);
    if (!key) {
      missingWorkId.push(entry);
      return;
    }
    const entries = byKey.get(key) ?? [];
    entries.push(entry);
    byKey.set(key, entries);
  });
  return { byKey, missingWorkId };
}

function issueSignature(issue: ValidationIssue): string {
  return JSON.stringify([issue.code, issue.level, issue.column ?? "", issue.severity ?? "error"]);
}

function ruleFailures(target: ReviewPackageTarget): { rules: Map<string, RuleFailures>; missingRuleIds: number } {
  const rules = new Map<string, RuleFailures>();
  let missingRuleIds = 0;
  for (const issue of target.result?.issues ?? []) {
    const ruleId = issue.testId?.trim();
    if (!ruleId) {
      missingRuleIds++;
      continue;
    }
    const current = rules.get(ruleId);
    if (current) {
      current.findingEvents++;
      current.signatures.add(issueSignature(issue));
    } else {
      rules.set(ruleId, { findingEvents: 1, issue, signatures: new Set([issueSignature(issue)]) });
    }
  }
  return { rules, missingRuleIds };
}

function targetCompletenessReason(target: ReviewPackageTarget): "evaluation-incomplete" | "issue-details-incomplete" | undefined {
  const result = target.result;
  if (!result) return "evaluation-incomplete";
  if (target.completeness.issueDetails !== "complete" || result.truncated || result.issueCount !== result.issues.length || target.completeness.totalIssues !== result.issueCount || target.completeness.retainedIssues !== result.issues.length) return "issue-details-incomplete";
  if (target.completeness.evaluation !== "complete" || result.preview?.scope === "sample") return "evaluation-incomplete";
  if (!["PASS", "FAIL"].includes(target.status)) return "evaluation-incomplete";
  return undefined;
}

function describe(issue: ValidationIssue): ReviewFailureDiff["finding"] {
  return {
    code: issue.code,
    ...(issue.title ? { title: issue.title } : {}),
    message: issue.message,
    severity: issue.severity ?? "error"
  };
}

function failureDiff(
  classification: ReviewDiffClassification,
  workId: string,
  target: string,
  ruleId: string,
  before: RuleFailures | undefined,
  after: RuleFailures | undefined
): ReviewFailureDiff {
  const beforeFindingEvents = before?.findingEvents ?? 0;
  const afterFindingEvents = after?.findingEvents ?? 0;
  return {
    classification,
    identity: { workId, target, ruleId },
    beforeFindingEvents,
    afterFindingEvents,
    findingEventDelta: afterFindingEvents - beforeFindingEvents,
    finding: describe((after ?? before)!.issue)
  };
}

function itemOrder(left: ReviewFailureDiff, right: ReviewFailureDiff): number {
  return left.identity.workId.localeCompare(right.identity.workId)
    || left.identity.target.localeCompare(right.identity.target)
    || left.identity.ruleId.localeCompare(right.identity.ruleId);
}

/**
 * Compare two self-contained, parsed review packages without querying their sources.
 * A failure is classified only when definitions, target, scope, evaluation, and all
 * issue details are complete and unambiguous. Anything less is explicitly unknown.
 */
export function compareValidationReviewPackages(before: ValidationReviewPackage, after: ValidationReviewPackage): ReviewPackageComparison {
  const newFailures: ReviewFailureDiff[] = [];
  const resolvedFailures: ReviewFailureDiff[] = [];
  const persistentFailures: ReviewFailureDiff[] = [];
  const indeterminate: ReviewDiffIndeterminate[] = [];
  let comparableTargets = 0;

  const beforeDefinitions = definitionIdentity(before);
  const afterDefinitions = definitionIdentity(after);
  const definitionsPresent = beforeDefinitions.length > 0 && afterDefinitions.length > 0;
  const definitionsMatch = definitionsPresent && arraysEqual(beforeDefinitions, afterDefinitions);
  if (!definitionsMatch) {
    const reason = definitionsPresent ? "definitions-changed" : "definitions-missing";
    indeterminate.push({
      reason,
      message: reason === "definitions-changed"
        ? "Saved runs use different validation definitions; failures cannot be classified as new or resolved."
        : "One or both saved runs omit validation definition fingerprints; failures cannot be classified as new or resolved."
    });
    return finish();
  }

  const beforeIndex = indexTargets(before);
  const afterIndex = indexTargets(after);
  for (const entry of beforeIndex.missingWorkId) indeterminate.push({ reason: "work-id-missing", message: "The earlier run has no stable workId.", target: entry.target.target });
  for (const entry of afterIndex.missingWorkId) indeterminate.push({ reason: "work-id-missing", message: "The later run has no stable workId.", target: entry.target.target });

  const allKeys = new Set([...beforeIndex.byKey.keys(), ...afterIndex.byKey.keys()]);
  for (const key of allKeys) {
    const beforeEntries = beforeIndex.byKey.get(key) ?? [];
    const afterEntries = afterIndex.byKey.get(key) ?? [];
    const sample = beforeEntries[0]?.target ?? afterEntries[0]!.target;
    if (beforeEntries.length > 1 || afterEntries.length > 1) {
      indeterminate.push({ reason: "target-identity-duplicate", message: "A workId and target identify more than one run in the same package.", workId: sample.workId, target: sample.target });
      continue;
    }
    if (!beforeEntries.length || !afterEntries.length) {
      const otherPackage = beforeEntries.length ? after : before;
      const sameWorkId = otherPackage.targets.filter(target => target.workId === sample.workId);
      const changed = sameWorkId.length > 0;
      indeterminate.push({
        reason: changed ? "target-changed" : beforeEntries.length ? "target-missing-after" : "target-missing-before",
        message: changed
          ? "The target associated with this workId changed between saved runs."
          : beforeEntries.length ? "This target is absent from the later saved run." : "This target is absent from the earlier saved run.",
        workId: sample.workId,
        target: sample.target
      });
      continue;
    }

    const beforeTarget = beforeEntries[0].target;
    const afterTarget = afterEntries[0].target;
    if (!beforeTarget.scope?.trim() || !afterTarget.scope?.trim()) {
      indeterminate.push({ reason: "scope-missing", message: "Both saved runs need a stable scope identity.", workId: beforeTarget.workId, target: beforeTarget.target });
      continue;
    }
    if (beforeTarget.scope !== afterTarget.scope) {
      indeterminate.push({ reason: "scope-changed", message: "The validation scope changed between saved runs.", workId: beforeTarget.workId, target: beforeTarget.target });
      continue;
    }
    const beforeTargetDefinitions = [...beforeTarget.definitionFingerprints].sort();
    const afterTargetDefinitions = [...afterTarget.definitionFingerprints].sort();
    if (!beforeTargetDefinitions.length || !afterTargetDefinitions.length) {
      indeterminate.push({ reason: "target-definitions-missing", message: "Both target runs need effective validation-definition fingerprints.", workId: beforeTarget.workId, target: beforeTarget.target });
      continue;
    }
    if (!arraysEqual(beforeTargetDefinitions, afterTargetDefinitions)) {
      indeterminate.push({ reason: "target-definitions-changed", message: "The effective validation definitions bound to this target changed between saved runs.", workId: beforeTarget.workId, target: beforeTarget.target });
      continue;
    }
    const beforeIncomplete = targetCompletenessReason(beforeTarget);
    const afterIncomplete = targetCompletenessReason(afterTarget);
    if (beforeIncomplete || afterIncomplete) {
      const reason = beforeIncomplete === "issue-details-incomplete" || afterIncomplete === "issue-details-incomplete" ? "issue-details-incomplete" : "evaluation-incomplete";
      indeterminate.push({
        reason,
        message: reason === "issue-details-incomplete"
          ? "At least one saved run retained only part of its issue details; absence cannot prove resolution."
          : "At least one saved run was sampled, not run, or otherwise not completely evaluated.",
        workId: beforeTarget.workId,
        target: beforeTarget.target,
        beforeIssueEvents: beforeTarget.completeness.totalIssues,
        afterIssueEvents: afterTarget.completeness.totalIssues
      });
      continue;
    }

    const beforeRules = ruleFailures(beforeTarget);
    const afterRules = ruleFailures(afterTarget);
    if (beforeRules.missingRuleIds || afterRules.missingRuleIds) {
      indeterminate.push({
        reason: "rule-id-missing",
        message: "At least one retained issue has no stable ruleId/testId.",
        workId: beforeTarget.workId,
        target: beforeTarget.target,
        beforeIssueEvents: beforeRules.missingRuleIds,
        afterIssueEvents: afterRules.missingRuleIds
      });
      continue;
    }
    const ambiguousRuleIds = new Set([
      ...[...beforeRules.rules].filter(([, group]) => group.signatures.size > 1).map(([ruleId]) => ruleId),
      ...[...afterRules.rules].filter(([, group]) => group.signatures.size > 1).map(([ruleId]) => ruleId)
    ]);
    if (ambiguousRuleIds.size) {
      for (const ruleId of [...ambiguousRuleIds].sort()) {
        indeterminate.push({ reason: "rule-id-ambiguous", message: "One ruleId identifies different finding shapes within a saved run.", workId: beforeTarget.workId, target: beforeTarget.target, ruleId });
      }
      continue;
    }

    comparableTargets++;
    const ruleIds = new Set([...beforeRules.rules.keys(), ...afterRules.rules.keys()]);
    for (const ruleId of ruleIds) {
      const beforeRule = beforeRules.rules.get(ruleId);
      const afterRule = afterRules.rules.get(ruleId);
      const classification: ReviewDiffClassification = beforeRule && afterRule ? "persistent" : beforeRule ? "resolved" : "new";
      const item = failureDiff(classification, beforeTarget.workId!, beforeTarget.target, ruleId, beforeRule, afterRule);
      if (classification === "new") newFailures.push(item);
      else if (classification === "resolved") resolvedFailures.push(item);
      else persistentFailures.push(item);
    }
  }

  return finish();

  function finish(): ReviewPackageComparison {
    newFailures.sort(itemOrder);
    resolvedFailures.sort(itemOrder);
    persistentFailures.sort(itemOrder);
    return {
      schema: "incursa.validation-review-diff/v1",
      before: { packageId: before.identity.packageId, createdAt: before.identity.createdAt },
      after: { packageId: after.identity.packageId, createdAt: after.identity.createdAt },
      definitionsMatch,
      newFailures,
      resolvedFailures,
      persistentFailures,
      indeterminate,
      summary: {
        comparableTargets,
        newRules: newFailures.length,
        resolvedRules: resolvedFailures.length,
        persistentRules: persistentFailures.length,
        beforeFindingEvents: resolvedFailures.reduce((sum, item) => sum + item.beforeFindingEvents, 0) + persistentFailures.reduce((sum, item) => sum + item.beforeFindingEvents, 0),
        afterFindingEvents: newFailures.reduce((sum, item) => sum + item.afterFindingEvents, 0) + persistentFailures.reduce((sum, item) => sum + item.afterFindingEvents, 0),
        indeterminateItems: indeterminate.length
      }
    };
  }
}

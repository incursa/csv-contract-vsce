import type { CheckOutcomeDescriptor, CsvContract, EvidenceValue, GroupSelection, Predicate, ValidationIssue, ValidationResult } from "./model";
import { CheckOutcomeCollector, outcomeContext } from "./check-outcomes";
import { orderedChecks } from "./ordered-rule";
/** Resolve relative bounds once at execution start, never during authoring or reload. */
export function resolveEvaluation(contract: CsvContract, evaluatedAt: string): CsvContract {
  const timestamp = Date.parse(evaluatedAt);
  if (!Number.isFinite(timestamp)) throw new Error("Evaluation time must be an ISO timestamp.");
  const resolve = (predicate: Predicate): Predicate => {
    if ("all" in predicate) return { all: predicate.all.map(resolve) };
    if ("any" in predicate) return { any: predicate.any.map(resolve) };
    if (!predicate.relativeDate) return predicate;
    if (!predicate.operator.startsWith("date") || predicate.value !== undefined || predicate.otherColumn !== undefined) throw new Error("Relative dates require a date operator and cannot also declare value/otherColumn.");
    const { days, anchor } = predicate.relativeDate;
    if (!Number.isInteger(days) || Math.abs(days) > 365000 || !["today", "now"].includes(anchor)) throw new Error("Invalid relative date bound.");
    const origin = anchor === "today" ? Date.parse(new Date(timestamp).toISOString().slice(0, 10)) : timestamp;
    const leaf = { ...predicate };
    delete leaf.relativeDate;
    return { ...leaf, value: new Date(origin + days * 86400000).toISOString() };
  };
  const resolveGroupSelection = (selection: GroupSelection): GroupSelection => {
    if ("all" in selection) return { all: selection.all.map(resolveGroupSelection) };
    if ("any" in selection) return { any: selection.any.map(resolveGroupSelection) };
    if ("rowCount" in selection) return { rowCount: { ...selection.rowCount,
      where: selection.rowCount.where ? resolve(selection.rowCount.where) : undefined } };
    return { distinctCount: { ...selection.distinctCount,
      where: selection.distinctCount.where ? resolve(selection.distinctCount.where) : undefined } };
  };
  const resolveContract = (current: CsvContract): CsvContract => ({
    ...current,
    rules: current.rules?.map(rule => ({ ...rule, when: rule.when ? resolve(rule.when) : undefined, expect: resolve(rule.expect) })),
    groupRules: current.groupRules?.map(rule => ({ ...rule, when: rule.when ? resolve(rule.when) : undefined })),
    orderedRules: current.orderedRules?.map(rule => ({ ...rule, relations: rule.relations?.map(relation => ({ ...relation,
      when: resolve(relation.when), requirePrior: relation.requirePrior ? resolve(relation.requirePrior) : undefined,
      forbidPrior: relation.forbidPrior ? resolve(relation.forbidPrior) : undefined,
      requireNext: relation.requireNext ? resolve(relation.requireNext) : undefined,
      allowBetween: relation.allowBetween ? resolve(relation.allowBetween) : undefined })) })),
    groupTests: current.groupTests?.map(group => ({ ...group,
      select: group.select ? resolveGroupSelection(group.select) : undefined,
      contract: group.contract ? resolveContract(group.contract) : undefined,
      resolvedContract: group.resolvedContract ? resolveContract(group.resolvedContract) : undefined }))
  });
  return resolveContract(contract);
}

/** Stable inventory used to prove which configured checks did or did not run. */
export function configuredChecks(contract: CsvContract, prefix = ""): CheckOutcomeDescriptor[] {
  const qualify = (id: string): string => `${prefix}${id}`;
  const metadata = (check: { name?: string; severity?: "error" | "warning"; importance?: number }): Pick<CheckOutcomeDescriptor, "name" | "severity" | "importance"> => ({
    ...(check.name ? { name: check.name } : {}),
    ...(check.severity ? { severity: check.severity } : {}),
    ...(check.importance !== undefined && Number.isFinite(check.importance) && check.importance >= 0.1 && check.importance <= 10 ? { importance: check.importance } : {})
  });
  const checks: CheckOutcomeDescriptor[] = [
    ...(contract.rowTests ?? []).map(check => ({ id: qualify(check.id), ...metadata(check), kind: "row-test" as const })),
    ...(contract.rules ?? []).map(check => ({ id: qualify(check.id), ...metadata(check), kind: "row-rule" as const })),
    ...(contract.groupRules ?? []).map(check => ({ id: qualify(check.id), ...metadata(check), kind: "group-rule" as const })),
    ...(contract.orderedRules ?? []).flatMap(rule => orderedChecks(rule).map(check => ({
      id: qualify(check.id), ...metadata({ ...check, importance: check.importance ?? rule.importance }), kind: "ordered-rule" as const
    }))),
    ...(contract.groupTests ?? []).map(check => ({ id: qualify(check.id), ...metadata(check), kind: "group-test" as const })),
    ...(contract.sqlServer?.conditionalRules ?? []).map(check => ({ id: qualify(check.id), ...metadata(check), kind: "sql-rule" as const }))
  ];
  for (const group of contract.groupTests ?? []) {
    const child = group.resolvedContract ?? group.contract;
    if (child) checks.push(...configuredChecks(child, `${prefix}${group.id}/`));
  }
  return checks;
}

const unavailableCodes = new Set([
  "DUPLICATE_TEST_ID", "UNDECLARED_TEST_COLUMN", "TEST_COLUMN_MISSING",
  "DUPLICATE_RULE_ID", "UNDECLARED_RULE_COLUMN", "RULE_COLUMN_MISSING",
  "SEQUENCE_COLUMN_MISSING", "GROUP_REF_UNRESOLVED", "GROUP_COLUMN_MISSING"
]);

function issueContext(contract: CsvContract, issue: ValidationIssue): ReturnType<typeof outcomeContext> {
  const primary = issue.evidence?.samples[0]?.primary?.values;
  const identity = primary && contract.identity ? Object.fromEntries(contract.identity.columns.flatMap(column =>
    Object.prototype.hasOwnProperty.call(primary, column) ? [[column, primary[column] as EvidenceValue]] : [])) : undefined;
  return outcomeContext({
    ...(identity && Object.keys(identity).length ? { identity } : {}),
    ...(issue.group ? { group: issue.group } : {}),
    ...(issue.relatedRows ? { relatedRows: issue.relatedRows } : {}),
    ...(issue.evidence?.aggregate ? { aggregate: issue.evidence.aggregate } : {})
  });
}

/**
 * Adds an explicit compatibility manifest to legacy validation results. It trusts reported
 * aggregate counts, retains known failures, and marks all missing evidence unknown rather
 * than deriving success from an empty issue list.
 */
export function attachCheckOutcomes(contract: CsvContract, result: ValidationResult, options: {
  maxRetained?: number;
  evaluationComplete?: boolean;
  incompleteReason?: string;
} = {}): ValidationResult {
  if (result.checkOutcomes && result.rowOutcomes && result.outcomeRetention) return result;
  const descriptors = configuredChecks(contract);
  const known = new Map(descriptors.map(descriptor => [descriptor.id, descriptor]));
  const collector = new CheckOutcomeCollector(descriptors, options.maxRetained);
  const aggregateIds = new Set<string>();
  for (const outcome of result.ruleOutcomes ?? []) {
    aggregateIds.add(outcome.id);
    collector.aggregate(outcome.id, outcome);
  }
  for (const outcome of result.groupOutcomes ?? []) {
    aggregateIds.add(outcome.id);
    collector.aggregate(outcome.id, { ...outcome, selected: outcome.groups });
  }
  const unavailable = new Set<string>();
  for (const issue of result.issues) {
    if (!issue.testId || !known.has(issue.testId)) continue;
    if (unavailableCodes.has(issue.code)) {
      if (!aggregateIds.has(issue.testId) && !unavailable.has(issue.testId)) {
        collector.unavailable(issue.testId, "not-evaluated", issue.code.toLowerCase().replace(/_/g, "-"));
        unavailable.add(issue.testId);
      }
      continue;
    }
    const descriptor = known.get(issue.testId)!;
    const detail = {
      checkId: issue.testId,
      checkName: descriptor.name,
      kind: descriptor.kind,
      status: "fail" as const,
      row: issue.row,
      context: issueContext(contract, issue)
    };
    if (aggregateIds.has(issue.testId)) collector.retain(detail);
    else collector.record(detail);
  }
  // Result.truncated describes retained issue detail, not whether execution completed.
  const complete = options.evaluationComplete ?? true;
  return {
    ...result,
    ...collector.finish({ complete, reason: options.incompleteReason })
  };
}

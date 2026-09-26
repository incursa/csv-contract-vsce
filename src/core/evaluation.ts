import type { CsvContract, Predicate } from "./model";
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
      contract: group.contract ? resolveContract(group.contract) : undefined,
      resolvedContract: group.resolvedContract ? resolveContract(group.resolvedContract) : undefined }))
  });
  return resolveContract(contract);
}

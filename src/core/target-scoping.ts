import type { CsvContract } from "./model";

type Scoped = { targets?: string[] };

function retain<T extends Scoped>(items: T[] | undefined, targetId: string | undefined): T[] | undefined {
  if (!items) return undefined;
  return items.filter(item => item.targets === undefined || targetId !== undefined && item.targets.includes(targetId))
    .map(item => {
      const copy = { ...item };
      delete copy.targets;
      return copy;
    });
}

/**
 * Produce the executable contract for one logical target. Selectors are runtime-only policy:
 * evaluators receive their existing rule shapes and unscoped definitions retain legacy behavior.
 */
export function contractForTarget(contract: CsvContract, targetId?: string): CsvContract {
  const copy = structuredClone(contract);
  copy.rowTests = retain(copy.rowTests, targetId);
  copy.rules = retain(copy.rules, targetId);
  copy.groupRules = retain(copy.groupRules, targetId);
  copy.orderedRules = retain(copy.orderedRules, targetId);
  copy.groupTests = retain(copy.groupTests, targetId)?.map(group => ({
    ...group,
    ...(group.contract ? { contract: contractForTarget(group.contract, targetId) } : {}),
    ...(group.resolvedContract ? { resolvedContract: contractForTarget(group.resolvedContract, targetId) } : {})
  }));
  if (copy.sqlServer?.conditionalRules) {
    copy.sqlServer.conditionalRules = retain(copy.sqlServer.conditionalRules, targetId);
  }
  return copy;
}

export function validateRuleTargetSelectors(contract: CsvContract): void {
  const ids = new Set<string>();
  const add = (id: string | undefined): void => {
    if (!id) return;
    if (ids.has(id)) throw new Error(`Target id '${id}' must be unique across SQL Server and CSV targets.`);
    ids.add(id);
  };
  for (const target of contract.sqlServer?.targets ?? []) add(target.id);
  for (const target of contract.targets ?? []) add(target.id);
  const inspect = (items: Scoped[] | undefined, family: string): void => {
    for (const item of items ?? []) for (const target of item.targets ?? []) {
      if (!ids.has(target)) throw new Error(`${family} target selector references unknown target id '${target}'.`);
    }
  };
  inspect(contract.rulePacks, "Rule-pack binding");
  inspect(contract.rowTests, "Row test");
  inspect(contract.rules, "Rule");
  inspect(contract.groupRules, "Group rule");
  inspect(contract.orderedRules, "Ordered rule");
  inspect(contract.groupTests, "Group test");
  inspect(contract.sqlServer?.conditionalRules, "SQL conditional rule");
}

import type { CsvContract } from "./model";

/** A snapshot can prove definition equality only when every executable dependency is materialized. */
export function hasCompleteReviewDefinition(contract: CsvContract, ancestors = new Set<CsvContract>()): boolean {
  if (ancestors.has(contract)) return false;
  if (contract.rulePacks?.length || contract.baseline && "ref" in contract.baseline ||
      contract.sqlServer?.targets?.some(target => target.baseline && "ref" in target.baseline)) return false;
  const next = new Set(ancestors).add(contract);
  return (contract.groupTests ?? []).every(group => {
    const child = group.resolvedContract ?? group.contract;
    return !!child && hasCompleteReviewDefinition(child, next);
  });
}

/** Include runtime-resolved children that ordinary YAML/JSON serialization intentionally omits. */
export function reviewDefinitionText(contract: CsvContract): string {
  const materialize = (value: CsvContract, ancestors: Set<CsvContract>): CsvContract => {
    if (ancestors.has(value)) throw new Error("Cannot snapshot a cyclic validation definition.");
    const next = new Set(ancestors).add(value);
    return {
      ...value,
      ...(value.groupTests ? { groupTests: value.groupTests.map(group => {
        const copy = { ...group };
        const child = group.resolvedContract ?? group.contract;
        if (child) {
          copy.contract = materialize(child, next);
          delete copy.ref;
        }
        delete copy.resolvedContract;
        delete copy.resolvedSource;
        return copy;
      }) } : {})
    };
  };
  return JSON.stringify(materialize(contract, new Set()), null, 2);
}

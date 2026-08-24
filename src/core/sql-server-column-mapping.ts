import type { CsvContract, Predicate } from "./model";
import type { ResolvedSqlServerTarget } from "./sql-server-targets";

export interface SqlColumnMatch {
  contractColumn: string;
  physicalColumn: string;
  method: "exact" | "case-insensitive" | "standardized";
}

export interface SqlColumnMappingSuggestion {
  matches: SqlColumnMatch[];
  columnMap: Record<string, string>;
  unmatched: string[];
  ambiguous: string[];
}

function standardized(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

export function suggestSqlColumnMappings(
  contractColumns: string[],
  physicalColumns: string[]
): SqlColumnMappingSuggestion {
  const matches: SqlColumnMatch[] = [];
  const ambiguous: string[] = [];
  const remaining = new Set(contractColumns);
  const available = new Set(physicalColumns);
  const passes: Array<{ method: SqlColumnMatch["method"]; equal(left: string, right: string): boolean }> = [
    { method: "exact", equal: (left, right) => left === right },
    { method: "case-insensitive", equal: (left, right) => left.toLowerCase() === right.toLowerCase() },
    { method: "standardized", equal: (left, right) => standardized(left) === standardized(right) }
  ];
  for (const pass of passes) {
    for (const contractColumn of contractColumns) {
      if (!remaining.has(contractColumn)) continue;
      const candidates = [...available].filter((physical) => pass.equal(contractColumn, physical));
      if (candidates.length === 1) {
        available.delete(candidates[0]);
        remaining.delete(contractColumn);
        matches.push({ contractColumn, physicalColumn: candidates[0], method: pass.method });
      } else if (candidates.length > 1) {
        remaining.delete(contractColumn);
        ambiguous.push(contractColumn);
      }
    }
  }
  matches.sort((left, right) => contractColumns.indexOf(left.contractColumn) - contractColumns.indexOf(right.contractColumn));
  return {
    matches,
    columnMap: Object.fromEntries(matches.filter((match) => match.method !== "exact").map((match) => [match.contractColumn, match.physicalColumn])),
    unmatched: contractColumns.filter((column) => remaining.has(column)),
    ambiguous
  };
}

function mapPredicate(predicate: Predicate, physical: (column: string) => string): Predicate {
  if ("all" in predicate) return { all: predicate.all.map((part) => mapPredicate(part, physical)) };
  if ("any" in predicate) return { any: predicate.any.map((part) => mapPredicate(part, physical)) };
  return {
    ...predicate,
    column: physical(predicate.column),
    otherColumn: predicate.otherColumn ? physical(predicate.otherColumn) : undefined
  };
}

function mapRecordKeys<T>(record: Record<string, T>, physical: (column: string) => string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).map(([column, value]) => [physical(column), value]));
}

export interface PhysicalSqlContract {
  contract: CsvContract;
  target: ResolvedSqlServerTarget;
  physicalToCanonical: Record<string, string>;
}

export function createPhysicalSqlContract(contract: CsvContract, target: ResolvedSqlServerTarget): PhysicalSqlContract {
  const output = JSON.parse(JSON.stringify(contract)) as CsvContract;
  const physical = (column: string): string => target.columnMap?.[column] ?? column;
  const physicalToCanonical = Object.fromEntries(Object.keys(contract.schema.columns).map((column) => [physical(column), column]));
  output.schema.columns = mapRecordKeys(output.schema.columns, physical);
  if (output.identity) output.identity.columns = output.identity.columns.map(physical);
  for (const test of output.rowTests ?? []) {
    test.select = mapRecordKeys(test.select, physical);
    if (test.expect.cells) test.expect.cells = mapRecordKeys(test.expect.cells, physical);
  }
  output.rules = output.rules?.map((rule) => ({
    ...rule,
    when: rule.when ? mapPredicate(rule.when, physical) : undefined,
    expect: mapPredicate(rule.expect, physical)
  }));
  output.groupRules = output.groupRules?.map((rule) => ({
    ...rule,
    when: rule.when ? mapPredicate(rule.when, physical) : undefined,
    groupBy: rule.groupBy.map(physical),
    require: { ...rule.require, column: physical(rule.require.column) }
  }));
  if (output.sqlServer) {
    output.sqlServer.rowLocator = output.sqlServer.rowLocator?.map(physical);
    output.sqlServer.scope = output.sqlServer.scope ? { ...output.sqlServer.scope, column: physical(output.sqlServer.scope.column) } : undefined;
    output.sqlServer.conditionalRules = output.sqlServer.conditionalRules?.map((rule) => ({
      ...rule,
      when: rule.when ? mapPredicate(rule.when as Predicate, physical) as typeof rule.when : undefined,
      expect: mapPredicate(rule.expect as Predicate, physical) as typeof rule.expect
    }));
  }
  return {
    contract: output,
    target: {
      ...target,
      columnMap: undefined,
      scope: target.scope ? { ...target.scope, column: physical(target.scope.column) } : undefined
    },
    physicalToCanonical
  };
}

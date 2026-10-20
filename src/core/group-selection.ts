import type { CountExpectation, CsvOptions, GroupSelection, Predicate } from "./model";
import { evaluatePredicate, predicateColumns } from "./predicate";

export function groupSelectionColumns(selection: GroupSelection | undefined): string[] {
  if (!selection) return [];
  if ("all" in selection) return selection.all.flatMap(groupSelectionColumns);
  if ("any" in selection) return selection.any.flatMap(groupSelectionColumns);
  if ("rowCount" in selection) return predicateColumns(selection.rowCount.where);
  return [selection.distinctCount.column, ...predicateColumns(selection.distinctCount.where)];
}

export function validateGroupSelection(selection: GroupSelection, declared: Set<string>, groupId: string): void {
  for (const column of new Set(groupSelectionColumns(selection))) {
    if (!declared.has(column)) throw new Error(`Group test ${groupId} selector references undeclared column ${column}.`);
  }
}

function countMatches(actual: number, expected: CountExpectation): boolean {
  return (expected.exact === undefined || actual === expected.exact) &&
    (expected.min === undefined || actual >= expected.min) &&
    (expected.max === undefined || actual <= expected.max);
}

interface SelectionNode {
  add(row: Record<string, string>): void;
  matches(): boolean;
}

function node(selection: GroupSelection, options: CsvOptions): SelectionNode {
  const normalized = (value: string): string => {
    const trimmed = options.trimValues ? value.trim() : value;
    return options.caseSensitive === false ? trimmed.toLowerCase() : trimmed;
  };
  const nullValues = new Set((options.nullValues ?? [""]).map(normalized));
  const predicateMatches = (predicate: Predicate | undefined, row: Record<string, string>): boolean => !predicate || evaluatePredicate(predicate, {
    value: column => row[column] ?? "",
    normalize: normalized,
    isNull: value => nullValues.has(normalized(value)),
    caseSensitive: options.caseSensitive !== false,
    trimValues: options.trimValues
  });
  if ("all" in selection || "any" in selection) {
    const children = ("all" in selection ? selection.all : selection.any).map(child => node(child, options));
    return {
      add: row => children.forEach(child => child.add(row)),
      matches: () => "all" in selection ? children.every(child => child.matches()) : children.some(child => child.matches())
    };
  }
  if ("rowCount" in selection) {
    let count = 0;
    return {
      add: row => { if (predicateMatches(selection.rowCount.where, row)) count++; },
      matches: () => countMatches(count, selection.rowCount.count)
    };
  }
  const values = new Set<string>();
  return {
    add: row => {
      if (predicateMatches(selection.distinctCount.where, row)) values.add(normalized(row[selection.distinctCount.column] ?? ""));
    },
    matches: () => countMatches(values.size, selection.distinctCount.count)
  };
}

export class GroupSelectionEvaluator {
  private readonly root?: SelectionNode;

  public constructor(selection: GroupSelection | undefined, options: CsvOptions) {
    this.root = selection ? node(selection, options) : undefined;
  }

  public add(row: Record<string, string>): void { this.root?.add(row); }
  public matches(): boolean { return this.root?.matches() ?? true; }
}

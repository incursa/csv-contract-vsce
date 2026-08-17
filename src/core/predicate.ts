import type { CsvOptions, Predicate, PredicateLeaf } from "./model";

const expressionCache = new Map<string, RegExp | null>();

export interface PredicateRuntime {
  value(column: string): string;
  normalize(value: string): string;
  isNull(value: string): boolean;
  caseSensitive: boolean;
}

export function predicateColumns(predicate: Predicate | undefined): string[] {
  if (!predicate) return [];
  if ("all" in predicate) return predicate.all.flatMap(predicateColumns);
  if ("any" in predicate) return predicate.any.flatMap(predicateColumns);
  return predicate.otherColumn ? [predicate.column, predicate.otherColumn] : [predicate.column];
}

export function evaluatePredicate(predicate: Predicate, runtime: PredicateRuntime): boolean {
  if ("all" in predicate) return predicate.all.every((part) => evaluatePredicate(part, runtime));
  if ("any" in predicate) return predicate.any.some((part) => evaluatePredicate(part, runtime));
  return evaluateLeaf(predicate, runtime);
}

export function predicateDescription(predicate: Predicate): string {
  if ("all" in predicate) return `all of (${predicate.all.map(predicateDescription).join("; ")})`;
  if ("any" in predicate) return `any of (${predicate.any.map(predicateDescription).join("; ")})`;
  if (predicate.values) return `${predicate.column} ${predicate.operator} [${predicate.values.join(", ")}]`;
  if (predicate.otherColumn) return `${predicate.column} ${predicate.operator} ${predicate.otherColumn}`;
  if (predicate.value !== undefined) return `${predicate.column} ${predicate.operator} ${String(predicate.value)}`;
  return `${predicate.column} ${predicate.operator}`;
}

export function createPredicateRuntime(
  value: (column: string) => string,
  options: Required<CsvOptions>,
  nullValues: Set<string>
): PredicateRuntime {
  const normalize = (input: string): string => {
    const effective = options.trimValues ? input.trim() : input;
    return options.caseSensitive ? effective : effective.toLowerCase();
  };
  return {
    value,
    normalize,
    isNull: (input) => nullValues.has(normalize(input)),
    caseSensitive: options.caseSensitive
  };
}

function evaluateLeaf(leaf: PredicateLeaf, runtime: PredicateRuntime): boolean {
  const actual = runtime.value(leaf.column);
  const normalized = runtime.normalize(actual);
  const expected = leaf.value === undefined ? "" : String(leaf.value);
  const normalizedExpected = runtime.normalize(expected);
  const other = leaf.otherColumn === undefined ? "" : runtime.value(leaf.otherColumn);
  switch (leaf.operator) {
    case "equals": return normalized === normalizedExpected;
    case "notEquals": return normalized !== normalizedExpected;
    case "in": return (leaf.values ?? []).some((value) => runtime.normalize(value) === normalized);
    case "notIn": return !(leaf.values ?? []).some((value) => runtime.normalize(value) === normalized);
    case "isNull": return runtime.isNull(actual);
    case "notNull": return !runtime.isNull(actual);
    case "isBlank": return actual.trim().length === 0;
    case "notBlank": return actual.trim().length > 0;
    case "equalsColumn": return normalized === runtime.normalize(other);
    case "notEqualsColumn": return normalized !== runtime.normalize(other);
    case "contains": return normalized.includes(normalizedExpected);
    case "notContains": return !normalized.includes(normalizedExpected);
    case "startsWith": return normalized.startsWith(normalizedExpected);
    case "endsWith": return normalized.endsWith(normalizedExpected);
    case "matches": {
      const key = `${runtime.caseSensitive ? "c" : "i"}\u0000${expected}`;
      if (!expressionCache.has(key)) {
        try {
          expressionCache.set(key, new RegExp(expected, runtime.caseSensitive ? "" : "i"));
        } catch {
          expressionCache.set(key, null);
        }
      }
      return expressionCache.get(key)?.test(actual) ?? false;
    }
    case "greaterThan": return numeric(actual, expected, (left, right) => left > right);
    case "greaterThanOrEqual": return numeric(actual, expected, (left, right) => left >= right);
    case "lessThan": return numeric(actual, expected, (left, right) => left < right);
    case "lessThanOrEqual": return numeric(actual, expected, (left, right) => left <= right);
  }
}

function numeric(actual: string, expected: string, compare: (left: number, right: number) => boolean): boolean {
  if (actual.trim().length === 0 || expected.trim().length === 0) return false;
  const left = Number(actual);
  const right = Number(expected);
  return Number.isFinite(left) && Number.isFinite(right) && compare(left, right);
}

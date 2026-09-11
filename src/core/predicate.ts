import type { CsvOptions, Predicate, PredicateLeaf } from "./model";

const expressionCache = new Map<string, RegExp | null>();

export interface PredicateRuntime {
  dateValue?(column: string): string | undefined;
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
  const expected = leaf.value !== undefined ? String(leaf.value) : leaf.otherColumn !== undefined && /^(?:greater|less|date)/.test(leaf.operator) ? runtime.value(leaf.otherColumn) : "";
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
    case "dateOnOrAfter": return dateCompare(runtime.dateValue?.(leaf.column) ?? actual, leaf.value === undefined && leaf.otherColumn ? runtime.dateValue?.(leaf.otherColumn) ?? expected : expected, (a, b) => a >= b);
    case "dateOnOrBefore": return dateCompare(runtime.dateValue?.(leaf.column) ?? actual, leaf.value === undefined && leaf.otherColumn ? runtime.dateValue?.(leaf.otherColumn) ?? expected : expected, (a, b) => a <= b);
    case "dateAfter": return dateCompare(runtime.dateValue?.(leaf.column) ?? actual, leaf.value === undefined && leaf.otherColumn ? runtime.dateValue?.(leaf.otherColumn) ?? expected : expected, (a, b) => a > b);
    case "dateBefore": return dateCompare(runtime.dateValue?.(leaf.column) ?? actual, leaf.value === undefined && leaf.otherColumn ? runtime.dateValue?.(leaf.otherColumn) ?? expected : expected, (a, b) => a < b);
  }
}

/** ISO date-only (UTC midnight) or ISO instant with explicit Z/offset; no local-time guessing. */
export function isoDate(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) return NaN;
  const day = value.slice(0, 10);
  const midnight = Date.parse(day);
  if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== day) return NaN;
  return Date.parse(value);
}
function dateCompare(actual: string, expected: string, compare: (a: number, b: number) => boolean): boolean {
  const a = isoDate(actual), b = isoDate(expected);
  return Number.isFinite(a) && Number.isFinite(b) && compare(a, b);
}

function numeric(actual: string, expected: string, compare: (left: number, right: number) => boolean): boolean {
  if (actual.trim().length === 0 || expected.trim().length === 0) return false;
  const left = Number(actual);
  const right = Number(expected);
  return Number.isFinite(left) && Number.isFinite(right) && compare(left, right);
}

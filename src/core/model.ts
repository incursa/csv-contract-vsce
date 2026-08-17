export type Presence = "required" | "optional";

export interface CountExpectation {
  exact?: number;
  min?: number;
  max?: number;
}

export interface CsvOptions {
  delimiter?: string;
  encoding?: "utf-8";
  quote?: string;
  header?: "required";
  nullValues?: string[];
  trimValues?: boolean;
  caseSensitive?: boolean;
  allowBlankRows?: boolean;
  allowRaggedRows?: boolean;
}

export interface ColumnConstraints {
  notNull?: boolean;
  unique?: boolean;
  minLength?: number;
  maxLength?: number;
  matches?: string;
  allowedValues?: string[];
}

export interface ColumnContract {
  presence: Presence;
  description?: string;
  constraints?: ColumnConstraints;
}

export interface RowExpectation {
  count?: CountExpectation;
  cells?: Record<string, { equals: string }>;
}

export interface RowTest {
  id: string;
  name?: string;
  select: Record<string, string>;
  expect: RowExpectation;
}

export type RuleSeverity = "error" | "warning";

export type PredicateOperator =
  | "equals"
  | "notEquals"
  | "in"
  | "notIn"
  | "isNull"
  | "notNull"
  | "isBlank"
  | "notBlank"
  | "equalsColumn"
  | "notEqualsColumn"
  | "contains"
  | "notContains"
  | "startsWith"
  | "endsWith"
  | "matches"
  | "greaterThan"
  | "greaterThanOrEqual"
  | "lessThan"
  | "lessThanOrEqual";

export interface PredicateLeaf {
  column: string;
  operator: PredicateOperator;
  value?: string | number;
  values?: string[];
  otherColumn?: string;
}

export type Predicate = PredicateLeaf | { all: Predicate[] } | { any: Predicate[] };

export type SqlPredicateOperator =
  | "equals"
  | "notEquals"
  | "in"
  | "notIn"
  | "isNull"
  | "notNull"
  | "isBlank"
  | "notBlank"
  | "equalsColumn"
  | "notEqualsColumn";

export interface SqlPredicateLeaf {
  column: string;
  operator: SqlPredicateOperator;
  value?: string;
  values?: string[];
  otherColumn?: string;
}

export type SqlPredicate = SqlPredicateLeaf | { all: SqlPredicate[] } | { any: SqlPredicate[] };

export interface ConditionalRule {
  id: string;
  name?: string;
  severity?: RuleSeverity;
  when?: Predicate;
  expect: Predicate;
}

export interface GroupValueRequirement {
  column: string;
  values?: string[];
  contains?: string[];
}

export interface GroupRule {
  id: string;
  name?: string;
  severity?: RuleSeverity;
  when?: Predicate;
  groupBy: string[];
  require: GroupValueRequirement;
}

export interface SqlConditionalRule {
  id: string;
  name?: string;
  severity?: RuleSeverity;
  when?: SqlPredicate;
  expect: SqlPredicate;
}

export interface SqlServerTarget {
  schema: string;
  table: string;
  rowLocator?: string[];
  detailLimit?: number;
  scope?: {
    column: string;
    parameter: string;
    sqlType: string;
  };
  conditionalRules?: SqlConditionalRule[];
  importedSchema?: SqlServerImportedSchema;
}

export interface SqlServerImportedColumn {
  ordinal: number;
  name: string;
  sqlType: string;
  nullable: boolean;
  identity?: boolean;
  computed?: boolean;
  maxLength?: number;
  precision?: number;
  scale?: number;
}

export interface SqlServerImportedSchema {
  formatVersion: 1;
  sourceKind: "create-table" | "database-tracking" | "database-knowledge";
  columns: SqlServerImportedColumn[];
}

export type CsvTarget =
  | { path: string; url?: never }
  | { url: string; path?: never };

export interface CsvContract {
  version: 1;
  targets?: CsvTarget[];
  csv?: CsvOptions;
  identity?: {
    columns: string[];
    unique?: boolean;
  };
  schema: {
    allowAdditionalColumns?: boolean;
    columnOrder?: "exact";
    rowCount?: CountExpectation;
    columnCount?: CountExpectation;
    columns: Record<string, ColumnContract>;
  };
  rowTests?: RowTest[];
  rules?: ConditionalRule[];
  groupRules?: GroupRule[];
  sqlServer?: SqlServerTarget;
}

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
  sourceRowNumbers: number[];
  parseErrors: string[];
}

export type IssueLevel = "file" | "column" | "row" | "cell";

export interface ValidationIssue {
  level: IssueLevel;
  code: string;
  message: string;
  column?: string;
  row?: number;
  testId?: string;
  actual?: string | number;
  expected?: string | number;
  severity?: RuleSeverity;
}

export interface ValidationResult {
  valid: boolean;
  rowCount: number;
  columnCount: number;
  testCount: number;
  issueCount: number;
  errorCount: number;
  warningCount: number;
  truncated: boolean;
  issues: ValidationIssue[];
}

export interface ValidationPerformance {
  bytesRead: number;
  durationMs: number;
  rowsPerSecond: number;
  maxRssBytes: number;
  passes: number;
}

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
  | "lessThanOrEqual"
  | "dateOnOrAfter"
  | "dateOnOrBefore"
  | "dateAfter"
  | "dateBefore";

export interface PredicateLeaf {
  relativeDate?: { anchor: "today" | "now"; days: number };
  valueType?: "string" | "number" | "boolean";
  caseSensitive?: boolean;
  decimalPlaces?: number;
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

export interface OrderedCheck {
  id: string;
  message: string;
}

export interface OrderedRelation extends OrderedCheck {
  when: Predicate;
  requirePrior?: Predicate;
  forbidPrior?: Predicate;
  requireNext?: Predicate;
  /** Maximum number of intervening rows. Omit for any prior row; defaults to zero for requireNext. */
  maxGap?: number;
  /** For requireNext, rows between the trigger and match must satisfy this predicate. */
  allowBetween?: Predicate;
  /** A trigger at the end of a partition may remain unmatched. */
  allowFinal?: boolean;
}

export interface OrderedRule {
  id: string;
  partitionBy?: string[];
  orderBy: Array<{ column: string; type: "date" | "number" | "string"; format?: "yyyy/MM/dd" | "iso"; integer?: boolean; minimum?: number }>;
  duplicateOrder?: OrderedCheck;
  invalidOrder?: OrderedCheck;
  relations?: OrderedRelation[];
  event?: {
    actionColumn: string;
    reasonColumn?: string;
    reservedReasonCodes?: string[];
    mappings: Array<{ event: string; actionCodes: string[]; reasonCodes?: string[]; reasonPolicy?: "any" }>;
    unmapped: OrderedCheck;
  };
  initial?: { state: string; event: string } & OrderedCheck;
  transitions?: Array<{ from: string; event: string; to: string } & OrderedCheck>;
  invalidTransition?: OrderedCheck;
  neutralEvents?: string[];
  finalStates?: string[];
  invalidFinal?: OrderedCheck;
  cardinality?: Array<{ event: string; exact?: number; min?: number; max?: number } & OrderedCheck>;
  adjacency?: Array<{ event: string; preceding?: string; following?: string; allowFinal?: boolean; dateRelation?: "nextDay" | "later" | "sameDay" } & OrderedCheck>;
}

export interface SqlConditionalRule {
  id: string;
  name?: string;
  severity?: RuleSeverity;
  when?: SqlPredicate;
  expect: SqlPredicate;
}

export interface SqlServerScope {
  column: string;
  parameter: string;
  sqlType: string;
  /** Resolve the runtime value from this environment variable. Never stores a secret in the contract. */
  valueEnvironment?: string;
}

export interface SqlServerIntegratedConnection {
  /** SQL Server host, optionally including a named instance (for example server\\instance). */
  server: string;
  database: string;
  /** Installed ODBC driver used by msnodesqlv8. */
  odbcDriver?: string;
  encrypt?: boolean;
  trustServerCertificate?: boolean;
}

export interface SqlServerTableTarget {
  baseline?: import("./baseline").BaselineBinding;
  name?: string;
  /** Secret-backed profile for SQL authentication or a custom connection string. */
  connection?: string;
  /** Non-secret Windows integrated connection; no profile is required. */
  integratedConnection?: SqlServerIntegratedConnection;
  schema: string;
  table: string;
  objectType?: "table" | "view";
  /** Contract column name to physical SQL Server column name. Exact matches may be omitted. */
  columnMap?: Record<string, string>;
  scope?: SqlServerScope;
}

export interface SqlServerObjectInfo {
  schema: string;
  name: string;
  objectType: "table" | "view";
  columns: string[];
}

export interface SqlServerTarget {
  /** Connection profile used by the legacy single-table form. */
  connection?: string;
  /** Windows integrated connection used by the legacy single-table form. */
  integratedConnection?: SqlServerIntegratedConnection;
  /** Legacy single-table form. Use targets for more than one table or connection. */
  schema?: string;
  table?: string;
  objectType?: "table" | "view";
  columnMap?: Record<string, string>;
  targets?: SqlServerTableTarget[];
  rowLocator?: string[];
  detailLimit?: number;
  scope?: SqlServerScope;
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
  baseline?: import("./baseline").BaselineBinding;
  /** Opaque annotations, preserved without execution behavior. */
  metadata?: Record<string, unknown>;
  targets?: CsvTarget[];
  csv?: CsvOptions;
  identity?: {
    id?: string;
    nulls?: "ignore" | "equal" | "fail";
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
  orderedRules?: OrderedRule[];
  groupTests?: GroupTest[];
  sqlServer?: SqlServerTarget;
}

export interface GroupTest {
  id: string;
  groupBy: string[];
  groupCount?: CountExpectation;
  ref?: string;
  contract?: CsvContract;
  /** Runtime resolved child and origin, never serialized. */
  resolvedContract?: CsvContract;
  resolvedSource?: string;
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
  relatedRows?: number[];
  testId?: string;
  group?: Record<string, string>;
  actual?: string | number;
  expected?: string | number;
  severity?: RuleSeverity;
}

export interface ValidationResult {
  preview?: { scope: "sample" | "complete"; rowLimit?: number; exampleLimit: number };
  examples?: { id: string; outcome: "passed" | "failed"; row: number; values: Record<string, string> }[];
  evaluatedAt?: string;
  ruleOutcomes?: { id: string; selected: number; passed: number; failed: number }[];
  groupOutcomes?: { id: string; groups: number; passed: number; failed: number }[];
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

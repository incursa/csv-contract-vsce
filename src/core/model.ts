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
    rowCount?: CountExpectation;
    columnCount?: CountExpectation;
    columns: Record<string, ColumnContract>;
  };
  rowTests?: RowTest[];
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
}

export interface ValidationResult {
  valid: boolean;
  rowCount: number;
  columnCount: number;
  testCount: number;
  issueCount: number;
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

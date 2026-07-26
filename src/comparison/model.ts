export const comparisonSchema = "incursa.csv-semantic-comparison/v1" as const;

export type ComparisonMode = "full-row-multiset" | "keyed";
export type ComparisonStatus = "equal" | "different" | "schema-mismatch" | "duplicate-keys";

export interface ComparisonNormalization {
  trim?: boolean;
  caseFold?: boolean;
  blankNullEquivalent?: boolean;
  dateColumns?: string[];
  decimalColumns?: string[];
}

export interface ComparisonOptions {
  name?: string;
  keyColumns?: string[];
  contextColumns?: string[];
  ignoredColumns?: string[];
  normalization?: ComparisonNormalization;
  maxDiagnostics?: number;
}

export interface ComparisonSideSummary {
  rowCount: number;
  distinctRowCount: number;
  duplicateRowGroups: number;
  uniqueKeyCount: number | null;
  duplicateKeyCount: number | null;
}

export interface SchemaSummary {
  leftColumns: string[];
  rightColumns: string[];
  comparableColumns: string[];
  columnsOnlyInLeft: string[];
  columnsOnlyInRight: string[];
  reordered: boolean;
}

export interface DifferenceSummary {
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
  changedCells: number;
  schemaChanges: number;
  duplicateRowCountDifferences: number;
  duplicateKeysLeft: number;
  duplicateKeysRight: number;
  changedCellsByColumn: Record<string, number>;
}

export type DiagnosticKind =
  | "schema-left-only"
  | "schema-right-only"
  | "row-added"
  | "row-removed"
  | "row-count-changed"
  | "key-added"
  | "key-removed"
  | "key-changed"
  | "duplicate-key-left"
  | "duplicate-key-right";

export interface ComparisonDiagnostic {
  id: string;
  kind: DiagnosticKind;
  count: number;
  column?: string;
  keyReference?: string;
}

export interface DiagnosticSummary {
  total: number;
  included: number;
  truncated: boolean;
  items: ComparisonDiagnostic[];
}

export interface ComparisonSummary {
  schema: typeof comparisonSchema;
  name: string;
  mode: ComparisonMode;
  status: ComparisonStatus;
  semanticEqual: boolean;
  exitCode: 0 | 1 | 3 | 4;
  options: {
    keyColumns: string[];
    contextColumns: string[];
    ignoredColumns: string[];
    normalization: Required<ComparisonNormalization>;
    maxDiagnostics: number;
  };
  columns: SchemaSummary;
  left: ComparisonSideSummary;
  right: ComparisonSideSummary;
  differences: DifferenceSummary;
  diagnostics: DiagnosticSummary;
}

export interface KeyedChange {
  keyReference: string;
  keyValues: Array<string | null>;
  contextValues: Array<string | null>;
  column: string;
  leftValue: string | null;
  rightValue: string | null;
}

export interface KeyOccurrence {
  keyReference: string;
  keyValues: Array<string | null>;
  contextValues: Array<string | null>;
  count: number;
}

export interface DuplicateKeyGroup {
  keyReference: string;
  keyValues: Array<string | null>;
  rows: Array<Array<string | null>>;
}

export interface ComparisonDetails {
  columns: string[];
  normalizedRowsTruncated: boolean;
  detailsTruncated: boolean;
  normalizedLeftRows: Array<Array<string | null>>;
  normalizedRightRows: Array<Array<string | null>>;
  leftOnlyRows: Array<Array<string | null>>;
  rightOnlyRows: Array<Array<string | null>>;
  changedCells: KeyedChange[];
  keysOnlyInLeft: KeyOccurrence[];
  keysOnlyInRight: KeyOccurrence[];
  duplicateKeysLeft: DuplicateKeyGroup[];
  duplicateKeysRight: DuplicateKeyGroup[];
}

export interface ComparisonResult {
  summary: ComparisonSummary;
  details: ComparisonDetails;
}

export class SemanticComparisonError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly column?: string,
    public readonly recordNumber?: number
  ) {
    super(message);
    this.name = "SemanticComparisonError";
  }
}

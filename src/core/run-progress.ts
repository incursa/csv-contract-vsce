/** Counts are scoped to one target. A total is omitted until it is known. */
export interface ValidationProgress {
  phase: "connecting" | "reading" | "validating" | "summarizing";
  rowsRead?: number;
  /** SQL read diagnostics, measured from query submission. */
  readElapsedMs?: number;
  firstRowMs?: number;
  totalRows?: number;
  bytesRead?: number;
  totalBytes?: number;
  groupId?: string;
  groupsValidated?: number;
  groupRowsProcessed?: number;
}

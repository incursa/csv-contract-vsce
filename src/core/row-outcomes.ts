import type { RowCheckOutcome, RowCheckOutcomeState, RowOutcomeEvidence, RowOutcomeSummary } from "./model";

export interface RowOutcomeRetention {
  maxRows: number;
  sampled?: boolean;
}

/**
 * Bounded row evidence accumulator. It deliberately has no failure-oriented
 * fallback: callers must record a state for a check they evaluate.
 */
export class RowOutcomeCollector {
  private readonly records: RowOutcomeEvidence[] = [];
  private omitted = 0;
  private current?: RowOutcomeEvidence;

  public constructor(private readonly retention: RowOutcomeRetention) {
    if (!Number.isInteger(retention.maxRows) || retention.maxRows < 0) throw new Error("row outcome maxRows must be a non-negative integer.");
  }

  public beginRow(row: number): void {
    if (this.records.length >= this.retention.maxRows) {
      this.omitted++;
      this.current = undefined;
      return;
    }
    this.current = { row, checks: {} };
    this.records.push(this.current);
  }

  public set(checkId: string, state: RowCheckOutcomeState, reason?: RowCheckOutcome["reason"]): void {
    if (!this.current) return;
    this.current.checks[checkId] = reason ? { state, reason } : { state };
  }

  public endRow(): void { this.current = undefined; }

  public result(): { rowOutcomes: RowOutcomeEvidence[]; rowOutcomeSummary: RowOutcomeSummary } {
    const sampled = this.retention.sampled === true;
    const incompleteBecause = sampled ? "sampled" : this.omitted ? "truncated" : undefined;
    return {
      rowOutcomes: this.records,
      rowOutcomeSummary: {
        retentionLimit: this.retention.maxRows,
        retainedRows: this.records.length,
        omittedRows: this.omitted,
        complete: !sampled && this.omitted === 0,
        ...(incompleteBecause ? { incompleteBecause } : {})
      }
    };
  }
}

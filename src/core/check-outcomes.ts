import type {
  CheckOutcome,
  CheckOutcomeDescriptor,
  CheckOutcomeRetention,
  CheckOutcomeStatus,
  EvidenceValue,
  RetainedRowCheckOutcome
} from "./model";

export const DEFAULT_CHECK_OUTCOME_LIMIT = 1000;
export const MAX_CHECK_OUTCOME_LIMIT = 10000;

const statuses: CheckOutcomeStatus[] = ["pass", "fail", "not-applicable", "not-evaluated", "unknown"];

function retentionLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_CHECK_OUTCOME_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_CHECK_OUTCOME_LIMIT) {
    throw new Error(`Check outcome retention must be an integer from 0 to ${MAX_CHECK_OUTCOME_LIMIT}.`);
  }
  return limit;
}

function emptyCounts(): Record<CheckOutcomeStatus, number> {
  return { pass: 0, fail: 0, "not-applicable": 0, "not-evaluated": 0, unknown: 0 };
}

function statusFor(counts: Record<CheckOutcomeStatus, number>): CheckOutcomeStatus {
  if (counts.fail) return "fail";
  if (counts.unknown) return "unknown";
  if (counts["not-evaluated"]) return "not-evaluated";
  if (counts.pass) return "pass";
  return "not-applicable";
}

interface MutableCheck {
  descriptor: CheckOutcomeDescriptor;
  counts: Record<CheckOutcomeStatus, number>;
  selected: number;
  groups?: number;
  reason?: string;
  rowDetailStatus?: CheckOutcomeStatus;
}

/**
 * Retains a bounded sample while counting every explicitly reported evaluation.
 * An absent record is never treated as a pass.
 */
export class CheckOutcomeCollector {
  private readonly limit: number;
  private readonly checks = new Map<string, MutableCheck>();
  private readonly retained: RetainedRowCheckOutcome[] = [];
  private readonly counts = emptyCounts();
  private dropped = 0;

  public constructor(descriptors: CheckOutcomeDescriptor[] = [], maxRetained?: number) {
    this.limit = retentionLimit(maxRetained);
    descriptors.forEach(descriptor => this.declare(descriptor));
  }

  public declare(descriptor: CheckOutcomeDescriptor): void {
    if (this.checks.has(descriptor.id)) return;
    this.checks.set(descriptor.id, { descriptor: { ...descriptor }, counts: emptyCounts(), selected: 0 });
  }

  public record(record: RetainedRowCheckOutcome): void {
    this.declare({ id: record.checkId, name: record.checkName, kind: record.kind });
    const check = this.checks.get(record.checkId)!;
    check.counts[record.status]++;
    if (record.status === "pass" || record.status === "fail") check.selected++;
    this.retain(record);
  }

  /** Retain known row detail for a separately counted aggregate without double-counting the check. */
  public retain(record: RetainedRowCheckOutcome): void {
    this.counts[record.status]++;
    if (this.retained.length < this.limit) this.retained.push(record);
    else {
      this.dropped++;
      const check = this.checks.get(record.checkId);
      if (check) {
        check.rowDetailStatus = "unknown";
        check.reason ??= "retention-limit";
      }
    }
  }

  /** Record trustworthy aggregate counts without manufacturing per-row passes. */
  public aggregate(id: string, values: { selected?: number; passed?: number; failed?: number; groups?: number }, reason = "aggregate-only"): void {
    this.declare({ id });
    const check = this.checks.get(id)!;
    const selected = values.selected ?? values.groups ?? 0;
    const passed = values.passed ?? 0;
    const failed = values.failed ?? 0;
    if (![selected, passed, failed, values.groups ?? 0].every(value => Number.isSafeInteger(value) && value >= 0) || passed + failed > selected) {
      check.counts.unknown++;
      check.reason = "invalid-aggregate-counts";
    } else if (failed > 0) check.counts.fail += failed;
    else if (selected === 0) check.counts["not-applicable"]++;
    else if (passed === selected) check.counts.pass += passed;
    else check.counts.unknown += Math.max(1, selected - passed - failed);
    check.selected += selected;
    if (values.groups !== undefined) check.groups = (check.groups ?? 0) + values.groups;
    check.rowDetailStatus = "unknown";
    check.reason ??= reason;
  }

  /** Explicitly explains checks skipped by fail-fast, missing columns, or another unavailable prerequisite. */
  public unavailable(id: string, status: "not-evaluated" | "unknown", reason: string): void {
    this.declare({ id });
    const check = this.checks.get(id)!;
    check.counts[status]++;
    check.reason = reason;
    check.rowDetailStatus = status;
  }

  public finish(options: { complete?: boolean; reason?: string } = {}): {
    checkOutcomes: CheckOutcome[];
    rowOutcomes: RetainedRowCheckOutcome[];
    outcomeRetention: CheckOutcomeRetention;
  } {
    const complete = options.complete !== false;
    const checkOutcomes = [...this.checks.values()].map(check => {
      const observed = statuses.reduce((total, status) => total + check.counts[status], 0);
      if (observed === 0) {
        const status: CheckOutcomeStatus = complete ? "unknown" : "not-evaluated";
        check.counts[status] = 1;
        check.reason = options.reason ?? (complete ? "no-explicit-outcome" : "evaluation-incomplete");
        check.rowDetailStatus = status;
      }
      return {
        ...check.descriptor,
        status: statusFor(check.counts),
        selected: check.selected,
        passed: check.counts.pass,
        failed: check.counts.fail,
        ...(check.groups === undefined ? {} : { groups: check.groups }),
        notApplicable: check.counts["not-applicable"],
        notEvaluated: check.counts["not-evaluated"],
        unknown: check.counts.unknown,
        ...(check.rowDetailStatus ? { rowDetailStatus: check.rowDetailStatus } : {}),
        ...(check.reason ? { reason: check.reason } : {})
      };
    });
    return {
      checkOutcomes,
      rowOutcomes: [...this.retained],
      outcomeRetention: {
        limit: this.limit,
        retained: this.retained.length,
        dropped: this.dropped,
        truncated: this.dropped > 0,
        evaluationComplete: complete,
        ...(!complete && options.reason ? { reason: options.reason } : {}),
        counts: { ...this.counts }
      }
    };
  }
}

export function outcomeContext(input: {
  identity?: Record<string, EvidenceValue>;
  group?: Record<string, EvidenceValue>;
  relatedRows?: number[];
  aggregate?: Record<string, EvidenceValue>;
}): RetainedRowCheckOutcome["context"] {
  const relatedRows = input.relatedRows ? [...new Set(input.relatedRows)].sort((a, b) => a - b) : undefined;
  return {
    ...(input.identity ? { identity: { ...input.identity } } : {}),
    ...(input.group ? { group: { ...input.group } } : {}),
    ...(relatedRows?.length ? { relatedRows } : {}),
    ...(input.aggregate ? { aggregate: { ...input.aggregate } } : {})
  };
}

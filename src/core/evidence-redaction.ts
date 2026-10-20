import type { EvidenceValue, FailureEvidenceRecord, ValidationIssue, ValidationResult } from "./model";
import type { IssueExportRun } from "../issue-export";

export type EvidenceRedactionProfile =
  | { mode: "aggregate-only"; maskWith?: string }
  | { mode: "detail"; include?: string[]; exclude?: string[]; mask?: string[]; maskWith?: string };

export interface RedactedIssueExportRuns {
  runs: IssueExportRun[];
  redactedFields: number;
}

const secretKey = /password|passwd|pwd|(?:access|refresh|id|api)?[_ .-]?token|api.?key|private.?key|client.?secret|credential|connection.?string/i;
const SAFE_AGGREGATE_COUNTS = new Set(["count", "rowcount", "rows", "groupcount", "groups", "matchcount", "matchedrows", "selectedcount", "selectedrows", "passedcount", "passedrows", "failedcount", "failedrows", "issuecount", "issues", "errorcount", "errors", "warningcount", "warnings", "totalcount"]);

function isAggregateCountKey(name: string): boolean {
  return SAFE_AGGREGATE_COUNTS.has(name.replace(/[_ .-]/g, "").toLowerCase());
}

/** Remove common inline credential forms even when a caller explicitly includes detail. */
export function redactSecrets(value: string, maskWith = "[redacted]"): string {
  return value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, maskWith)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s:]+:[^@\s]+@/gi, `$1${maskWith}@`)
    .replace(/((?:password|passwd|pwd|(?:access|refresh|id|api)?[_ .-]?token|api.?key|private.?key|client.?secret|credential|connection.?string)["']?\s*[=:]\s*["']?)(?:\{[^}]*\}|[^;"'\r\n]+)/gi, `$1${maskWith}`)
    .replace(/(authorization\s*[=:]\s*bearer\s+)[^;\s,\r\n]+/gi, `$1${maskWith}`)
    .replace(/([?&](?:token|access_token|api_key|key)=)[^&#\s]+/gi, `$1${encodeURIComponent(maskWith)}`);
}

function matcher(patterns: string[] | undefined): (name: string) => boolean {
  const regexes = (patterns ?? []).map((pattern) => new RegExp(`^${pattern.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i"));
  return (name) => regexes.some(regex => regex.test(name));
}

function redactor(profile: EvidenceRedactionProfile) {
  const include = matcher(profile.mode === "detail" ? profile.include : undefined);
  const hasInclude = profile.mode === "detail" && !!profile.include?.length;
  const exclude = matcher(profile.mode === "detail" ? profile.exclude : undefined);
  const mask = matcher(profile.mode === "detail" ? profile.mask : undefined);
  const hasRestrictions = profile.mode === "detail" && !!(profile.include?.length || profile.exclude?.length || profile.mask?.length);
  const maskWith = profile.maskWith ?? "[redacted]";
  let redactedFields = 0;

  const scalar = (name: string, value: EvidenceValue | undefined, aggregate = false): EvidenceValue | undefined => {
    if (value === undefined) return undefined;
    if (secretKey.test(name) || exclude(name)) { redactedFields++; return undefined; }
    const allowedAggregate = aggregate && isAggregateCountKey(name) && (typeof value === "number" || typeof value === "boolean");
    if (mask(name) || (profile.mode === "aggregate-only" && !allowedAggregate) || (hasInclude && !include(name)) || (hasRestrictions && name.startsWith("$") && !include(name))) {
      redactedFields++;
      return maskWith;
    }
    return typeof value === "string" ? redactSecrets(value, maskWith) : value;
  };

  const text = (name: string, value: string | undefined): string | undefined => scalar(name, value) as string | undefined;
  return { scalar, text, maskWith, count: () => redactedFields };
}

function redactRecord(record: FailureEvidenceRecord, scalar: ReturnType<typeof redactor>["scalar"], aggregate = false): FailureEvidenceRecord {
  const values = Object.fromEntries(Object.entries(record.values).flatMap(([key, value]) => {
    const redacted = scalar(key, value, aggregate);
    return redacted === undefined ? [] : [[key, redacted]];
  }));
  return {
    ...(record.label === undefined ? {} : { label: scalar("$evidence.label", record.label) as string | undefined }),
    ...(record.row === undefined ? {} : { row: record.row }),
    values
  };
}

/** Return a detached, redacted result. The caller's raw result is never mutated. */
export function redactValidationResult(result: ValidationResult, profile: EvidenceRedactionProfile = { mode: "aggregate-only" }): { result: ValidationResult; redactedFields: number } {
  const r = redactor(profile);
  const issues: ValidationIssue[] = result.issues.map(issue => {
    if (profile.mode === "aggregate-only") for (const sample of issue.evidence?.samples ?? []) {
      if (sample.primary) r.scalar("$evidence.primary", "removed");
      sample.related?.forEach(() => r.scalar("$evidence.related", "removed"));
    }
    const evidence = issue.evidence ? {
      samples: profile.mode === "aggregate-only" ? [] : issue.evidence.samples.map(sample => ({
        ...(sample.primary ? { primary: redactRecord(sample.primary, r.scalar) } : {}),
        ...(sample.related ? { related: sample.related.map(record => redactRecord(record, r.scalar)) } : {})
      })),
      ...(issue.evidence.aggregate ? { aggregate: Object.fromEntries(Object.entries(issue.evidence.aggregate).flatMap(([key, value]) => {
        const redacted = r.scalar(key, value, true);
        return redacted === undefined ? [] : [[key, redacted]];
      })) } : {}),
      ...(issue.evidence.totalSamples === undefined ? {} : { totalSamples: issue.evidence.totalSamples }),
      ...(issue.evidence.limited === undefined ? {} : { limited: issue.evidence.limited || profile.mode === "aggregate-only" })
    } : undefined;
    const group = issue.group && profile.mode === "detail" ? Object.fromEntries(Object.entries(issue.group).flatMap(([key, value]) => {
      const redacted = r.scalar(key, value);
      return redacted === undefined ? [] : [[key, String(redacted)]];
    })) : undefined;
    return {
      level: issue.level,
      code: issue.code,
      message: r.text("$message", issue.message) ?? r.maskWith,
      ...(issue.title === undefined ? {} : { title: r.text("$title", issue.title) }),
      ...(issue.diagnostic === undefined ? {} : { diagnostic: r.text("$diagnostic", issue.diagnostic) }),
      ...(issue.column === undefined ? {} : { column: issue.column }),
      ...(issue.row === undefined ? {} : { row: issue.row }),
      ...(profile.mode === "detail" && issue.relatedRows ? { relatedRows: [...issue.relatedRows] } : {}),
      ...(issue.testId === undefined ? {} : { testId: issue.testId }),
      ...(issue.actual === undefined ? {} : { actual: r.scalar("$actual", issue.actual) as string | number | undefined }),
      ...(issue.expected === undefined ? {} : { expected: r.scalar("$expected", issue.expected) as string | number | undefined }),
      ...(issue.severity === undefined ? {} : { severity: issue.severity }),
      group,
      evidence
    };
  });
  if (profile.mode === "aggregate-only") result.examples?.forEach(() => r.scalar("$example", "removed"));
  const examples = profile.mode === "aggregate-only" ? undefined : result.examples?.map(example => ({
    id: r.text("$example.id", example.id) ?? r.maskWith,
    outcome: example.outcome,
    row: example.row,
    values: Object.fromEntries(Object.entries(example.values).flatMap(([key, value]) => {
      const redacted = r.scalar(key, value);
      return redacted === undefined ? [] : [[key, String(redacted)]];
    }))
  }));
  const ruleOutcomes = result.ruleOutcomes?.map(outcome => ({ id: outcome.id, ...(outcome.name === undefined ? {} : { name: r.text("$rule.name", outcome.name) }), selected: outcome.selected, passed: outcome.passed, failed: outcome.failed }));
  const groupOutcomes = result.groupOutcomes?.map(outcome => ({ id: outcome.id, ...(outcome.name === undefined ? {} : { name: r.text("$group.name", outcome.name) }), groups: outcome.groups, passed: outcome.passed, failed: outcome.failed }));
  const checkOutcomes = result.checkOutcomes?.map(outcome => ({
    id: outcome.id,
    ...(outcome.name === undefined ? {} : { name: r.text("$check.name", outcome.name) }),
    ...(outcome.kind === undefined ? {} : { kind: outcome.kind }),
    ...(outcome.severity === undefined ? {} : { severity: outcome.severity }),
    ...(outcome.importance === undefined ? {} : { importance: outcome.importance }),
    status: outcome.status,
    ...(outcome.selected === undefined ? {} : { selected: outcome.selected }),
    ...(outcome.passed === undefined ? {} : { passed: outcome.passed }),
    ...(outcome.failed === undefined ? {} : { failed: outcome.failed }),
    ...(outcome.groups === undefined ? {} : { groups: outcome.groups }),
    ...(outcome.notApplicable === undefined ? {} : { notApplicable: outcome.notApplicable }),
    ...(outcome.notEvaluated === undefined ? {} : { notEvaluated: outcome.notEvaluated }),
    ...(outcome.unknown === undefined ? {} : { unknown: outcome.unknown }),
    ...(outcome.rowDetailStatus === undefined ? {} : { rowDetailStatus: outcome.rowDetailStatus }),
    ...(outcome.reason === undefined ? {} : { reason: r.text("$check.reason", outcome.reason) })
  }));
  if (profile.mode === "aggregate-only") result.rowOutcomes?.forEach(() => r.scalar("$rowOutcome", "removed"));
  const rowOutcomes = profile.mode === "aggregate-only" ? undefined : result.rowOutcomes?.map(outcome => ({
    checkId: outcome.checkId,
    ...(outcome.checkName === undefined ? {} : { checkName: r.text("$rowOutcome.checkName", outcome.checkName) }),
    ...(outcome.kind === undefined ? {} : { kind: outcome.kind }),
    status: outcome.status,
    ...(outcome.row === undefined ? {} : { row: outcome.row }),
    ...(outcome.context ? { context: {
      ...(outcome.context.identity ? { identity: Object.fromEntries(Object.entries(outcome.context.identity).flatMap(([key, value]) => {
        const redacted = r.scalar(key, value);
        return redacted === undefined ? [] : [[key, redacted]];
      })) } : {}),
      ...(outcome.context.group ? { group: Object.fromEntries(Object.entries(outcome.context.group).flatMap(([key, value]) => {
        const redacted = r.scalar(key, value);
        return redacted === undefined ? [] : [[key, redacted]];
      })) } : {}),
      ...(outcome.context.relatedRows ? { relatedRows: [...outcome.context.relatedRows] } : {}),
      ...(outcome.context.aggregate ? { aggregate: Object.fromEntries(Object.entries(outcome.context.aggregate).flatMap(([key, value]) => {
        const redacted = r.scalar(key, value, true);
        return redacted === undefined ? [] : [[key, redacted]];
      })) } : {})
    } } : {})
  }));
  const outcomeRetention = result.outcomeRetention ? {
    limit: result.outcomeRetention.limit, retained: result.outcomeRetention.retained, dropped: result.outcomeRetention.dropped,
    truncated: result.outcomeRetention.truncated,
    ...(result.outcomeRetention.evaluationComplete === undefined ? {} : { evaluationComplete: result.outcomeRetention.evaluationComplete }),
    ...(result.outcomeRetention.reason === undefined ? {} : { reason: r.text("$outcomeRetention.reason", result.outcomeRetention.reason) }),
    counts: { ...result.outcomeRetention.counts }
  } : undefined;
  return { result: {
    ...(result.preview ? { preview: { scope: result.preview.scope, ...(result.preview.rowLimit === undefined ? {} : { rowLimit: result.preview.rowLimit }), exampleLimit: result.preview.exampleLimit } } : {}),
    examples,
    ...(result.evaluatedAt === undefined ? {} : { evaluatedAt: result.evaluatedAt }),
    ruleOutcomes,
    groupOutcomes,
    checkOutcomes,
    rowOutcomes,
    outcomeRetention,
    valid: result.valid,
    rowCount: result.rowCount,
    columnCount: result.columnCount,
    testCount: result.testCount,
    issueCount: result.issueCount,
    errorCount: result.errorCount,
    warningCount: result.warningCount,
    truncated: result.truncated,
    issues
  }, redactedFields: r.count() };
}

export function redactIssueExportRuns(runs: IssueExportRun[], profile: EvidenceRedactionProfile = { mode: "aggregate-only" }): RedactedIssueExportRuns {
  let redactedFields = 0;
  const redacted = runs.map(run => {
    const result = run.result ? redactValidationResult(run.result, profile) : undefined;
    redactedFields += result?.redactedFields ?? 0;
    const errorExcluded = profile.mode === "detail" && matcher(profile.exclude)("$error");
    const errorIncluded = profile.mode === "detail" && matcher(profile.include)("$error");
    const restricted = profile.mode === "detail" && !!(profile.include?.length || profile.exclude?.length || profile.mask?.length);
    const errorMasked = profile.mode === "aggregate-only" || profile.mode === "detail" && (matcher(profile.mask)("$error") || restricted && !errorIncluded);
    const error = run.error === undefined || errorExcluded ? undefined : errorMasked
      ? (redactedFields++, profile.maskWith ?? "[redacted]")
      : redactSecrets(run.error, profile.maskWith);
    return {
      target: run.target,
      ...(run.runId === undefined ? {} : { runId: run.runId }),
      ...(run.workId === undefined ? {} : { workId: run.workId }),
      ...(run.evaluatedAt === undefined ? {} : { evaluatedAt: run.evaluatedAt }),
      ...(run.scope === undefined ? {} : { scope: run.scope }),
      ...(run.status === undefined && run.error === undefined ? {} : { status: run.status ?? "ERROR" }),
      ...(result ? { result: result.result } : { result: undefined }),
      error
    };
  });
  return { runs: redacted, redactedFields };
}

import type { ValidationResult } from "./model";
import type { IssueExportRun } from "../issue-export";
import { parseValidationRunExport } from "../issue-export";
import { redactIssueExportRuns, redactSecrets, type EvidenceRedactionProfile } from "./evidence-redaction";

export const VALIDATION_REVIEW_PACKAGE_SCHEMA = "incursa.validation-review-package/v1" as const;
export type ReviewTargetStatus = "PASS" | "FAIL" | "ERROR" | "CANCELED" | "SKIPPED" | "UNKNOWN" | "SAMPLED";

export interface ReviewPackageTarget {
  target: string;
  definitionFingerprints: string[];
  coverage: { pass: number; fail: number; notApplicable: number; notEvaluated: number; unknown: number };
  runId?: string;
  workId?: string;
  evaluatedAt?: string;
  scope?: string;
  status: ReviewTargetStatus;
  verdict: "pass" | "fail" | "not-assessed";
  completeness: {
    evaluation: "complete" | "sampled" | "not-run" | "unknown";
    issueDetails: "complete" | "limited" | "not-applicable";
    totalIssues: number;
    retainedIssues: number;
  };
  result?: ValidationResult;
  error?: string;
}

export interface ValidationReviewPackage {
  schema: typeof VALIDATION_REVIEW_PACKAGE_SCHEMA;
  identity: { packageId: string; createdAt: string };
  tool: { name: string; version: string };
  source: { reference: string; fingerprint: string };
  provenance: {
    definitions: Array<{ source: string; fingerprint: string; text?: string; includedTextFingerprint?: string }>;
    supplied?: Record<string, string>;
  };
  evidence: { mode: "aggregate-only" | "detail"; detailsIncluded: boolean; redactedFields: number };
  summary: {
    targets: number;
    statuses: Record<ReviewTargetStatus, number>;
    rowsScanned: number;
    issues: number;
    errors: number;
    warnings: number;
    retainedIssueDetails: number;
    issueDetailsComplete: boolean;
    evaluationComplete: boolean;
  };
  targets: ReviewPackageTarget[];
}

export interface CreateValidationReviewPackageInput {
  source: string;
  runs: IssueExportRun[];
  toolVersion?: string;
  createdAt?: string;
  packageId?: string;
  definitions?: Array<{ source: string; text: string }>;
  /** Definition source references keyed by runId, workId, or target (checked in that order). */
  definitionBindings?: Record<string, string[]>;
  producer?: { name?: string; version?: string };
  provenance?: Record<string, string>;
}

export interface CreateValidationReviewPackageOptions {
  evidence?: EvidenceRedactionProfile;
  includeDefinitions?: boolean;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

function rotateRight(value: number, count: number): number { return value >>> count | value << 32 - count; }

/** Synchronous browser-safe SHA-256. The digest is a content identity, not an authenticity signature. */
export function reviewFingerprint(value: unknown): string {
  const input = new TextEncoder().encode(stable(value));
  const bitLength = input.length * 8;
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(input);
  bytes[input.length] = 0x80;
  const view = new DataView(bytes.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  const hash = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index++) words[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 64; index++) {
      const a = words[index - 15], b = words[index - 2];
      const s0 = rotateRight(a, 7) ^ rotateRight(a, 18) ^ a >>> 3;
      const s1 = rotateRight(b, 17) ^ rotateRight(b, 19) ^ b >>> 10;
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index++) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = e & f ^ ~e & g;
      const temp1 = (h + s1 + choice + SHA256_K[index] + words[index]) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = a & b ^ a & c ^ b & c;
      const temp2 = (s0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    for (const [index, word] of [a, b, c, d, e, f, g, h].entries()) hash[index] = (hash[index] + word) >>> 0;
  }
  return `sha256-${Array.from(hash, word => word.toString(16).padStart(8, "0")).join("")}`;
}

function status(run: IssueExportRun): ReviewTargetStatus {
  const explicit = (run.status ?? "").trim().toUpperCase().replaceAll("-", "_");
  if (explicit === "CANCELLED" || explicit === "CANCELED") return "CANCELED";
  if (explicit === "SKIP" || explicit === "SKIPPED") return "SKIPPED";
  if (["UNKNOWN", "QUEUED", "PENDING", "RUNNING", "NOT_RUN", "NOT-RUN"].includes(explicit)) return "UNKNOWN";
  if (run.error || explicit === "ERROR" || explicit === "FAILED_TO_RUN") return "ERROR";
  if (run.result?.preview?.scope === "sample" || explicit === "SAMPLED" || explicit === "SAMPLE") return "SAMPLED";
  if (!run.result) return "UNKNOWN";
  if (!run.result.valid) return "FAIL";
  if (explicit === "FAIL" || explicit === "FAILED") return "UNKNOWN";
  if (run.result.outcomeRetention?.evaluationComplete === false) return "UNKNOWN";
  if (run.result.checkOutcomes?.some(outcome => outcome.status === "unknown" || outcome.status === "not-evaluated")) return "UNKNOWN";
  if (run.result.checkOutcomes?.some(outcome => outcome.status === "fail" && outcome.severity !== "warning")) return "FAIL";
  if (explicit && explicit !== "PASS" && explicit !== "PASSED") return "UNKNOWN";
  return "PASS";
}

function packageTarget(run: IssueExportRun, definitionFingerprints: string[]): ReviewPackageTarget {
  const targetStatus = status(run);
  const totalIssues = run.result?.issueCount ?? 0;
  const retainedIssues = run.result?.issues.length ?? 0;
  const coverage = { pass: 0, fail: 0, notApplicable: 0, notEvaluated: 0, unknown: 0 };
  for (const outcome of run.result?.checkOutcomes ?? []) {
    if (outcome.status === "not-applicable") coverage.notApplicable++;
    else if (outcome.status === "not-evaluated") coverage.notEvaluated++;
    else coverage[outcome.status]++;
  }
  const evaluation = targetStatus === "SAMPLED" ? "sampled" : ["ERROR", "CANCELED", "SKIPPED"].includes(targetStatus) ? "not-run" : targetStatus === "UNKNOWN" || coverage.unknown > 0 || coverage.notEvaluated > 0 || run.result?.outcomeRetention?.evaluationComplete === false ? "unknown" : run.result ? "complete" : "unknown";
  return {
    target: redactSecrets(run.target),
    definitionFingerprints: [...definitionFingerprints],
    coverage,
    ...(run.runId ? { runId: redactSecrets(run.runId) } : {}),
    ...(run.workId ? { workId: redactSecrets(run.workId) } : {}),
    ...(run.evaluatedAt ? { evaluatedAt: run.evaluatedAt } : {}),
    ...(run.scope ? { scope: redactSecrets(run.scope) } : {}),
    status: targetStatus,
    verdict: targetStatus === "PASS" ? "pass" : targetStatus === "FAIL" ? "fail" : "not-assessed",
    completeness: {
      evaluation,
      issueDetails: !run.result ? "not-applicable" : run.result.truncated || retainedIssues !== totalIssues ? "limited" : "complete",
      totalIssues,
      retainedIssues
    },
    ...(run.result ? { result: run.result } : {}),
    ...(run.error ? { error: run.error } : {})
  };
}

function isoTime(value: string | undefined): string {
  const date = value === undefined ? new Date() : new Date(value);
  if (!Number.isFinite(date.valueOf())) throw new Error("Review package createdAt must be an ISO date-time.");
  return date.toISOString();
}

function safeRecord(record: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!record) return undefined;
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, /password|pwd|token|secret|connection.?string|api.?key/i.test(key) ? "[redacted]" : redactSecrets(value)]));
}

function assertKnownKeys(record: Record<string, unknown>, allowed: readonly string[], location: string): void {
  const unexpected = Object.keys(record).find(key => !allowed.includes(key));
  if (unexpected) throw new Error(`${location} contains unsupported field ${unexpected}.`);
}

export function createValidationReviewPackage(input: CreateValidationReviewPackageInput, options: CreateValidationReviewPackageOptions = {}): ValidationReviewPackage {
  if (!input.source?.trim()) throw new Error("A review package source is required.");
  if (!Array.isArray(input.runs) || !input.runs.length) throw new Error("A review package requires at least one target run.");
  const profile = options.evidence ?? { mode: "aggregate-only" };
  const definitionInputs = [...(input.definitions ?? [])].sort((a, b) => a.source < b.source ? -1 : a.source > b.source ? 1 : a.text < b.text ? -1 : a.text > b.text ? 1 : 0);
  const definitions = definitionInputs.map(definition => {
    const safeText = redactSecrets(definition.text);
    return { source: redactSecrets(definition.source), fingerprint: reviewFingerprint(definition.text), ...(options.includeDefinitions ? { text: safeText, includedTextFingerprint: reviewFingerprint(safeText) } : {}) };
  });
  const redacted = redactIssueExportRuns(input.runs, profile);
  const fingerprintsFor = (run: IssueExportRun): string[] => {
    const keys = [run.runId, run.workId, run.target].filter((value): value is string => !!value);
    const sources = keys.map(key => input.definitionBindings?.[key]).find((value): value is string[] => !!value);
    if (!sources) return definitions.length === 1 ? [definitions[0].fingerprint] : [];
    return sources.map(source => {
      const match = definitions.find(definition => definition.source === redactSecrets(source));
      if (!match) throw new Error(`Definition binding for ${run.target} references unknown source ${source}.`);
      return match.fingerprint;
    }).filter((fingerprint, index, values) => values.indexOf(fingerprint) === index).sort();
  };
  const targets = redacted.runs.map(run => packageTarget(run, fingerprintsFor(run)));
  const createdAt = isoTime(input.createdAt);
  const sourceReference = redactSecrets(input.source);
  const sourceFingerprint = reviewFingerprint({ source: input.source, definitions: definitionInputs.map(item => ({ source: item.source, text: item.text })) });
  const statuses = Object.fromEntries((["PASS", "FAIL", "ERROR", "CANCELED", "SKIPPED", "UNKNOWN", "SAMPLED"] as ReviewTargetStatus[]).map(value => [value, targets.filter(target => target.status === value).length])) as Record<ReviewTargetStatus, number>;
  const issues = targets.reduce((sum, target) => sum + target.completeness.totalIssues, 0);
  const retainedIssueDetails = targets.reduce((sum, target) => sum + target.completeness.retainedIssues, 0);
  return {
    schema: VALIDATION_REVIEW_PACKAGE_SCHEMA,
    identity: { packageId: redactSecrets(input.packageId ?? `review-${reviewFingerprint({ sourceFingerprint, createdAt, targets: targets.map(target => [target.target, target.status]) }).slice(7, 23)}`), createdAt },
    tool: { name: redactSecrets(input.producer?.name ?? "Validation Workbench"), version: redactSecrets(input.producer?.version ?? input.toolVersion ?? "unknown") },
    source: { reference: sourceReference, fingerprint: sourceFingerprint },
    provenance: { definitions, ...(input.provenance ? { supplied: safeRecord(input.provenance) } : {}) },
    evidence: { mode: profile.mode, detailsIncluded: profile.mode === "detail", redactedFields: redacted.redactedFields },
    summary: {
      targets: targets.length, statuses,
      rowsScanned: targets.reduce((sum, target) => sum + (target.result?.rowCount ?? 0), 0),
      issues,
      errors: targets.reduce((sum, target) => sum + (target.result?.errorCount ?? 0), 0),
      warnings: targets.reduce((sum, target) => sum + (target.result?.warningCount ?? 0), 0),
      retainedIssueDetails,
      issueDetailsComplete: targets.every(target => target.completeness.issueDetails !== "limited"),
      evaluationComplete: targets.every(target => target.completeness.evaluation === "complete")
    },
    targets
  };
}

function assertPackage(value: unknown): asserts value is ValidationReviewPackage {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The selected file is not a validation review package.");
  const pkg = value as Record<string, unknown>;
  if (pkg.schema !== VALIDATION_REVIEW_PACKAGE_SCHEMA) throw new Error(`Unsupported review package schema: ${String(pkg.schema)}.`);
  if (!pkg.identity || typeof pkg.identity !== "object" || typeof (pkg.identity as Record<string, unknown>).packageId !== "string" || !(pkg.identity as Record<string, unknown>).packageId || typeof (pkg.identity as Record<string, unknown>).createdAt !== "string" || !Number.isFinite(new Date(String((pkg.identity as Record<string, unknown>).createdAt)).valueOf())) throw new Error("Review package identity is invalid.");
  if (!pkg.tool || typeof pkg.tool !== "object" || typeof (pkg.tool as Record<string, unknown>).name !== "string" || typeof (pkg.tool as Record<string, unknown>).version !== "string") throw new Error("Review package tool identity is invalid.");
  if (!pkg.source || typeof pkg.source !== "object" || typeof (pkg.source as Record<string, unknown>).reference !== "string" || !/^sha256-[0-9a-f]{64}$/.test(String((pkg.source as Record<string, unknown>).fingerprint))) throw new Error("Review package source is invalid.");
  if (!pkg.provenance || typeof pkg.provenance !== "object" || !Array.isArray((pkg.provenance as Record<string, unknown>).definitions)) throw new Error("Review package provenance is invalid.");
  for (const definition of (pkg.provenance as { definitions: unknown[] }).definitions) {
    if (!definition || typeof definition !== "object" || typeof (definition as Record<string, unknown>).source !== "string" || !/^sha256-[0-9a-f]{64}$/.test(String((definition as Record<string, unknown>).fingerprint)) || ((definition as Record<string, unknown>).text !== undefined && typeof (definition as Record<string, unknown>).text !== "string")) throw new Error("Review package definition provenance is invalid.");
    if ((definition as Record<string, unknown>).text !== undefined && (!/^sha256-[0-9a-f]{64}$/.test(String((definition as Record<string, unknown>).includedTextFingerprint)) || reviewFingerprint((definition as Record<string, unknown>).text) !== (definition as Record<string, unknown>).includedTextFingerprint)) throw new Error("Review package included definition text fingerprint does not match its content.");
  }
  if (!pkg.evidence || typeof pkg.evidence !== "object" || !["aggregate-only", "detail"].includes(String((pkg.evidence as Record<string, unknown>).mode)) || typeof (pkg.evidence as Record<string, unknown>).detailsIncluded !== "boolean" || !Number.isSafeInteger((pkg.evidence as Record<string, unknown>).redactedFields) || Number((pkg.evidence as Record<string, unknown>).redactedFields) < 0) throw new Error("Review package evidence policy is invalid.");
  if (((pkg.evidence as Record<string, unknown>).mode === "detail") !== ((pkg.evidence as Record<string, unknown>).detailsIncluded === true)) throw new Error("Review package evidence policy is contradictory.");
  if (!Array.isArray(pkg.targets) || !pkg.targets.length) throw new Error("Review package contains no target runs.");
  for (const [index, item] of pkg.targets.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`Review package target ${index + 1} is invalid.`);
    const target = item as Record<string, unknown>;
    if (!Array.isArray(target.definitionFingerprints) || target.definitionFingerprints.some(fingerprint => typeof fingerprint !== "string" || !(pkg.provenance as { definitions: Array<{ fingerprint: string }> }).definitions.some(definition => definition.fingerprint === fingerprint))) throw new Error(`Review package target ${index + 1} definition provenance is invalid.`);
    const coverage = target.coverage as Record<string, unknown> | undefined;
    if (!coverage || ["pass", "fail", "notApplicable", "notEvaluated", "unknown"].some(key => !Number.isSafeInteger(coverage[key]) || Number(coverage[key]) < 0)) throw new Error(`Review package target ${index + 1} coverage is invalid.`);
    if (typeof target.target !== "string" || !["PASS", "FAIL", "ERROR", "CANCELED", "SKIPPED", "UNKNOWN", "SAMPLED"].includes(String(target.status)) || !["pass", "fail", "not-assessed"].includes(String(target.verdict))) throw new Error(`Review package target ${index + 1} has an invalid status.`);
    if ((target.status === "PASS") !== (target.verdict === "pass") || (target.status === "FAIL") !== (target.verdict === "fail")) throw new Error(`Review package target ${index + 1} has a contradictory verdict.`);
    const completeness = target.completeness as Record<string, unknown> | undefined;
    if (!completeness || typeof completeness !== "object" || !["complete", "sampled", "not-run", "unknown"].includes(String(completeness.evaluation)) || !["complete", "limited", "not-applicable"].includes(String(completeness.issueDetails)) || !Number.isSafeInteger(completeness.totalIssues) || Number(completeness.totalIssues) < 0 || !Number.isSafeInteger(completeness.retainedIssues) || Number(completeness.retainedIssues) < 0 || Number(completeness.retainedIssues) > Number(completeness.totalIssues)) throw new Error(`Review package target ${index + 1} completeness is invalid.`);
    const result = target.result as Record<string, unknown> | undefined;
    if (result) {
      assertKnownKeys(result, ["preview", "examples", "evaluatedAt", "ruleOutcomes", "groupOutcomes", "checkOutcomes", "rowOutcomes", "outcomeRetention", "valid", "rowCount", "columnCount", "testCount", "issueCount", "errorCount", "warningCount", "truncated", "issues"], `Review package target ${index + 1} result`);
      for (const [issueIndex, item] of (result.issues as unknown[] ?? []).entries()) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const issue = item as Record<string, unknown>;
        assertKnownKeys(issue, ["level", "code", "message", "title", "diagnostic", "column", "row", "relatedRows", "testId", "group", "actual", "expected", "severity", "evidence"], `Review package target ${index + 1} issue ${issueIndex + 1}`);
        if (issue.evidence && typeof issue.evidence === "object" && !Array.isArray(issue.evidence)) {
          const evidence = issue.evidence as Record<string, unknown>;
          assertKnownKeys(evidence, ["samples", "aggregate", "totalSamples", "limited"], `Review package target ${index + 1} issue ${issueIndex + 1} evidence`);
          for (const sample of evidence.samples as unknown[] ?? []) if (sample && typeof sample === "object" && !Array.isArray(sample)) {
            assertKnownKeys(sample as Record<string, unknown>, ["primary", "related"], `Review package target ${index + 1} issue ${issueIndex + 1} evidence sample`);
            const records = [(sample as Record<string, unknown>).primary, ...(((sample as Record<string, unknown>).related as unknown[] | undefined) ?? [])];
            for (const record of records) if (record && typeof record === "object" && !Array.isArray(record)) assertKnownKeys(record as Record<string, unknown>, ["label", "row", "values"], `Review package target ${index + 1} issue ${issueIndex + 1} evidence record`);
          }
        }
      }
      const retention = result.outcomeRetention;
      if (retention !== undefined) {
        if (!retention || typeof retention !== "object" || Array.isArray(retention)) throw new Error(`Review package target ${index + 1} outcome retention is invalid.`);
        assertKnownKeys(retention as Record<string, unknown>, ["limit", "retained", "dropped", "truncated", "evaluationComplete", "reason", "counts"], `Review package target ${index + 1} outcome retention`);
        const record = retention as Record<string, unknown>;
        if (record.evaluationComplete !== undefined && typeof record.evaluationComplete !== "boolean" || record.reason !== undefined && typeof record.reason !== "string") throw new Error(`Review package target ${index + 1} outcome retention is invalid.`);
      }
    }
    const blockingFailedCheck = (result?.checkOutcomes as Array<Record<string, unknown>> | undefined)?.some(outcome => outcome.status === "fail" && outcome.severity !== "warning") ?? false;
    if (target.status === "PASS" && (!result || result.valid !== true || (result.preview as Record<string, unknown> | undefined)?.scope === "sample" || completeness.evaluation !== "complete" || Number(coverage.unknown) > 0 || Number(coverage.notEvaluated) > 0 || blockingFailedCheck)) throw new Error(`Review package target ${index + 1} cannot be a pass because its evaluation is incomplete or has blocking failures.`);
    if (target.status === "FAIL" && (!result || result.valid !== false && !blockingFailedCheck)) throw new Error(`Review package target ${index + 1} cannot be a failure without a failed result.`);
    const expectedCoverage = { pass: 0, fail: 0, notApplicable: 0, notEvaluated: 0, unknown: 0 };
    for (const outcome of (result?.checkOutcomes as Array<Record<string, unknown>> | undefined) ?? []) {
      const key = outcome.status === "not-applicable" ? "notApplicable" : outcome.status === "not-evaluated" ? "notEvaluated" : String(outcome.status);
      if (key in expectedCoverage) expectedCoverage[key as keyof typeof expectedCoverage]++;
    }
    for (const [key, count] of Object.entries(expectedCoverage)) if (coverage[key] !== count) throw new Error(`Review package target ${index + 1} coverage is inconsistent.`);
    const expectedEvaluation = target.status === "SAMPLED" ? "sampled" : ["ERROR", "CANCELED", "SKIPPED"].includes(String(target.status)) ? "not-run" : target.status === "UNKNOWN" || Number(coverage.unknown) > 0 || Number(coverage.notEvaluated) > 0 || (result?.outcomeRetention as Record<string, unknown> | undefined)?.evaluationComplete === false ? "unknown" : "complete";
    if (completeness.evaluation !== expectedEvaluation) throw new Error(`Review package target ${index + 1} evaluation completeness contradicts its status.`);
    const expectedTotal = result ? Number(result.issueCount) : 0;
    const expectedRetained = result && Array.isArray(result.issues) ? result.issues.length : 0;
    const expectedDetail = !result ? "not-applicable" : result.truncated === true || expectedTotal !== expectedRetained ? "limited" : "complete";
    if (completeness.totalIssues !== expectedTotal || completeness.retainedIssues !== expectedRetained || completeness.issueDetails !== expectedDetail) throw new Error(`Review package target ${index + 1} issue completeness is inconsistent.`);
  }
  if (!pkg.summary || typeof pkg.summary !== "object") throw new Error("Review package summary is invalid.");
  const summary = pkg.summary as Record<string, unknown>;
  for (const key of ["targets", "rowsScanned", "issues", "errors", "warnings", "retainedIssueDetails"] as const) if (!Number.isSafeInteger(summary[key]) || Number(summary[key]) < 0) throw new Error(`Review package summary ${key} is invalid.`);
  if (summary.targets !== pkg.targets.length || typeof summary.issueDetailsComplete !== "boolean" || typeof summary.evaluationComplete !== "boolean" || !summary.statuses || typeof summary.statuses !== "object") throw new Error("Review package summary is inconsistent.");
  const statuses = summary.statuses as Record<string, unknown>;
  for (const status of ["PASS", "FAIL", "ERROR", "CANCELED", "SKIPPED", "UNKNOWN", "SAMPLED"] as ReviewTargetStatus[]) if (!Number.isSafeInteger(statuses[status]) || Number(statuses[status]) !== pkg.targets.filter(item => (item as Record<string, unknown>).status === status).length) throw new Error(`Review package summary status ${status} is inconsistent.`);
  const targets = pkg.targets as Array<Record<string, unknown>>;
  const sumResult = (field: string): number => targets.reduce((total, target) => total + Number((target.result as Record<string, unknown> | undefined)?.[field] ?? 0), 0);
  const completeness = targets.map(target => target.completeness as Record<string, unknown>);
  const expectedSummary = {
    rowsScanned: sumResult("rowCount"), issues: sumResult("issueCount"), errors: sumResult("errorCount"), warnings: sumResult("warningCount"),
    retainedIssueDetails: completeness.reduce((total, item) => total + Number(item.retainedIssues), 0),
    issueDetailsComplete: completeness.every(item => item.issueDetails !== "limited"),
    evaluationComplete: completeness.every(item => item.evaluation === "complete")
  };
  for (const [key, expected] of Object.entries(expectedSummary)) if (summary[key] !== expected) throw new Error(`Review package summary ${key} is inconsistent.`);
  parseValidationRunExport(JSON.stringify({ schema: "incursa.csv-contract-results/v1", contract: (pkg.source as Record<string, unknown>).reference, runs: (pkg.targets as Array<Record<string, unknown>>).map(target => ({ target: target.target, result: target.result, error: target.error })) }));
}

/** Parse v1 packages. Legacy Workbench result exports are safely upgraded using aggregate-only evidence. */
export function parseValidationReviewPackage(text: string): ValidationReviewPackage {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("The selected file is not valid JSON."); }
  if (value && typeof value === "object" && (value as Record<string, unknown>).schema === "incursa.csv-contract-results/v1") {
    const legacy = parseValidationRunExport(text);
    return createValidationReviewPackage({ source: legacy.contract, runs: legacy.runs, createdAt: legacy.exportedAt, provenance: { upgradedFrom: legacy.schema } });
  }
  assertPackage(value);
  return value;
}

export function validationReviewPackageJson(input: CreateValidationReviewPackageInput, options?: CreateValidationReviewPackageOptions): string {
  return `${JSON.stringify(createValidationReviewPackage(input, options), null, 2)}\n`;
}

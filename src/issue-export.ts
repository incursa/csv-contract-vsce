import type { ValidationResult } from "./core/model";
import { rowsToCsv } from "./comparison/evidence";
import { manifestFromRuns, type PackageManifest } from "./core/package-manifest";

export interface IssueExportRun {
  runId?: string;
  workId?: string;
  evaluatedAt?: string;
  scope?: string;
  target: string;
  spec?: string;
  result?: ValidationResult;
  status?: string;
  error?: string;
}

export interface ValidationRunExport {
  schema: "incursa.csv-contract-results/v1";
  manifest: PackageManifest;
  contract: string;
  exportedAt?: string;
  totals: {
    targets: number;
    passed: number;
    rowsScanned: number;
    errors: number;
    warnings: number;
    issues: number;
    retainedIssueDetails: number;
    issueDetailsComplete: boolean;
  };
  runs: IssueExportRun[];
}

export function createValidationRunExport(contract: string, runs: IssueExportRun[], options: { definition?: unknown; kind?: "contract" | "suite"; identity?: string } = {}): ValidationRunExport {
  const orderedRuns = [...runs].sort((left, right) => left.target.localeCompare(right.target) || (left.spec ?? "").localeCompare(right.spec ?? "") || (left.runId ?? "").localeCompare(right.runId ?? ""));
  const issues = orderedRuns.reduce((total, run) => total + (run.result?.issueCount ?? 0), 0);
  const retainedIssueDetails = orderedRuns.reduce((total, run) => total + (run.result?.issues.length ?? 0), 0);
  return {
    schema: "incursa.csv-contract-results/v1",
    manifest: manifestFromRuns(options.identity ?? contract, orderedRuns, options.definition, options.kind),
    contract,
    exportedAt: new Date().toISOString(),
    totals: {
      targets: orderedRuns.length,
      passed: orderedRuns.filter((run) => (run.result?.valid && run.result.preview?.scope !== "sample" && (!run.status || run.status === "PASS"))).length,
      rowsScanned: orderedRuns.reduce((total, run) => total + (run.result?.rowCount ?? 0), 0),
      errors: orderedRuns.reduce((total, run) => total + (run.result?.errorCount ?? 0), 0),
      warnings: orderedRuns.reduce((total, run) => total + (run.result?.warningCount ?? 0), 0),
      issues,
      retainedIssueDetails,
      issueDetailsComplete: issues === retainedIssueDetails
    },
    runs: orderedRuns
  };
}

function requiredInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`Results JSON has an invalid ${name}.`);
  return Number(value);
}

function validateEvidenceRecord(value: unknown, location: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${location} is not a record.`);
  const record = value as Record<string, unknown>;
  if (record.label !== undefined && typeof record.label !== "string" || record.row !== undefined && (!Number.isSafeInteger(record.row) || Number(record.row) < 0) ||
      !record.values || typeof record.values !== "object" || Array.isArray(record.values) || Object.values(record.values as Record<string, unknown>).some(item => item !== null && !["string", "number", "boolean"].includes(typeof item))) {
    throw new Error(`${location} has invalid row values.`);
  }
}

function validateEvidence(value: unknown, location: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${location} is invalid.`);
  const evidence = value as Record<string, unknown>;
  if (!Array.isArray(evidence.samples) || evidence.limited !== undefined && typeof evidence.limited !== "boolean" ||
      evidence.totalSamples !== undefined && (!Number.isSafeInteger(evidence.totalSamples) || Number(evidence.totalSamples) < 0)) throw new Error(`${location} is invalid.`);
  evidence.samples.forEach((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${location} sample ${index + 1} is invalid.`);
    const sample = value as Record<string, unknown>;
    if (sample.primary !== undefined) validateEvidenceRecord(sample.primary, `${location} sample ${index + 1} primary row`);
    if (sample.related !== undefined) {
      if (!Array.isArray(sample.related)) throw new Error(`${location} sample ${index + 1} related rows are invalid.`);
      sample.related.forEach((record, relatedIndex) => validateEvidenceRecord(record, `${location} sample ${index + 1} related row ${relatedIndex + 1}`));
    }
  });
  if (evidence.aggregate !== undefined) validateEvidenceRecord({ values: evidence.aggregate }, `${location} aggregate context`);
}

function validationResult(value: unknown, run: number): ValidationResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Results JSON run ${run} has no validation result.`);
  const result = value as Record<string, unknown>;
  if (typeof result.valid !== "boolean" || typeof result.truncated !== "boolean" || !Array.isArray(result.issues)) {
    throw new Error(`Results JSON run ${run} has an invalid validation result.`);
  }
  const issues = result.issues.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Results JSON run ${run}, issue ${index + 1} is invalid.`);
    const issue = value as Record<string, unknown>;
    if (!["file", "column", "row", "cell"].includes(String(issue.level)) || typeof issue.code !== "string" || typeof issue.message !== "string") {
      throw new Error(`Results JSON run ${run}, issue ${index + 1} is missing its level, code, or message.`);
    }
    if (issue.title !== undefined && typeof issue.title !== "string" || issue.diagnostic !== undefined && typeof issue.diagnostic !== "string") {
      throw new Error(`Results JSON run ${run}, issue ${index + 1} has an invalid title or diagnostic.`);
    }
    if (issue.evidence !== undefined) validateEvidence(issue.evidence, `Results JSON run ${run}, issue ${index + 1} evidence`);
    return value as ValidationResult["issues"][number];
  });
  return {
    ...(result as unknown as ValidationResult),
    rowCount: requiredInteger(result.rowCount, `run ${run} row count`),
    columnCount: requiredInteger(result.columnCount, `run ${run} column count`),
    testCount: requiredInteger(result.testCount, `run ${run} test count`),
    issueCount: requiredInteger(result.issueCount, `run ${run} issue count`),
    errorCount: requiredInteger(result.errorCount, `run ${run} error count`),
    warningCount: requiredInteger(result.warningCount, `run ${run} warning count`),
    issues
  };
}

/** Parse a Workbench JSON result export without trusting its runtime shape. */
export function parseValidationRunExport(text: string): ValidationRunExport {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error("The selected file is not valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The selected file is not a validation results export.");
  const exportValue = value as Record<string, unknown>;
  if (exportValue.schema !== "incursa.csv-contract-results/v1") throw new Error("Unsupported results JSON. Expected incursa.csv-contract-results/v1.");
  if (typeof exportValue.contract !== "string" || !exportValue.contract.trim() || !Array.isArray(exportValue.runs)) {
    throw new Error("Results JSON is missing its contract or target runs.");
  }
  const runs = exportValue.runs.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Results JSON run ${index + 1} is invalid.`);
    const run = value as Record<string, unknown>;
    if (typeof run.target !== "string" || !run.target.trim()) throw new Error(`Results JSON run ${index + 1} has no target.`);
    if (run.error !== undefined && typeof run.error !== "string") throw new Error(`Results JSON run ${index + 1} has an invalid execution error.`);
    return { ...(run as unknown as IssueExportRun), result: run.result === undefined ? undefined : validationResult(run.result, index + 1) };
  });
  if (!runs.length) throw new Error("Results JSON contains no target runs to review.");
  const parsed = createValidationRunExport(exportValue.contract, runs);
  return { ...parsed, manifest: exportValue.manifest && typeof exportValue.manifest === "object" ? exportValue.manifest as PackageManifest : parsed.manifest,
    exportedAt: typeof exportValue.exportedAt === "string" ? exportValue.exportedAt : undefined };
}

export function validationRunExportJson(contract: string, runs: IssueExportRun[], options: { definition?: unknown; kind?: "contract" | "suite"; identity?: string } = {}): string {
  return `${JSON.stringify(createValidationRunExport(contract, runs, options), null, 2)}\n`;
}

export function issueRunsToCsv(runs: IssueExportRun[], context?: unknown, options: { identity?: string; definition?: unknown; kind?: "contract" | "suite" } = {}): string {
  const columns = [
    "Target",
    "Severity",
    "Level",
    "Code",
    "TestId",
    "Column",
    "Row",
    "Message",
    "Actual",
    "Expected",
    "PrimaryRows",
    "RelatedRows",
    "AggregateContext",
    "EvidenceLimited"
  ];
  const manifest = manifestFromRuns(options.identity ?? (typeof context === "string" ? context : "validation-package"), runs, options.definition, options.kind);
  const extended = context !== undefined || runs.some(run => run.runId);
  const metadata = (run: IssueExportRun) => extended ? [run.runId ?? "", run.workId ?? "", run.evaluatedAt ?? "", run.scope ?? "", run.status ?? (run.result?.valid ? "PASS" : "FAIL"), JSON.stringify(context ?? {}), String(run.result?.issueCount ?? 0), String(run.result?.issues.length ?? 0), String(run.result?.truncated ?? false)] : [];
  const rows = runs.flatMap((run) => (run.result?.issues ?? []).map((issue) => [
    run.target,
    issue.severity ?? "error",
    issue.level,
    issue.code,
    issue.testId ?? "",
    issue.column ?? "",
    issue.row === undefined ? "" : String(issue.row),
    issue.message,
    issue.actual === undefined ? "" : String(issue.actual),
    issue.expected === undefined ? "" : String(issue.expected),
    JSON.stringify(issue.evidence?.samples.flatMap(sample => sample.primary ? [sample.primary] : []) ?? []),
    JSON.stringify(issue.evidence?.samples.flatMap(sample => sample.related ?? []) ?? []),
    JSON.stringify(issue.evidence?.aggregate ?? {}),
    String(issue.evidence?.limited ?? false), ...metadata(run)
  ]));
  for (const run of runs) {
    if (run.error) rows.push([run.target, run.status ?? "ERROR", "execution", "", "", "", "", run.error, "", "", "[]", "[]", "{}", "false", ...metadata(run)]);
    else if (extended && !run.result?.issues.length) rows.push([run.target, "", "summary", "", "", "", "", "No retained issue details in this scope.", "", "", "[]", "[]", "{}", "false", ...metadata(run)]);
  }
  // Keep the original compact CSV shape for callers that use the legacy
  // overload. Application exports pass provenance options and receive the
  // versioned manifest columns below.
  if (extended || options.identity !== undefined || options.definition !== undefined || options.kind !== undefined) {
    columns.push("PackageSchemaVersion", "ToolVersion", "PackageKind", "PackageIdentity", "DefinitionFingerprint", "PackageRunId", "EvaluatedAt", "SelectedScope", "SourceLabels", "Targets", "EvidenceRetention", "Sampled", "Truncated", "EvidenceComplete", "CompletenessNotices");
    const manifestValues = [manifest.packageSchemaVersion, manifest.toolVersion, manifest.identity.kind, manifest.identity.id, manifest.identity.definitionFingerprint, manifest.run.id, manifest.run.evaluatedAt ?? "", JSON.stringify(manifest.selectedScope), JSON.stringify(manifest.sourceLabels), JSON.stringify(manifest.targets), JSON.stringify(manifest.evidence.retention), String(manifest.evidence.sampled), String(manifest.evidence.truncated), String(manifest.evidence.complete), JSON.stringify(manifest.completenessNotices)];
    rows.forEach(row => row.push(...manifestValues));
  }
  return rowsToCsv(columns, rows);
}

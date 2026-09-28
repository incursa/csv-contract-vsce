import type { ValidationResult } from "./core/model";
import { rowsToCsv } from "./comparison/evidence";

export interface IssueExportRun {
  runId?: string;
  workId?: string;
  evaluatedAt?: string;
  scope?: string;
  target: string;
  result?: ValidationResult;
  status?: string;
  error?: string;
}

export interface ValidationRunExport {
  schema: "incursa.csv-contract-results/v1";
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

export function createValidationRunExport(contract: string, runs: IssueExportRun[]): ValidationRunExport {
  const issues = runs.reduce((total, run) => total + (run.result?.issueCount ?? 0), 0);
  const retainedIssueDetails = runs.reduce((total, run) => total + (run.result?.issues.length ?? 0), 0);
  return {
    schema: "incursa.csv-contract-results/v1",
    contract,
    exportedAt: new Date().toISOString(),
    totals: {
      targets: runs.length,
      passed: runs.filter((run) => (run.result?.valid && run.result.preview?.scope !== "sample" && (!run.status || run.status === "PASS"))).length,
      rowsScanned: runs.reduce((total, run) => total + (run.result?.rowCount ?? 0), 0),
      errors: runs.reduce((total, run) => total + (run.result?.errorCount ?? 0), 0),
      warnings: runs.reduce((total, run) => total + (run.result?.warningCount ?? 0), 0),
      issues,
      retainedIssueDetails,
      issueDetailsComplete: issues === retainedIssueDetails
    },
    runs
  };
}

function requiredInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`Results JSON has an invalid ${name}.`);
  return Number(value);
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
  return { ...parsed, exportedAt: typeof exportValue.exportedAt === "string" ? exportValue.exportedAt : undefined };
}

export function validationRunExportJson(contract: string, runs: IssueExportRun[]): string {
  return `${JSON.stringify(createValidationRunExport(contract, runs), null, 2)}\n`;
}

export function issueRunsToCsv(runs: IssueExportRun[], context?: unknown): string {
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
    "Expected"
  ];
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
    issue.expected === undefined ? "" : String(issue.expected), ...metadata(run)
  ]));
  for (const run of runs) {
    if (run.error) rows.push([run.target, run.status ?? "ERROR", "execution", "", "", "", "", run.error, "", "", ...metadata(run)]);
    else if (extended && !run.result?.issues.length) rows.push([run.target, "", "summary", "", "", "", "", "No retained issue details in this scope.", "", "", ...metadata(run)]);
  }
  if (extended) columns.push("RunId", "WorkId", "EvaluatedAt", "EvaluationScope", "Status", "ExportScope", "TotalIssues", "RetainedIssues", "DetailsLimited");
  return rowsToCsv(columns, rows);
}

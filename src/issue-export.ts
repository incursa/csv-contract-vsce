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

import type { ValidationResult } from "./core/model";
import { rowsToCsv } from "./comparison/evidence";

export interface IssueExportRun {
  target: string;
  result: ValidationResult;
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
  const issues = runs.reduce((total, run) => total + run.result.issueCount, 0);
  const retainedIssueDetails = runs.reduce((total, run) => total + run.result.issues.length, 0);
  return {
    schema: "incursa.csv-contract-results/v1",
    contract,
    totals: {
      targets: runs.length,
      passed: runs.filter((run) => run.result.valid).length,
      rowsScanned: runs.reduce((total, run) => total + run.result.rowCount, 0),
      errors: runs.reduce((total, run) => total + run.result.errorCount, 0),
      warnings: runs.reduce((total, run) => total + run.result.warningCount, 0),
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

export function issueRunsToCsv(runs: IssueExportRun[]): string {
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
  const rows = runs.flatMap((run) => run.result.issues.map((issue) => [
    run.target,
    issue.severity ?? "error",
    issue.level,
    issue.code,
    issue.testId ?? "",
    issue.column ?? "",
    issue.row === undefined ? "" : String(issue.row),
    issue.message,
    issue.actual === undefined ? "" : String(issue.actual),
    issue.expected === undefined ? "" : String(issue.expected)
  ]));
  return rowsToCsv(columns, rows);
}

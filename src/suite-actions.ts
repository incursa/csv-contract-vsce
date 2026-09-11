import { yamlDocument, type SuiteConnection, type SuiteRun } from "./core/suite";
import { rowsToCsv } from "./comparison/evidence";

/** Edit only the selected connection mapping; retain YAML nodes and comments elsewhere. */
export function updateSuiteConnection(text: string, path: (string | number)[], settings: SuiteConnection): string {
  const doc = yamlDocument(text);
  doc.deleteIn([...path, "connection"]);
  doc.deleteIn([...path, "integratedConnection"]);
  for (const [key, value] of Object.entries(settings)) doc.setIn([...path, key], value);
  return doc.toString();
}

export function suiteErrorsCsv(runs: SuiteRun[], context?: unknown): string {
  const rows: string[][] = [];
  const extended = context !== undefined || runs.some(run => run.runId);
  for (const run of runs) {
    const start = rows.length;
    const identity = [run.suite, run.member, run.table ?? run.target ?? "", run.status];
    if (run.error) rows.push([...identity, "execution", "", "", "", run.error, "", ""]);
    for (const issue of run.result?.issues ?? []) rows.push([...identity, issue.severity ?? "error", issue.testId ?? issue.code,
      issue.column ?? "", String(issue.row ?? ""), issue.message, JSON.stringify(issue.actual) ?? "", JSON.stringify(issue.expected) ?? ""]);
    if (run.result?.truncated) rows.push([...identity, "truncated", "", "", "", "Issue details were limited; this export contains retained details only.", "", ""]);
    if (extended) {
      if (rows.length === start) rows.push([...identity, "summary", "", "", "", "No retained issue details in this scope.", "", ""]);
      for (let i = start; i < rows.length; i++) rows[i].push(run.runId ?? "", run.workId ?? "", run.evaluatedAt ?? "", run.scope ?? "", JSON.stringify(context ?? {}), String(run.result?.issueCount ?? 0), String(run.result?.issues.length ?? 0));
    }
  }
  return rowsToCsv(["Suite", "Member", "Table/Target", "Status", "Severity", "Rule/Code", "Column", "Row", "Message", "Actual", "Expected", ...(extended ? ["RunId", "WorkId", "EvaluatedAt", "EvaluationScope", "ExportScope", "TotalIssues", "RetainedIssues"] : [])], rows);
}

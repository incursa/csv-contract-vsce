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

export function suiteErrorsCsv(runs: SuiteRun[]): string {
  const rows: string[][] = [];
  for (const run of runs) {
    const identity = [run.suite, run.member, run.table ?? run.target ?? "", run.status];
    if (run.error) rows.push([...identity, "execution", "", "", "", run.error, "", ""]);
    for (const issue of run.result?.issues ?? []) rows.push([...identity, issue.severity ?? "error", issue.testId ?? issue.code,
      issue.column ?? "", String(issue.row ?? ""), issue.message, JSON.stringify(issue.actual) ?? "", JSON.stringify(issue.expected) ?? ""]);
    if (run.result?.truncated) rows.push([...identity, "truncated", "", "", "", "Issue details were limited; this export contains retained details only.", "", ""]);
  }
  return rowsToCsv(["Suite", "Member", "Table/Target", "Status", "Severity", "Rule/Code", "Column", "Row", "Message", "Actual", "Expected"], rows);
}

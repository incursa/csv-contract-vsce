import { yamlDocument, type SuiteConnection, type SuiteRun } from "./core/suite";
import { rowsToCsv } from "./comparison/evidence";
import { manifestFromRuns } from "./core/package-manifest";

/** Edit only the selected connection mapping; retain YAML nodes and comments elsewhere. */
export function updateSuiteConnection(text: string, path: (string | number)[], settings: SuiteConnection): string {
  const doc = yamlDocument(text);
  doc.deleteIn([...path, "connection"]);
  doc.deleteIn([...path, "integratedConnection"]);
  for (const [key, value] of Object.entries(settings)) doc.setIn([...path, key], value);
  return doc.toString();
}

export function suiteErrorsCsv(runs: SuiteRun[], context?: unknown, definition?: unknown): string {
  const rows: string[][] = [];
  const orderedRuns = [...runs].sort((left, right) => left.suite.localeCompare(right.suite) || left.member.localeCompare(right.member) || (left.table ?? left.target ?? "").localeCompare(right.table ?? right.target ?? "") || left.status.localeCompare(right.status) || (left.runId ?? "").localeCompare(right.runId ?? "") || (left.workId ?? "").localeCompare(right.workId ?? ""));
  const manifest = manifestFromRuns(orderedRuns[0]?.suite ?? "validation-suite", orderedRuns, definition, "suite");
  const extended = context !== undefined || orderedRuns.some(run => run.runId);
  for (const run of orderedRuns) {
    const start = rows.length;
    const identity = [run.suite, run.member, run.table ?? run.target ?? "", run.status];
    if (run.error) rows.push([...identity, "execution", "", "", "", run.error, "", "", "[]", "[]", "{}", "false"]);
    for (const issue of run.result?.issues ?? []) rows.push([...identity, issue.severity ?? "error", issue.testId ?? issue.code,
      issue.column ?? "", String(issue.row ?? ""), issue.message, JSON.stringify(issue.actual) ?? "", JSON.stringify(issue.expected) ?? "",
      JSON.stringify(issue.evidence?.samples.flatMap(sample => sample.primary ? [sample.primary] : []) ?? []),
      JSON.stringify(issue.evidence?.samples.flatMap(sample => sample.related ?? []) ?? []), JSON.stringify(issue.evidence?.aggregate ?? {}), String(issue.evidence?.limited ?? false)]);
    if (run.result?.truncated) rows.push([...identity, "truncated", "", "", "", "Issue details were limited; this export contains retained details only.", "", "", "[]", "[]", "{}", "true"]);
    if (extended) {
      if (rows.length === start) rows.push([...identity, "summary", "", "", "", "No retained issue details in this scope.", "", ""]);
      for (let i = start; i < rows.length; i++) rows[i].push(run.runId ?? "", run.workId ?? "", run.evaluatedAt ?? "", run.scope ?? "", JSON.stringify(context ?? {}), String(run.result?.issueCount ?? 0), String(run.result?.issues.length ?? 0));
    }
  }
  const manifestValues = [manifest.packageSchemaVersion, manifest.toolVersion, manifest.identity.kind, manifest.identity.id, manifest.identity.definitionFingerprint, manifest.run.id, manifest.run.evaluatedAt ?? "", JSON.stringify(manifest.selectedScope), JSON.stringify(manifest.sourceLabels), JSON.stringify(manifest.targets), JSON.stringify(manifest.evidence.retention), String(manifest.evidence.sampled), String(manifest.evidence.truncated), String(manifest.evidence.complete), JSON.stringify(manifest.completenessNotices)];
  rows.forEach(row => row.push(...manifestValues));
  return rowsToCsv(["Suite", "Member", "Table/Target", "Status", "Severity", "Rule/Code", "Column", "Row", "Message", "Actual", "Expected", "PrimaryRows", "RelatedRows", "AggregateContext", "EvidenceLimited", ...(extended ? ["RunId", "WorkId", "EvaluatedAt", "EvaluationScope", "ExportScope", "TotalIssues", "RetainedIssues"] : []), "PackageSchemaVersion", "ToolVersion", "PackageKind", "PackageIdentity", "DefinitionFingerprint", "PackageRunId", "EvaluatedAt", "SelectedScope", "SourceLabels", "Targets", "EvidenceRetention", "Sampled", "Truncated", "EvidenceComplete", "CompletenessNotices"], rows);
}

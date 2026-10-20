import { yamlDocument, type SuiteConnection, type SuiteRun } from "./core/suite";
import type { SuiteTargetOverride } from "./core/suite-target-policy";
import { rowsToCsv } from "./comparison/evidence";

/** Edit only the selected connection mapping; retain YAML nodes and comments elsewhere. */
export function updateSuiteConnection(text: string, path: (string | number)[], settings: SuiteConnection): string {
  const doc = yamlDocument(text);
  doc.deleteIn([...path, "connection"]);
  doc.deleteIn([...path, "integratedConnection"]);
  for (const [key, value] of Object.entries(settings)) doc.setIn([...path, key], value);
  return doc.toString();
}

/** Update one suite environment policy without rewriting unrelated YAML nodes or comments. */
export function updateSuiteEnvironmentPolicy(text: string, environment: string, enabled?: boolean): string {
  const doc = yamlDocument(text);
  const path = ["targetPolicy", "sqlServer", "environments", environment];
  if (enabled === undefined) doc.deleteIn(path);
  else doc.setIn(path, enabled);
  return doc.toString();
}

/** Update or reset one member target override while leaving referenced child contracts untouched. */
export function updateSuiteTargetOverride(text: string, memberIndex: number, target: string, enabled?: boolean): string {
  const doc = yamlDocument(text);
  const path = ["members", memberIndex, "targetOverrides"];
  const current = doc.getIn(path) as { toJSON?: () => unknown } | undefined;
  const overrides = current?.toJSON?.();
  const list = Array.isArray(overrides) ? overrides.filter((item): item is SuiteTargetOverride =>
    !!item && typeof item === "object" && typeof (item as SuiteTargetOverride).target === "string") : [];
  const next = list.filter(item => item.target !== target);
  if (enabled !== undefined) next.push({ target, enabled });
  if (next.length) doc.setIn(path, next);
  else doc.deleteIn(path);
  return doc.toString();
}

export function suiteErrorsCsv(runs: SuiteRun[], context?: unknown): string {
  const rows: string[][] = [];
  const extended = context !== undefined || runs.some(run => run.runId);
  for (const run of runs) {
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
  return rowsToCsv(["Suite", "Member", "Table/Target", "Status", "Severity", "Rule/Code", "Column", "Row", "Message", "Actual", "Expected", "PrimaryRows", "RelatedRows", "AggregateContext", "EvidenceLimited", ...(extended ? ["RunId", "WorkId", "EvaluatedAt", "EvaluationScope", "ExportScope", "TotalIssues", "RetainedIssues"] : [])], rows);
}

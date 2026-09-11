import type { ValidationResult } from "./core/model";
export interface DisplayRun { workId?: string; runId?: string; evaluatedAt?: string; scope?: string; target?: string; table?: string; member?: string; status?: string; error?: string; result?: ValidationResult }
const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export const issueSelectionKey = (run: DisplayRun, index: number) => JSON.stringify([run.workId ?? [run.member, run.table, run.target], index]);
const matches = (run: DisplayRun, value: unknown, filter: string) => JSON.stringify([run.member, run.target, run.table, run.status, value]).toLowerCase().includes(filter.toLowerCase());
export function filterResultRuns<T extends DisplayRun>(runs: T[], filter: string, selected: string[] = []): T[] {
  if (!filter && !selected.length) return runs;
  const keys = new Set(runs.flatMap(run => [...(run.result?.issues ?? []).map((_, i) => issueSelectionKey(run, i)), ...(run.error ? [issueSelectionKey(run, -1)] : [])]));
  if (selected.some(key => !keys.has(key))) throw new Error("Selected results are stale. Select issues from the current report.");
  return runs.flatMap(run => {
    const error = run.error && matches(run, run.error, filter) && (!selected.length || selected.includes(issueSelectionKey(run, -1))) ? run.error : undefined;
    const issues = run.result?.issues.filter((issue, i) => matches(run, issue, filter) && (!selected.length || selected.includes(issueSelectionKey(run, i)))) ?? [];
    if (!issues.length && !error) return [];
    return [{ ...run, error, result: run.result ? { ...run.result, issues, examples: undefined, truncated: run.result.truncated || issues.length < run.result.issues.length } : undefined }];
  });
}
export function renderResults(runs: DisplayRun[], filter = "", stale = false): string {
  return runs.map(run => {
    const result = run.result;
    const status = stale ? "STALE" : result?.preview?.scope === "sample" ? "SAMPLED — incomplete validation" : run.status ?? (result?.valid ? "PASS" : result ? "FAIL" : "ERROR");
    const issues = result?.issues.filter(i => matches(run, i, filter)) ?? [];
    const select = (index: number) => `<input type="checkbox" data-issue-selection="${escape(issueSelectionKey(run, index))}" aria-label="Select ${escape(index < 0 ? "execution diagnostic" : result?.issues[index].testId ?? result?.issues[index].code)} for export">`;
    return `<section class="target-result run"><div class="target-result__heading"><strong>${escape(status)}</strong> <code>${escape(run.table ?? run.target ?? run.member)}</code></div>
      ${run.error && matches(run, run.error, filter) ? `<div data-result-search="${escape(JSON.stringify([run.status, run.error]))}">${select(-1)}<pre class="error" role="alert">${escape(run.error)}</pre></div>` : ""}
      ${result ? `<p>${result.rowCount} rows examined · ${result.errorCount} assertion failures · ${result.warningCount} warnings</p>
      ${result.preview ? `<p>${result.preview.scope === "sample" ? `Sample of up to ${result.preview.rowLimit} rows; remaining rows were not validated.` : "Complete configured scope."} Examples limited to ${result.preview.exampleLimit} per outcome and conditional rule; aggregate rules have no row examples.</p>` : ""}
      ${result.examples?.length ? `<details><summary>Preview examples (${result.examples.length})</summary>${result.examples.map(e => `<p>${escape(e.id)} · ${escape(e.outcome)} · row ${e.row}</p><pre>${escape(JSON.stringify(e.values, null, 2))}</pre>`).join("")}</details>` : ""}
      ${result.ruleOutcomes?.map(r => `<p><button data-action="jump-rule" data-rule="${escape(r.id)}">${escape(r.id)}</button>: ${r.selected} selected · ${r.passed} passed · ${r.failed} failed${r.selected === 0 ? " · No rows matched the condition" : ""}</p>`).join("") ?? ""}
      ${result.truncated ? `<p>Details limited: ${result.issues.length} retained of ${result.issueCount} issues.</p>` : ""}
      <div class="table-scroll"><table><thead><tr><th>Select</th><th>Rule / code</th><th>Severity</th><th>Column / row</th><th>Expected</th><th>Actual</th><th>Diagnostic</th></tr></thead><tbody>${issues.map(i => `<tr data-result-search="${escape(JSON.stringify([run.member, run.target, run.table, run.status, i]))}"><td>${select(result.issues.indexOf(i))}</td><td><button data-action="jump-rule" data-rule="${escape(i.testId ?? i.code)}">${escape(i.testId ?? i.code)}</button></td><td>${escape(i.severity ?? "error")}</td><td>${escape(i.column)} ${escape(i.row)}</td><td>${escape(i.expected)}</td><td>${escape(i.actual)}</td><td>${escape(i.message)}</td></tr>`).join("")}</tbody></table></div>` : ""}</section>`;
  }).join("");
}

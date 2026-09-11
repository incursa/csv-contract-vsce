import type { ValidationResult } from "./core/model";
export interface DisplayRun { target?: string; table?: string; member?: string; status?: string; error?: string; result?: ValidationResult }
const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export function filterResultRuns<T extends DisplayRun>(runs: T[], filter: string): T[] {
  if (!filter) return runs;
  const query = filter.toLowerCase();
  return runs.map(run => {
    if (!run.result) return run;
    const issues = run.result.issues.filter(i => JSON.stringify([run.member, run.target, run.table, i]).toLowerCase().includes(query));
    return { ...run, result: { ...run.result, issues, truncated: run.result.truncated || issues.length < run.result.issues.length } };
  });
}
export function renderResults(runs: DisplayRun[], filter = "", stale = false): string {
  const query = filter.toLowerCase();
  return runs.map(run => {
    const result = run.result;
    const status = stale ? "STALE" : run.status ?? (result?.valid ? "PASS" : result ? "FAIL" : "ERROR");
    const issues = result?.issues.filter(i => JSON.stringify([run.member, run.target, run.table, i]).toLowerCase().includes(query)) ?? [];
    return `<section class="target-result run"><div class="target-result__heading"><strong>${escape(status)}</strong> <code>${escape(run.table ?? run.target ?? run.member)}</code></div>
      ${run.error ? `<pre class="error" role="alert">${escape(run.error)}</pre>` : ""}
      ${result ? `<p>${result.rowCount} rows examined · ${result.errorCount} assertion failures · ${result.warningCount} warnings</p>
      ${result.ruleOutcomes?.map(r => `<p><button data-action="jump-rule" data-rule="${escape(r.id)}">${escape(r.id)}</button>: ${r.selected} selected · ${r.passed} passed · ${r.failed} failed${r.selected === 0 ? " · No rows matched the condition" : ""}</p>`).join("") ?? ""}
      ${result.truncated ? `<p>Details limited: ${result.issues.length} retained of ${result.issueCount} issues.</p>` : ""}
      <div class="table-scroll"><table><thead><tr><th>Rule / code</th><th>Severity</th><th>Column / row</th><th>Expected</th><th>Actual</th><th>Diagnostic</th></tr></thead><tbody>${issues.map(i => `<tr><td><button data-action="jump-rule" data-rule="${escape(i.testId ?? i.code)}">${escape(i.testId ?? i.code)}</button></td><td>${escape(i.severity ?? "error")}</td><td>${escape(i.column)} ${escape(i.row)}</td><td>${escape(i.expected)}</td><td>${escape(i.actual)}</td><td>${escape(i.message)}</td></tr>`).join("")}</tbody></table></div>` : ""}</section>`;
  }).join("");
}

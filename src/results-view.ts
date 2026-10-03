import type { ValidationResult } from "./core/model";
import { resultHealth, resultHealthCategory, resultHealthTitle, type ResultColorMode } from "./core/result-health";
export interface DisplayRun { workId?: string; runId?: string; evaluatedAt?: string; scope?: string; target?: string; table?: string; member?: string; status?: string; error?: string; result?: ValidationResult }
const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const humanize = (value: string) => value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[._/-]+/g, " ").replace(/\b\w/g, letter => letter.toUpperCase());
const shown = (value: unknown) => value === undefined ? "Not provided" : value === "" ? "(empty)" : String(value);
function issueLocation(issue: ValidationResult["issues"][number]): string {
  const parts = [issue.row === undefined ? undefined : `Row ${issue.row}`, issue.column ? `Column ${issue.column}` : undefined,
    issue.level === "file" ? "Whole target" : issue.level === "column" && !issue.column ? "Column check" : undefined].filter(Boolean);
  return parts.join(" · ") || humanize(issue.level);
}
function groupTags(group?: Record<string, string>): string {
  return Object.entries(group ?? {}).map(([name, value]) => `<span class="finding-chip"><span>${escape(name)}</span> ${escape(shown(value))}</span>`).join("");
}
function evidenceRecord(record: NonNullable<ValidationResult["issues"][number]["evidence"]>["samples"][number]["primary"]): string {
  if (!record) return "";
  const heading = [record.label, record.row === undefined ? undefined : `row ${record.row}`].filter(Boolean).join(" · ");
  return `<section class="evidence-record"><h5>${escape(heading || "Record")}</h5><div class="evidence-table" role="table">${Object.entries(record.values).map(([column, value]) => `<div role="row"><span role="cell">${escape(column)}</span><code role="cell">${escape(shown(value))}</code></div>`).join("")}</div></section>`;
}
function issueEvidence(issue: ValidationResult["issues"][number]): string {
  const evidence = issue.evidence;
  if (!evidence || (!evidence.samples.length && !evidence.aggregate)) return "";
  const total = evidence.totalSamples ?? evidence.samples.length;
  return `<details class="finding-evidence"><summary>Row evidence${total ? ` (${total.toLocaleString()}${evidence.limited ? ", sample limited" : ""})` : ""}</summary>
    ${evidence.aggregate ? `<section class="evidence-aggregate"><h5>Aggregate context</h5><pre>${escape(JSON.stringify(evidence.aggregate, null, 2))}</pre></section>` : ""}
    ${evidence.samples.map((sample, index) => `<div class="evidence-sample"><h4>Failure sample ${index + 1}</h4>${sample.primary ? evidenceRecord(sample.primary) : ""}${(sample.related ?? []).map(evidenceRecord).join("")}</div>`).join("")}
    ${evidence.limited ? `<p class="finding-related">Showing ${evidence.samples.length.toLocaleString()} retained samples for ${total.toLocaleString()} failing rows or groups.</p>` : ""}
  </details>`;
}
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
export function renderResults(runs: DisplayRun[], filter = "", stale = false, colorMode: ResultColorMode = "binary"): string {
  return runs.map(run => {
    const result = run.result;
    const status = stale ? "STALE" : result?.preview?.scope === "sample" ? "SAMPLED — incomplete validation" : run.status ?? (result?.valid ? "PASS" : result ? "FAIL" : "ERROR");
    const health = resultHealth(result, run.status, colorMode);
    const healthLabel = colorMode === "graded" && !stale && result?.preview?.scope !== "sample" ? ` · ${resultHealthCategory(health)}` : "";
    const showHealth = colorMode === "graded" && !stale && result?.preview?.scope !== "sample";
    const visibleIssues: Array<{ issue: NonNullable<typeof result>["issues"][number]; index: number }> = [];
    let matchingIssues = 0;
    for (const [index, issue] of (result?.issues ?? []).entries()) if (matches(run, issue, filter)) {
      matchingIssues++;
      if (visibleIssues.length < 500) visibleIssues.push({ issue, index });
    }
    const ruleOutcomes = result?.ruleOutcomes ?? [];
    const groupOutcomes = result?.groupOutcomes ?? [];
    const outcomeSummary = ruleOutcomes.length + groupOutcomes.length ? `<details class="rule-execution-summary"><summary>Rule execution summary (${ruleOutcomes.length + groupOutcomes.length})</summary>
      <div class="rule-execution-list">
        ${ruleOutcomes.map(r => `<div class="rule-execution-row"><div><strong>${escape(r.name ?? humanize(r.id))}</strong><span>${r.selected} selected · ${r.passed} passed · ${r.failed} failed${r.selected === 0 ? " · No rows matched the condition" : ""}</span></div><button class="inc-btn inc-btn--outline-secondary inc-btn--sm" data-action="jump-rule" data-rule="${escape(r.id)}">View YAML definition</button></div>`).join("")}
        ${groupOutcomes.map(g => `<div class="rule-execution-row"><div><strong>${escape(g.name ?? humanize(g.id))}</strong><span>${g.groups} groups · ${g.passed} passed · ${g.failed} failed</span></div><button class="inc-btn inc-btn--outline-secondary inc-btn--sm" data-action="jump-rule" data-rule="${escape(g.id)}">View YAML definition</button></div>`).join("")}
      </div></details>` : "";
    const select = (index: number) => `<input type="checkbox" data-issue-selection="${escape(issueSelectionKey(run, index))}" aria-label="Select ${escape(index < 0 ? "execution diagnostic" : result?.issues[index].testId ?? result?.issues[index].code)} for export">`;
    return `<section class="target-result run result-health result-health--${health.band}"><div class="target-result__heading"><strong class="result-health__status"${showHealth ? ` title="${escape(resultHealthTitle(health))}"` : ""}>${escape(status + healthLabel)}</strong><code>${escape(run.table ?? run.target ?? run.member)}</code></div>
      ${run.error && matches(run, run.error, filter) ? `<article class="finding-card finding-card--error" data-result-search="${escape(JSON.stringify([run.status, run.error]))}">
        <div class="finding-card__select">${select(-1)}</div><div class="finding-card__body"><div class="finding-card__topline"><span class="finding-severity finding-severity--error">Execution error</span></div>
        <h3>The target could not be validated</h3><pre class="error" role="alert">${escape(run.error)}</pre></div></article>` : ""}
      ${result ? `<p class="target-result__summary">${result.rowCount.toLocaleString()} rows examined · ${result.errorCount.toLocaleString()} errors · ${result.warningCount.toLocaleString()} warnings</p>
      ${result.preview ? `<p>${result.preview.scope === "sample" ? `Sample of up to ${result.preview.rowLimit} rows; remaining rows were not validated.` : "Complete configured scope."} Examples limited to ${result.preview.exampleLimit} per outcome and conditional rule; aggregate rules have no row examples.</p>` : ""}
      ${result.rowOutcomeSummary ? `<p>Row outcomes: ${result.rowOutcomeSummary.retainedRows.toLocaleString()} retained${result.rowOutcomeSummary.omittedRows ? `, ${result.rowOutcomeSummary.omittedRows.toLocaleString()} omitted` : ""}${result.rowOutcomeSummary.complete ? " (complete)" : ` (${result.rowOutcomeSummary.incompleteBecause ?? "incomplete"})`}.</p>` : ""}
      ${result.rowOutcomes?.length ? `<details><summary>Retained row outcomes (${result.rowOutcomes.length})</summary><div class="row-outcome-list">${result.rowOutcomes.slice(0, 100).map(row => `<p>Row ${row.row}: ${Object.entries(row.checks).map(([id, outcome]) => `${escape(id)}=${escape(outcome.state)}`).join(", ")}</p>`).join("")}</div></details>` : ""}
      ${result.examples?.length ? `<details><summary>Preview examples (${result.examples.length})</summary>${result.examples.map(e => `<p>${escape(e.id)} · ${escape(e.outcome)} · row ${e.row}</p><pre>${escape(JSON.stringify(e.values, null, 2))}</pre>`).join("")}</details>` : ""}
      ${outcomeSummary}
      ${result.truncated ? `<p>${result.issues.length.toLocaleString()} details retained for ${result.issueCount.toLocaleString()} reported issue events. SQL aggregate rules can summarize multiple rows in one detail.</p>` : ""}
      ${matchingIssues > visibleIssues.length ? `<p>Showing the first ${visibleIssues.length.toLocaleString()} matching details here. Export includes all retained details.</p>` : ""}
      ${visibleIssues.length ? `<div class="finding-list-heading"><h3>Findings</h3><span>${matchingIssues.toLocaleString()} matching</span></div>` : ""}
      <div class="finding-list">${visibleIssues.map(({ issue: i, index }) => {
        const severity = i.severity ?? "error";
        const identity = i.testId ?? i.code;
        const comparison = i.expected !== undefined || i.actual !== undefined ? `<dl class="finding-comparison">
          <div><dt>Expected</dt><dd>${escape(shown(i.expected))}</dd></div><div><dt>Actual</dt><dd>${escape(shown(i.actual))}</dd></div></dl>` : "";
        return `<article class="finding-card finding-card--${escape(severity)}" data-result-search="${escape(JSON.stringify([run.member, run.target, run.table, run.status, i]))}">
          <div class="finding-card__select">${select(index)}</div><div class="finding-card__body">
            <div class="finding-card__topline"><span class="finding-severity finding-severity--${escape(severity)}">${escape(severity)}</span><span>${escape(issueLocation(i))}</span></div>
            <div class="finding-card__heading"><h3>${escape(i.title ?? (i.testId ? humanize(i.testId) : humanize(i.code)))}</h3>${i.testId ? `<button class="finding-rule-action" data-action="jump-rule" data-rule="${escape(i.testId)}">View YAML definition</button>` : ""}</div>
            <p class="finding-message">${escape(i.message)}</p>
            ${i.diagnostic ? `<p class="finding-diagnostic"><strong>Why it failed:</strong> ${escape(i.diagnostic)}</p>` : ""}
            ${i.group ? `<div class="finding-groups" aria-label="Group values">${groupTags(i.group)}</div>` : ""}
            ${i.relatedRows?.length ? `<p class="finding-related">Related ${i.relatedRows.length === 1 ? "row" : "rows"}: ${escape(i.relatedRows.join(", "))}</p>` : ""}
            ${comparison}
            ${issueEvidence(i)}
            <details class="finding-technical"><summary>Technical details</summary><dl><div><dt>Rule or code</dt><dd><code>${escape(identity)}</code></dd></div><div><dt>Issue code</dt><dd><code>${escape(i.code)}</code></dd></div><div><dt>Scope</dt><dd>${escape(i.level)}</dd></div></dl></details>
          </div></article>`;
      }).join("")}</div>` : ""}</section>`;
  }).join("");
}

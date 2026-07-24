import type { ValidationIssue, ValidationResult } from "./core/model";

export interface WorkspaceReportEntryView {
  contractLabel: string;
  target: string;
  result?: ValidationResult;
  error?: string;
  durationMs?: number;
}

export interface WorkspaceReportView {
  completedAt: Date;
  durationMs: number;
  selectedContracts: number;
  targets: number;
  entries: WorkspaceReportEntryView[];
  valid: boolean;
}

export interface WorkspaceReportHtmlOptions {
  cspSource: string;
  styleUri: string;
  selectedEntryIndex?: number;
}

export function renderWorkspaceReportHtml(
  report: WorkspaceReportView,
  options: WorkspaceReportHtmlOptions
): string {
  const passed = report.entries.filter((entry) => entry.result?.valid === true).length;
  const failed = report.entries.length - passed;
  const selected = options.selectedEntryIndex === undefined
    ? undefined
    : report.entries[options.selectedEntryIndex];
  const status = report.valid ? "PASS" : "FAIL";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${escapeAttribute(options.cspSource)};">
  <link rel="stylesheet" href="${escapeAttribute(options.styleUri)}">
  <title>CSV Contract Test Report</title>
</head>
<body class="report-body">
  <header class="workbench-header report-header">
    <div>
      <span class="report-eyebrow">Workspace test run</span>
      <h1>CSV Contract Test Report</h1>
      <p>Completed ${escapeHtml(report.completedAt.toLocaleString())}</p>
    </div>
    <span class="report-status report-status--${report.valid ? "pass" : "fail"}">${status}</span>
  </header>
  <main class="workspace-report">
    <section class="report-metrics" aria-label="Run summary">
      ${metric("Contracts", report.selectedContracts)}
      ${metric("Targets", report.targets)}
      ${metric("Runs", report.entries.length)}
      ${metric("Passed", passed, "pass")}
      ${metric("Failed", failed, failed > 0 ? "fail" : undefined)}
      ${metric("Duration", formatDuration(report.durationMs))}
    </section>
    ${selected ? renderSelectedEntry(selected, options.selectedEntryIndex!) : ""}
    <section class="inc-card report-runs">
      <div class="report-section-heading">
        <div>
          <span class="report-eyebrow">Complete run</span>
          <h2>Contract and target results</h2>
        </div>
        <span>${passed} passed · ${failed} failed</span>
      </div>
      <div class="report-run-list">
        ${report.entries.map((entry, index) =>
          renderEntry(entry, index, index === options.selectedEntryIndex || entry.result?.valid !== true)
        ).join("")}
      </div>
    </section>
  </main>
</body>
</html>`;
}

function renderSelectedEntry(entry: WorkspaceReportEntryView, index: number): string {
  const valid = entry.result?.valid === true;
  return `<section class="inc-card report-selected report-selected--${valid ? "pass" : "fail"}" aria-labelledby="selected-run-title">
    <div class="report-section-heading">
      <div>
        <span class="report-eyebrow">Selected run</span>
        <h2 id="selected-run-title">${escapeHtml(fileName(entry.contractLabel))}</h2>
      </div>
      <span class="report-status report-status--${valid ? "pass" : "fail"}">${valid ? "PASS" : "FAIL"}</span>
    </div>
    <dl class="report-run-metrics">
      ${runMetric("Contract", entry.contractLabel)}
      ${runMetric("Target", entry.target)}
      ${entry.result ? runMetric("Rows", entry.result.rowCount.toLocaleString()) : ""}
      ${entry.result ? runMetric("Columns", entry.result.columnCount) : ""}
      ${entry.result ? runMetric("Tests", entry.result.testCount) : ""}
      ${runMetric("Duration", formatDuration(entry.durationMs ?? 0))}
    </dl>
    ${renderOutcome(entry)}
    <a class="report-jump" href="#run-${index + 1}">View this run in the complete list</a>
  </section>`;
}

function renderEntry(entry: WorkspaceReportEntryView, index: number, open: boolean): string {
  const valid = entry.result?.valid === true;
  const result = entry.result;
  return `<details id="run-${index + 1}" class="report-run report-run--${valid ? "pass" : "fail"}"${open ? " open" : ""}>
    <summary>
      <span class="report-run-status">${valid ? "PASS" : "FAIL"}</span>
      <span class="report-run-name">
        <strong>${escapeHtml(fileName(entry.contractLabel))}</strong>
        <small>${escapeHtml(entry.target)}</small>
      </span>
      <span class="report-run-stat">${result ? `${result.rowCount.toLocaleString()} rows` : "No result"}</span>
      <span class="report-run-stat">${result ? `${result.testCount} tests` : ""}</span>
      <span class="report-run-stat">${result ? `${result.issueCount} issues` : ""}</span>
      <span class="report-run-chevron" aria-hidden="true"></span>
    </summary>
    <div class="report-run-detail">
      <dl class="report-run-metrics">
        ${runMetric("Contract", entry.contractLabel)}
        ${runMetric("Target", entry.target)}
        ${result ? runMetric("Rows", result.rowCount.toLocaleString()) : ""}
        ${result ? runMetric("Columns", result.columnCount) : ""}
        ${result ? runMetric("Tests", result.testCount) : ""}
        ${runMetric("Duration", formatDuration(entry.durationMs ?? 0))}
      </dl>
      ${renderOutcome(entry)}
    </div>
  </details>`;
}

function renderOutcome(entry: WorkspaceReportEntryView): string {
  if (entry.error) {
    return `<div class="report-outcome report-outcome--fail">
      <strong>Run error</strong>
      <p>${escapeHtml(entry.error)}</p>
    </div>`;
  }
  if (!entry.result) {
    return `<div class="report-outcome report-outcome--fail"><p>No validation result was produced.</p></div>`;
  }
  if (entry.result.valid) {
    return `<div class="report-outcome report-outcome--pass">
      <strong>All ${entry.result.testCount.toLocaleString()} tests passed.</strong>
      <p>No validation issues were found in this target.</p>
    </div>`;
  }
  return `<div class="report-outcome report-outcome--fail">
    <strong>${entry.result.issueCount.toLocaleString()} validation issue${entry.result.issueCount === 1 ? "" : "s"}</strong>
    ${entry.result.truncated ? "<p>Only the retained diagnostics are shown because the issue limit was reached.</p>" : ""}
    <ol class="report-issues">${entry.result.issues.map(renderIssue).join("")}</ol>
  </div>`;
}

function renderIssue(issue: ValidationIssue): string {
  const location = [
    issue.column,
    issue.row ? `record ${issue.row}` : undefined,
    issue.testId
  ].filter(Boolean).join(" · ");
  return `<li>
    <code>${escapeHtml(issue.code)}</code>
    ${location ? `<span>${escapeHtml(location)}</span>` : ""}
    <p>${escapeHtml(issue.message)}</p>
  </li>`;
}

function metric(label: string, value: string | number, tone?: "pass" | "fail"): string {
  return `<div class="inc-card report-metric${tone ? ` report-metric--${tone}` : ""}">
    <span>${escapeHtml(label)}</span>
    <strong>${escapeHtml(String(value))}</strong>
  </div>`;
}

function runMetric(label: string, value: string | number): string {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(String(value))}</dd></div>`;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.max(0, Math.round(durationMs))} ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)} sec`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1000);
  return `${minutes} min ${seconds} sec`;
}

function fileName(value: string): string {
  return value.split(/[\\/]/).filter(Boolean).pop() ?? value;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

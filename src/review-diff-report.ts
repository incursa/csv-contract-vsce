import type { ReviewFailureDiff, ReviewPackageComparison } from "./core/review-diff";

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function findingRows(items: ReviewFailureDiff[]): string {
  if (!items.length) return '<p class="empty">None.</p>';
  return `<div class="table-wrap"><table>
    <thead><tr><th>Work</th><th>Target</th><th>Rule</th><th>Finding</th><th>Before events</th><th>After events</th><th>Delta</th></tr></thead>
    <tbody>${items.map(item => `<tr>
      <td><code>${escapeHtml(item.identity.workId)}</code></td>
      <td>${escapeHtml(item.identity.target)}</td>
      <td><code>${escapeHtml(item.identity.ruleId)}</code></td>
      <td><span class="severity ${escapeHtml(item.finding.severity)}">${escapeHtml(item.finding.severity)}</span> <strong>${escapeHtml(item.finding.title ?? item.finding.code)}</strong><div class="message">${escapeHtml(item.finding.message)}</div></td>
      <td class="number">${item.beforeFindingEvents}</td>
      <td class="number">${item.afterFindingEvents}</td>
      <td class="number">${escapeHtml(signed(item.findingEventDelta))}</td>
    </tr>`).join("")}</tbody>
  </table></div>`;
}

/** Render a standalone, script-free report using only already-redacted comparison data. */
export function renderReviewDiffHtml(comparison: ReviewPackageComparison): string {
  const indeterminate = comparison.indeterminate.length
    ? `<ul class="unknown-list">${comparison.indeterminate.map(item => `<li><strong>${escapeHtml(item.reason)}</strong>: ${escapeHtml(item.message)}${item.workId ? ` <span class="context">Work: <code>${escapeHtml(item.workId)}</code></span>` : ""}${item.target ? ` <span class="context">Target: ${escapeHtml(item.target)}</span>` : ""}${item.ruleId ? ` <span class="context">Rule: <code>${escapeHtml(item.ruleId)}</code></span>` : ""}${item.beforeIssueEvents === undefined && item.afterIssueEvents === undefined ? "" : ` <span class="context">Saved issue events: ${escapeHtml(item.beforeIssueEvents ?? "unknown")} → ${escapeHtml(item.afterIssueEvents ?? "unknown")}</span>`}</li>`).join("")}</ul>`
    : '<p class="empty">None.</p>';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Validation saved-run comparison</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0 auto; max-width: 1180px; padding: 32px 24px 64px; line-height: 1.45; }
    h1 { margin-bottom: 4px; } h2 { margin-top: 32px; }
    .muted, .message, .context { color: #6b7280; }
    .packages { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 12px; margin: 24px 0; }
    .package, .metric, .notice { border: 1px solid #9ca3af66; border-radius: 8px; padding: 12px 14px; }
    .package span { display: block; } .package code { overflow-wrap: anywhere; }
    .metrics { display: flex; flex-wrap: wrap; gap: 10px; }
    .metric { min-width: 120px; } .metric strong { display: block; font-size: 1.5rem; }
    .notice { background: #f59e0b18; margin: 20px 0; }
    .table-wrap { overflow-x: auto; border: 1px solid #9ca3af66; border-radius: 8px; }
    table { border-collapse: collapse; width: 100%; font-size: .92rem; }
    th, td { border-bottom: 1px solid #9ca3af44; padding: 9px 10px; text-align: left; vertical-align: top; }
    th { background: #6b728018; white-space: nowrap; } tbody tr:last-child td { border-bottom: 0; }
    .number { font-variant-numeric: tabular-nums; text-align: right; }
    .severity { border-radius: 999px; display: inline-block; font-size: .72rem; font-weight: 700; padding: 1px 7px; text-transform: uppercase; }
    .severity.error { background: #dc262626; color: #b91c1c; } .severity.warning { background: #d9770626; color: #b45309; }
    .unknown-list { padding-left: 22px; } .unknown-list li { margin: 8px 0; }
    .context { display: inline-block; margin-left: 8px; } .empty { color: #6b7280; font-style: italic; }
    code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
    @media print { body { max-width: none; padding: 0; } .table-wrap { overflow: visible; } }
  </style>
</head>
<body>
  <header>
    <h1>Validation saved-run comparison</h1>
    <p class="muted">A self-contained comparison of two saved, redacted review packages. No source data was queried to create this report.</p>
  </header>
  <section class="packages" aria-label="Compared packages">
    <div class="package"><strong>Before</strong><code>${escapeHtml(comparison.before.packageId)}</code><span>${escapeHtml(comparison.before.createdAt)}</span></div>
    <div class="package"><strong>After</strong><code>${escapeHtml(comparison.after.packageId)}</code><span>${escapeHtml(comparison.after.createdAt)}</span></div>
  </section>
  <section class="metrics" aria-label="Comparison summary">
    <div class="metric"><strong>${comparison.summary.newRules}</strong>New rules failing</div>
    <div class="metric"><strong>${comparison.summary.resolvedRules}</strong>Resolved rules</div>
    <div class="metric"><strong>${comparison.summary.persistentRules}</strong>Persistent rules</div>
    <div class="metric"><strong>${comparison.summary.indeterminateItems}</strong>Indeterminate items</div>
    <div class="metric"><strong>${comparison.summary.beforeFindingEvents} → ${comparison.summary.afterFindingEvents}</strong>Finding events</div>
  </section>
  <p class="notice"><strong>Count meaning:</strong> finding events are complete saved issue-object counts, not estimates of impacted source records. One aggregate finding can represent many affected rows. Bounded evidence samples are descriptive only.</p>
  <section><h2>New failures</h2>${findingRows(comparison.newFailures)}</section>
  <section><h2>Resolved failures</h2>${findingRows(comparison.resolvedFailures)}</section>
  <section><h2>Persistent failures</h2>${findingRows(comparison.persistentFailures)}</section>
  <section><h2>Indeterminate</h2>${indeterminate}</section>
</body>
</html>\n`;
}

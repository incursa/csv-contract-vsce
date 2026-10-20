import type { CheckOutcome, ValidationIssue, ValidationResult } from "./core/model";
import type { ReviewPackageTarget, ValidationReviewPackage } from "./core/review-package";

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function shown(value: unknown, fallback = "Not available"): string {
  return value === undefined || value === null || value === "" ? fallback : String(value);
}

function statusLabel(target: ReviewPackageTarget): string {
  const labels: Record<ReviewPackageTarget["status"], string> = {
    PASS: "Passed", FAIL: "Failed", ERROR: "Could not run", CANCELED: "Canceled",
    SKIPPED: "Not run", UNKNOWN: "Unknown", SAMPLED: "Sampled"
  };
  return labels[target.status];
}

function completenessLabel(target: ReviewPackageTarget): string {
  const evaluation = target.completeness.evaluation === "complete" ? "Complete evaluation"
    : target.completeness.evaluation === "sampled" ? "Sample only"
      : target.completeness.evaluation === "not-run" ? "Not run" : "Evaluation unknown";
  const details = target.completeness.issueDetails === "complete" ? "all issue details retained"
    : target.completeness.issueDetails === "limited" ? `${target.completeness.retainedIssues} of ${target.completeness.totalIssues} issue details retained`
      : "issue details not applicable";
  return `${evaluation}; ${details}`;
}

type ExplicitOutcome = Pick<CheckOutcome, "id" | "name" | "status" | "failed" | "passed" | "selected" | "groups">;

function outcomes(result: ValidationResult | undefined): ExplicitOutcome[] {
  if (!result) return [];
  const explicit = result.checkOutcomes;
  if (explicit?.length) return explicit;
  return [
    ...(result.ruleOutcomes ?? []).map(item => ({ ...item, status: item.failed > 0 ? "fail" as const : item.selected > 0 ? "pass" as const : "unknown" as const })),
    ...(result.groupOutcomes ?? []).map(item => ({ ...item, status: item.failed > 0 ? "fail" as const : item.groups > 0 ? "pass" as const : "unknown" as const }))
  ];
}

function issueId(issue: ValidationIssue): string {
  return issue.testId ?? (issue.column ? `${issue.column}.${issue.code.toLowerCase().replaceAll("_", "-")}` : issue.code);
}

function failedCheckIds(target: ReviewPackageTarget): Set<string> {
  const ids = new Set<string>();
  for (const outcome of outcomes(target.result)) if (outcome.status === "fail" || (outcome.failed ?? 0) > 0) ids.add(outcome.id);
  for (const issue of target.result?.issues ?? []) ids.add(issueId(issue));
  return ids;
}

function distinctEvidence(target: ReviewPackageTarget, evidenceMode: ValidationReviewPackage["evidence"]["mode"]): { rows: number | undefined; groups: number | undefined } {
  if (!target.result || evidenceMode === "aggregate-only") return { rows: undefined, groups: undefined };
  const rows = new Set<string>();
  const groups = new Set<string>();
  let hasRowEvidence = false;
  let hasGroupEvidence = false;
  for (const outcome of target.result.rowOutcomes ?? []) {
    if (outcome.status !== "fail") continue;
    if (outcome.row !== undefined || outcome.context?.identity) { hasRowEvidence = true; rows.add(JSON.stringify([outcome.row ?? null, outcome.context?.identity ?? {}])); }
    if (outcome.context?.group) { hasGroupEvidence = true; groups.add(JSON.stringify(Object.entries(outcome.context.group).sort(([a], [b]) => a.localeCompare(b)))); }
  }
  for (const issue of target.result.issues) {
    if (issue.group) { hasGroupEvidence = true; groups.add(JSON.stringify(Object.entries(issue.group).sort(([a], [b]) => a.localeCompare(b)))); }
    for (const sample of issue.evidence?.samples ?? []) {
      if (sample.primary) { hasRowEvidence = true; rows.add(JSON.stringify([sample.primary.label ?? "", sample.primary.row ?? null, sample.primary.values])); }
    }
  }
  if (!target.result.rowOutcomes?.length && target.completeness.issueDetails !== "complete") return { rows: undefined, groups: undefined };
  return { rows: hasRowEvidence ? rows.size : undefined, groups: hasGroupEvidence ? groups.size : undefined };
}

function ruleRows(target: ReviewPackageTarget): string {
  const byId = new Map<string, { name: string; issues: ValidationIssue[]; outcome?: ExplicitOutcome }>();
  for (const outcome of outcomes(target.result)) {
    if (outcome.status !== "fail" && !(outcome.failed && outcome.failed > 0)) continue;
    byId.set(outcome.id, { name: outcome.name ?? outcome.id, issues: [], outcome });
  }
  for (const issue of target.result?.issues ?? []) {
    const id = issueId(issue);
    const entry = byId.get(id) ?? { name: issue.title ?? id, issues: [] };
    entry.issues.push(issue);
    if (issue.title) entry.name = issue.title;
    byId.set(id, entry);
  }
  if (!byId.size) return `<p class="empty">No retained failed-check details are available for this target.</p>`;
  return [...byId.entries()].map(([id, item]) => {
    const first = item.issues[0];
    const failed = item.outcome?.failed;
    const count = failed === undefined ? "Failure count unavailable" : `${failed.toLocaleString()} failure event${failed === 1 ? "" : "s"}`;
    const description = first?.message ?? "This check did not meet its configured expectation.";
    const actualExpected = first && (first.actual !== undefined || first.expected !== undefined)
      ? `<dl class="actual"><div><dt>Actual</dt><dd>${escapeHtml(shown(first.actual))}</dd></div><div><dt>Expected</dt><dd>${escapeHtml(shown(first.expected))}</dd></div></dl>` : "";
    return `<article class="rule"><div><span class="tag fail">Failed check</span><h3>${escapeHtml(item.name)}</h3><p class="rule-id">${escapeHtml(id)}</p></div><p>${escapeHtml(description)}</p><p class="count">${escapeHtml(count)}. This is not a count of people or distinct records.</p>${actualExpected}</article>`;
  }).join("");
}

function targetSection(target: ReviewPackageTarget, evidenceMode: ValidationReviewPackage["evidence"]["mode"]): string {
  const distinct = distinctEvidence(target, evidenceMode);
  const failed = failedCheckIds(target).size;
  const missingEvidence = evidenceMode === "aggregate-only" ? "Not retained" : "Unavailable";
  return `<section class="target"><header><div><p class="eyebrow">Target</p><h2>${escapeHtml(target.target)}</h2></div><span class="tag ${escapeHtml(target.status.toLowerCase())}">${escapeHtml(statusLabel(target))}</span></header>
    <p class="completeness">${escapeHtml(completenessLabel(target))}</p>
    <div class="metrics"><div><strong>${failed}</strong><span>Failed checks</span></div><div><strong>${distinct.rows === undefined ? missingEvidence : distinct.rows}</strong><span>Distinct retained rows</span></div><div><strong>${distinct.groups === undefined ? missingEvidence : distinct.groups}</strong><span>Distinct retained groups</span></div><div><strong>${target.completeness.totalIssues}</strong><span>Issue events</span></div></div>
    ${target.error ? `<p class="notice">Run note: ${escapeHtml(target.error)}</p>` : ""}
    <div class="rules">${ruleRows(target)}</div></section>`;
}

/** Render a portable, offline, human-facing review report. The package must already be redacted. */
export function renderValidationReportHtml(reviewPackage: ValidationReviewPackage): string {
  const statusSummary = (["PASS", "FAIL", "ERROR", "CANCELED", "SKIPPED", "UNKNOWN", "SAMPLED"] as const)
    .filter(status => reviewPackage.summary.statuses[status] > 0)
    .map(status => `<li><strong>${reviewPackage.summary.statuses[status]}</strong> ${escapeHtml(status.toLowerCase())}</li>`).join("");
  const definitions = reviewPackage.provenance.definitions.length
    ? reviewPackage.provenance.definitions.map(item => `<tr><td>${escapeHtml(item.source)}</td><td>${escapeHtml(item.fingerprint)}</td></tr>`).join("")
    : `<tr><td colspan="2">No definition provenance was supplied.</td></tr>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Validation review</title><style>
  :root{color-scheme:light;--ink:#172033;--muted:#5d687c;--line:#d9dee8;--paper:#fff;--wash:#f4f6fa;--accent:#334e87;--bad:#9b1c31;--good:#17663a;--warn:#8a5b00}*{box-sizing:border-box}body{margin:0;background:var(--wash);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}main{max-width:1100px;margin:auto;padding:40px 24px 72px}.hero,.target,.appendix{background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:28px;margin-bottom:20px}h1,h2,h3{line-height:1.2;margin:.2em 0 .5em}h1{font-size:2.15rem}h2{font-size:1.4rem}.eyebrow,.rule-id{color:var(--muted);font-size:.8rem;letter-spacing:.06em;text-transform:uppercase}.lead,.completeness{color:var(--muted)}.status-list{display:flex;gap:10px;flex-wrap:wrap;padding:0;list-style:none}.status-list li,.tag{border-radius:999px;background:#eef1f7;padding:5px 10px}.tag{font-size:.78rem;font-weight:700;text-transform:uppercase;white-space:nowrap}.tag.fail,.tag.failed,.tag.error{background:#fae7eb;color:var(--bad)}.tag.pass,.tag.passed{background:#e4f3e9;color:var(--good)}.tag.sampled,.tag.unknown,.tag.canceled,.tag.skipped{background:#fff1cf;color:var(--warn)}.target>header{display:flex;justify-content:space-between;gap:20px;align-items:start}.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:20px 0}.metrics div{background:var(--wash);border-radius:10px;padding:14px}.metrics strong,.metrics span{display:block}.metrics strong{font-size:1.35rem}.metrics span{color:var(--muted);font-size:.85rem}.rule{border-top:1px solid var(--line);padding:20px 0}.rule:first-child{border-top:0}.rule h3{display:inline;margin-left:8px}.count,.empty,.notice{color:var(--muted)}.actual{display:grid;grid-template-columns:1fr 1fr;gap:10px}.actual div{background:var(--wash);padding:10px;border-radius:8px}.actual dt{color:var(--muted);font-size:.8rem}.actual dd{margin:2px 0;word-break:break-word}table{width:100%;border-collapse:collapse}th,td{text-align:left;border-bottom:1px solid var(--line);padding:9px;word-break:break-word}code{word-break:break-all}@media(max-width:700px){.metrics{grid-template-columns:1fr 1fr}.target>header{display:block}.actual{grid-template-columns:1fr}}
  </style></head><body><main><section class="hero"><p class="eyebrow">Validation review</p><h1>${escapeHtml(reviewPackage.source.reference)}</h1><p class="lead">A portable summary of what ran, what needs action, and what evidence was retained. Counts distinguish failed checks, issue events, rows, and groups; none should be interpreted as affected people.</p><ul class="status-list">${statusSummary || "<li>No target results</li>"}</ul><div class="metrics"><div><strong>${reviewPackage.summary.targets}</strong><span>Targets</span></div><div><strong>${reviewPackage.summary.rowsScanned}</strong><span>Rows scanned</span></div><div><strong>${reviewPackage.summary.issues}</strong><span>Issue events</span></div><div><strong>${reviewPackage.summary.retainedIssueDetails}</strong><span>Retained details</span></div></div><p class="notice">${reviewPackage.summary.errors.toLocaleString()} error finding${reviewPackage.summary.errors === 1 ? "" : "s"}; ${reviewPackage.summary.warnings.toLocaleString()} warning finding${reviewPackage.summary.warnings === 1 ? "" : "s"}. Evidence mode: ${escapeHtml(reviewPackage.evidence.mode)}. Evaluation ${reviewPackage.summary.evaluationComplete ? "is complete" : "is not complete"}; issue details ${reviewPackage.summary.issueDetailsComplete ? "are complete" : "are limited"}.</p></section>
  <section><p class="eyebrow">Actionable rules</p>${reviewPackage.targets.map(target => targetSection(target, reviewPackage.evidence.mode)).join("") || '<div class="target"><p class="empty">No targets are included in this package.</p></div>'}</section>
  <section class="appendix"><p class="eyebrow">Technical appendix</p><h2>Package and provenance</h2><table><tbody><tr><th>Package ID</th><td>${escapeHtml(reviewPackage.identity.packageId)}</td></tr><tr><th>Created UTC</th><td>${escapeHtml(reviewPackage.identity.createdAt)}</td></tr><tr><th>Tool</th><td>${escapeHtml(reviewPackage.tool.name)} ${escapeHtml(reviewPackage.tool.version)}</td></tr><tr><th>Source fingerprint</th><td><code>${escapeHtml(reviewPackage.source.fingerprint)}</code></td></tr><tr><th>Redacted fields</th><td>${reviewPackage.evidence.redactedFields}</td></tr></tbody></table><h3>Definitions</h3><table><thead><tr><th>Source</th><th>Fingerprint</th></tr></thead><tbody>${definitions}</tbody></table><p class="notice">Source references are displayed as text only. This standalone report contains no scripts, executable links, or external resources.</p></section></main></body></html>`;
}

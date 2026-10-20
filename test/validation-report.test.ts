import test from "node:test";
import assert from "node:assert/strict";
import { renderValidationReportHtml } from "../src/validation-report";
import { VALIDATION_REVIEW_PACKAGE_SCHEMA, type ValidationReviewPackage } from "../src/core/review-package";

function reviewPackage(): ValidationReviewPackage {
  return {
    schema: VALIDATION_REVIEW_PACKAGE_SCHEMA,
    identity: { packageId: 'review-<script>alert("id")</script>', createdAt: "2026-10-12T12:00:00.000Z" },
    tool: { name: "Validation Workbench", version: "1.0" },
    source: { reference: 'report & <img src=x onerror="alert(1)">', fingerprint: "fnv1a64-test" },
    provenance: { definitions: [{ source: "contract.validation.yaml", fingerprint: "fnv1a64-definition" }] },
    evidence: { mode: "detail", detailsIncluded: true, redactedFields: 2 },
    summary: { targets: 2, statuses: { PASS: 0, FAIL: 1, ERROR: 0, CANCELED: 0, SKIPPED: 0, UNKNOWN: 0, SAMPLED: 1 }, rowsScanned: 12, issues: 3, errors: 2, warnings: 1, retainedIssueDetails: 2, issueDetailsComplete: false, evaluationComplete: false },
    targets: [{
      target: "server.database.dbo.Source", status: "FAIL", verdict: "fail",
      definitionFingerprints: ["fnv1a64-definition"], coverage: { pass: 0, fail: 1, notApplicable: 0, notEvaluated: 0, unknown: 0 },
      completeness: { evaluation: "complete", issueDetails: "complete", totalIssues: 2, retainedIssues: 2 },
      result: {
        valid: false, rowCount: 10, columnCount: 2, testCount: 1, issueCount: 2, errorCount: 2, warningCount: 0, truncated: false,
        ruleOutcomes: [{ id: "active-status", name: "Active status required", selected: 10, passed: 8, failed: 2 }],
        issues: [{ level: "row", code: "RULE_FAILED", testId: "active-status", title: "Active status required", message: '<b onclick="x">Set status to Active.</b>', actual: "Inactive", expected: "Active", group: { Region: "West" }, evidence: { samples: [{ primary: { label: "source", row: 2, values: { Id: "[redacted]" } } }] } }]
      }
    }, {
      target: "sample.csv", status: "SAMPLED", verdict: "not-assessed",
      definitionFingerprints: ["fnv1a64-definition"], coverage: { pass: 0, fail: 0, notApplicable: 0, notEvaluated: 0, unknown: 1 },
      completeness: { evaluation: "sampled", issueDetails: "limited", totalIssues: 1, retainedIssues: 0 }
    }]
  };
}

test("standalone validation report is escaped, actionable, and explicit about count meanings", () => {
  const html = renderValidationReportHtml(reviewPackage());
  assert.match(html, /^<!doctype html>/);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<img/i);
  assert.doesNotMatch(html, /<[^>]+onclick=/i);
  assert.doesNotMatch(html, /<a\b/i);
  assert.match(html, /report &amp; &lt;img/);
  assert.match(html, /&lt;b onclick=&quot;x&quot;&gt;/);
  assert.match(html, /Active status required/);
  assert.match(html, /Actual/);
  assert.match(html, /Inactive/);
  assert.match(html, /Expected/);
  assert.match(html, /This is not a count of people or distinct records/);
  assert.match(html, /Distinct retained rows/);
  assert.match(html, /Distinct retained groups/);
  assert.match(html, /Sample only/);
  assert.match(html, /no scripts, executable links, or external resources/);
});

test("standalone validation report handles an empty unknown package", () => {
  const input = reviewPackage();
  input.targets = [];
  input.summary = { ...input.summary, targets: 0, rowsScanned: 0, issues: 0, retainedIssueDetails: 0, statuses: { PASS: 0, FAIL: 0, ERROR: 0, CANCELED: 0, SKIPPED: 0, UNKNOWN: 0, SAMPLED: 0 } };
  const html = renderValidationReportHtml(input);
  assert.match(html, /No target results/);
  assert.match(html, /No targets are included/);
});

test("aggregate-only reports do not imply zero retained rows or groups", () => {
  const input = reviewPackage();
  input.evidence = { mode: "aggregate-only", detailsIncluded: false, redactedFields: 8 };
  input.targets[0].result!.issues[0].evidence = { samples: [] };
  input.targets[0].result!.ruleOutcomes = [{ id: "not-selected", selected: 0, passed: 0, failed: 0 }];
  const html = renderValidationReportHtml(input);
  assert.match(html, /<strong>Not retained<\/strong><span>Distinct retained rows/);
  assert.match(html, /<strong>Not retained<\/strong><span>Distinct retained groups/);
  assert.doesNotMatch(html, /<strong>0<\/strong><span>Distinct retained (?:rows|groups)/);
});

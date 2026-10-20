import test from "node:test";
import assert from "node:assert/strict";
import type { ValidationIssue, ValidationResult } from "../src/core/model";
import { compareValidationReviewPackages } from "../src/core/review-diff";
import { createValidationReviewPackage, parseValidationReviewPackage, type ValidationReviewPackage } from "../src/core/review-package";
import { renderReviewDiffHtml } from "../src/review-diff-report";

function issue(ruleId: string | undefined, code = "RULE_FAILED", row = 2): ValidationIssue {
  return {
    level: "row",
    code,
    ...(ruleId ? { testId: ruleId } : {}),
    row,
    message: `Failure for ${ruleId ?? "unknown rule"}.`
  };
}

function result(issues: ValidationIssue[], options: { sampled?: boolean; truncated?: boolean; issueCount?: number; incompleteCoverage?: boolean } = {}): ValidationResult {
  return {
    ...(options.sampled ? { preview: { scope: "sample", rowLimit: 10, exampleLimit: 5 } as const } : {}),
    valid: issues.length === 0,
    rowCount: 10,
    columnCount: 2,
    testCount: 3,
    issueCount: options.issueCount ?? issues.length,
    errorCount: options.issueCount ?? issues.length,
    warningCount: 0,
    truncated: options.truncated ?? false,
    ...(options.incompleteCoverage ? { checkOutcomes: [
      { id: "known", kind: "row-rule" as const, status: "fail" as const, selected: 1, passed: 0, failed: 1 },
      { id: "unassessed", kind: "row-rule" as const, status: "not-evaluated" as const, selected: 0, passed: 0, failed: 0 }
    ] } : {}),
    issues
  };
}

function pkg(
  packageId: string,
  issues: ValidationIssue[],
  options: {
    definition?: string;
    target?: string;
    workId?: string;
    scope?: string;
    sampled?: boolean;
    truncated?: boolean;
    issueCount?: number;
    incompleteCoverage?: boolean;
  } = {}
): ValidationReviewPackage {
  return createValidationReviewPackage({
    source: "contracts/customer.csvtest.yaml",
    packageId,
    createdAt: packageId === "before" ? "2026-01-01T00:00:00Z" : "2026-01-02T00:00:00Z",
    definitions: [{ source: "contracts/customer.csvtest.yaml", text: options.definition ?? "version: 1\nrules: stable\n" }],
    runs: [{
      target: options.target ?? "data/customer.csv",
      ...(options.workId === "missing" ? {} : { workId: options.workId ?? "customer-validation" }),
      ...(options.scope === "missing" ? {} : { scope: options.scope ?? "all-rows" }),
      result: result(issues, options)
    }]
  });
}

test("reordered issues compare by stable workId, target, and ruleId", () => {
  const before = pkg("before", [issue("alpha", "RULE_FAILED", 2), issue("beta", "CELL_FAILED", 3)]);
  const after = pkg("after", [issue("beta", "CELL_FAILED", 9), issue("alpha", "RULE_FAILED", 8)]);
  const diff = compareValidationReviewPackages(before, after);

  assert.equal(diff.summary.comparableTargets, 1);
  assert.deepEqual(diff.persistentFailures.map(item => item.identity.ruleId), ["alpha", "beta"]);
  assert.equal(diff.newFailures.length, 0);
  assert.equal(diff.resolvedFailures.length, 0);
  assert.equal(diff.indeterminate.length, 0);
});

test("reports new, resolved, and persistent failures with full counts", () => {
  const before = pkg("before", [issue("resolved"), issue("persistent", "RULE_FAILED", 2), issue("persistent", "RULE_FAILED", 3)]);
  const after = pkg("after", [issue("new"), issue("persistent", "RULE_FAILED", 7)]);
  const diff = compareValidationReviewPackages(before, after);

  assert.deepEqual(diff.newFailures.map(item => [item.identity.ruleId, item.beforeFindingEvents, item.afterFindingEvents]), [["new", 0, 1]]);
  assert.deepEqual(diff.resolvedFailures.map(item => [item.identity.ruleId, item.beforeFindingEvents, item.afterFindingEvents]), [["resolved", 1, 0]]);
  assert.deepEqual(diff.persistentFailures.map(item => [item.identity.ruleId, item.beforeFindingEvents, item.afterFindingEvents, item.findingEventDelta]), [["persistent", 2, 1, -1]]);
  assert.deepEqual(diff.summary, {
    comparableTargets: 1,
    newRules: 1,
    resolvedRules: 1,
    persistentRules: 1,
    beforeFindingEvents: 3,
    afterFindingEvents: 2,
    indeterminateItems: 0
  });
});

test("duplicate occurrences of one rule ID remain one persistent rule with changed counts", () => {
  const before = pkg("before", [issue("duplicate", "RULE_FAILED", 2), issue("duplicate", "RULE_FAILED", 3)]);
  const after = pkg("after", [issue("duplicate", "RULE_FAILED", 4)]);
  const diff = compareValidationReviewPackages(before, after);

  assert.equal(diff.persistentFailures.length, 1);
  assert.deepEqual([diff.persistentFailures[0].beforeFindingEvents, diff.persistentFailures[0].afterFindingEvents], [2, 1]);
  assert.equal(diff.resolvedFailures.length, 0);
});

test("different definitions make the whole comparison indeterminate", () => {
  const diff = compareValidationReviewPackages(pkg("before", [issue("old")]), pkg("after", [], { definition: "version: 1\nrules: changed\n" }));
  assert.equal(diff.definitionsMatch, false);
  assert.equal(diff.resolvedFailures.length, 0);
  assert.equal(diff.indeterminate[0].reason, "definitions-changed");
});

test("swapped effective definitions are indeterminate even when the global set matches", () => {
  const before = pkg("before", [issue("old")]);
  const after = pkg("after", []);
  const alternate = { source: "contracts/alternate.csvtest.yaml", fingerprint: "fnv1a64-alternate" };
  before.provenance.definitions.push(alternate);
  after.provenance.definitions.push(alternate);
  after.targets[0].definitionFingerprints = [alternate.fingerprint];

  const diff = compareValidationReviewPackages(before, after);
  assert.equal(diff.definitionsMatch, true);
  assert.equal(diff.resolvedFailures.length, 0);
  assert.equal(diff.indeterminate[0].reason, "target-definitions-changed");
});

test("unknown package versions are rejected by the parser", () => {
  assert.throws(
    () => parseValidationReviewPackage(JSON.stringify({ schema: "incursa.validation-review-package/v2" })),
    /Unsupported review package schema/
  );
});

test("sampled and truncated scans cannot create false passes or resolutions", () => {
  const sampled = compareValidationReviewPackages(pkg("before", [issue("open")]), pkg("after", [], { sampled: true }));
  assert.equal(sampled.resolvedFailures.length, 0);
  assert.equal(sampled.indeterminate[0].reason, "evaluation-incomplete");

  const truncated = compareValidationReviewPackages(
    pkg("before", [issue("open")]),
    pkg("after", [], { truncated: true, issueCount: 4 })
  );
  assert.equal(truncated.resolvedFailures.length, 0);
  assert.equal(truncated.summary.afterFindingEvents, 0);
  assert.equal(truncated.indeterminate[0].reason, "issue-details-incomplete");
  assert.equal(truncated.indeterminate[0].afterIssueEvents, 4);
});

test("a failing run with unassessed checks cannot prove rule changes", () => {
  const diff = compareValidationReviewPackages(
    pkg("before", [issue("known")], { incompleteCoverage: true }),
    pkg("after", [])
  );
  assert.equal(diff.resolvedFailures.length, 0);
  assert.equal(diff.indeterminate[0].reason, "evaluation-incomplete");
});

test("target and scope changes are indeterminate rather than new or resolved", () => {
  const targetChanged = compareValidationReviewPackages(pkg("before", [issue("old")]), pkg("after", [], { target: "data/customer-v2.csv" }));
  assert.equal(targetChanged.newFailures.length + targetChanged.resolvedFailures.length, 0);
  assert.ok(targetChanged.indeterminate.every(item => item.reason === "target-changed"));

  const scopeChanged = compareValidationReviewPackages(pkg("before", [issue("old")]), pkg("after", [], { scope: "region=west" }));
  assert.equal(scopeChanged.resolvedFailures.length, 0);
  assert.equal(scopeChanged.indeterminate[0].reason, "scope-changed");
});

test("missing stable identifiers prevent classification", () => {
  const missingWork = compareValidationReviewPackages(pkg("before", [issue("open")]), pkg("after", [], { workId: "missing" }));
  assert.equal(missingWork.resolvedFailures.length, 0);
  assert.ok(missingWork.indeterminate.some(item => item.reason === "work-id-missing"));

  const missingRule = compareValidationReviewPackages(pkg("before", [issue(undefined)]), pkg("after", []));
  assert.equal(missingRule.resolvedFailures.length, 0);
  assert.equal(missingRule.indeterminate[0].reason, "rule-id-missing");

  const missingScope = compareValidationReviewPackages(pkg("before", [issue("open")]), pkg("after", [], { scope: "missing" }));
  assert.equal(missingScope.resolvedFailures.length, 0);
  assert.equal(missingScope.indeterminate[0].reason, "scope-missing");
});

test("duplicate target identities and ambiguous duplicate rule IDs do not false-resolve", () => {
  const before = pkg("before", [issue("open")]);
  before.targets.push(structuredClone(before.targets[0]));
  const duplicateTarget = compareValidationReviewPackages(before, pkg("after", []));
  assert.equal(duplicateTarget.resolvedFailures.length, 0);
  assert.equal(duplicateTarget.indeterminate[0].reason, "target-identity-duplicate");

  const ambiguousRule = compareValidationReviewPackages(
    pkg("before", [issue("duplicate", "RULE_FAILED"), issue("duplicate", "CELL_FAILED")]),
    pkg("after", [])
  );
  assert.equal(ambiguousRule.resolvedFailures.length, 0);
  assert.equal(ambiguousRule.indeterminate[0].reason, "rule-id-ambiguous");
});

test("a complete pass resolves a known prior failure", () => {
  const diff = compareValidationReviewPackages(pkg("before", [issue("fixed")]), pkg("after", []));
  assert.equal(diff.resolvedFailures.length, 1);
  assert.equal(diff.resolvedFailures[0].identity.ruleId, "fixed");
  assert.equal(diff.indeterminate.length, 0);
});

test("human report is standalone, script-free, and labels event counts honestly", () => {
  const diff = compareValidationReviewPackages(
    pkg("before", [issue("persistent"), issue("persistent", "RULE_FAILED", 3)]),
    pkg("after", [issue("persistent")])
  );
  diff.before.packageId = '<script>alert("package")</script>';
  diff.persistentFailures[0].finding.message = '<img src=x onerror="alert(1)">';
  const html = renderReviewDiffHtml(diff);

  assert.match(html, /^<!doctype html>/);
  assert.match(html, /Content-Security-Policy/);
  assert.doesNotMatch(html, /<script[\s>]/i);
  assert.doesNotMatch(html, /<img src=x/i);
  assert.match(html, /&lt;script&gt;alert\(&quot;package&quot;\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /finding events are complete saved issue-object counts, not estimates of impacted source records/i);
  assert.match(html, />2 → 1</);
  assert.match(html, /Persistent failures/);
});

test("human report renders indeterminate evidence without implying resolution", () => {
  const diff = compareValidationReviewPackages(pkg("before", [issue("open")]), pkg("after", [], { sampled: true }));
  const html = renderReviewDiffHtml(diff);

  assert.match(html, /evaluation-incomplete/);
  assert.match(html, /sampled, not run, or otherwise not completely evaluated/);
  assert.match(html, /<h2>Resolved failures<\/h2><p class="empty">None\.<\/p>/);
});

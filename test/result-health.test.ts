import test from "node:test";
import assert from "node:assert/strict";
import { aggregateResultHealth, resultHealth, resultHealthCategory, resultHealthTitle } from "../src/core/result-health";
import type { ValidationResult } from "../src/core/model";

const result = (values: Partial<ValidationResult> = {}): ValidationResult => ({
  valid: true, rowCount: 1000, columnCount: 4, testCount: 20, issueCount: 0,
  errorCount: 0, warningCount: 0, truncated: false, issues: [], ...values
});

test("graded health reserves perfect green for a completely clean result", () => {
  assert.deepEqual(resultHealth(result(), "PASS", "graded"), { score: 100, band: "perfect", label: "PASS" });
  const minor = resultHealth(result({ valid: false, issueCount: 1, errorCount: 1,
    issues: [{ level: "row", code: "VALUE_INVALID", testId: "value-valid", message: "Review this value." }] }), "FAIL", "graded");
  assert.ok(minor.score < 100);
  assert.notEqual(minor.band, "perfect");
  assert.equal(resultHealthCategory(minor), "Limited impact");
  assert.match(resultHealthTitle(minor), /Health score \d+\/100/);
});

test("graded health distinguishes warnings, widespread failures, and execution errors", () => {
  const warning = resultHealth(result({ issueCount: 1, warningCount: 1,
    issues: [{ level: "row", code: "VALUE_REVIEW", testId: "value-review", severity: "warning", message: "Review this value." }] }), "PASS", "graded");
  const widespreadResult = result({ valid: false, issueCount: 900, errorCount: 900,
    issues: [{ level: "row", code: "VALUE_INVALID", testId: "value-valid", message: "Review this value." }] });
  const widespread = resultHealth(widespreadResult, "FAIL", "graded");
  assert.ok(warning.score > widespread.score);
  assert.deepEqual(resultHealth(undefined, "ERROR", "graded"), { score: 0, band: "critical", label: "ERROR" });
  assert.equal(aggregateResultHealth([{ result: result() }, { result: widespreadResult }], "binary").score, 0);
});

test("importance changes graded impact without changing validation semantics", () => {
  const issue = (testId: string, importance?: number) => ({
    level: "row" as const, code: "RULE_FAILED", testId, message: "failed", ...(importance === undefined ? {} : { importance })
  });
  const minor = result({ valid: false, issueCount: 1, errorCount: 1, issues: [issue("email-lowercase", 0.25)] });
  const major = result({ valid: false, issueCount: 1, errorCount: 1, issues: [issue("required-email", 1)] });
  assert.equal(minor.valid, major.valid);
  assert.ok(resultHealth(minor, "FAIL", "graded").score > resultHealth(major, "FAIL", "graded").score);
  assert.equal(resultHealth(result({ valid: false, issueCount: 1, errorCount: 1, issues: [issue("default-weight")] }), "FAIL", "graded").score,
    resultHealth(major, "FAIL", "graded").score);
  const combined = result({ valid: false, issueCount: 2, errorCount: 2, issues: [issue("email-lowercase", 0.25), issue("required-email", 1)] });
  assert.ok(resultHealth(combined, "FAIL", "graded").score < resultHealth(minor, "FAIL", "graded").score);
});

test("graded health uses configured outcome importance when no finding carries the weight", () => {
  const minor = result({ valid: false, ruleOutcomes: [{ id: "email-lowercase", selected: 1, passed: 0, failed: 1, importance: 0.25 }] });
  const major = result({ valid: false, ruleOutcomes: [{ id: "required-data", selected: 1, passed: 0, failed: 1, importance: 1 }] });
  assert.ok(resultHealth(minor, "FAIL", "graded").score > resultHealth(major, "FAIL", "graded").score);
});

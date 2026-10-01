import test from "node:test";
import assert from "node:assert/strict";
import { aggregateResultHealth, resultHealth } from "../src/core/result-health";
import type { ValidationResult } from "../src/core/model";

const result = (values: Partial<ValidationResult> = {}): ValidationResult => ({
  valid: true, rowCount: 1000, columnCount: 4, testCount: 20, issueCount: 0,
  errorCount: 0, warningCount: 0, truncated: false, issues: [], ...values
});

test("graded health reserves perfect green for a completely clean result", () => {
  assert.deepEqual(resultHealth(result(), "PASS", "graded"), { score: 100, band: "perfect", label: "PASS" });
  const minor = resultHealth(result({ valid: false, issueCount: 1, errorCount: 1,
    issues: [{ level: "row", code: "VALUE_INVALID", testId: "value-valid", message: "Review this value." }] }), "FAIL", "graded");
  assert.ok(minor.score <= 85);
  assert.notEqual(minor.band, "perfect");
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

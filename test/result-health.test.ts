import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateResultHealth, resultHealth, resultHealthCategory, resultHealthTitle,
  validateResultImportance, weightedCheckFailureRate
} from "../src/core/result-health";
import type { ValidationResult } from "../src/core/model";
import { parseContract } from "../src/core/contract";

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
  assert.match(resultHealthTitle(minor), /Health heuristic score \d+\/100/);
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

test("zero importance can reduce graded impact to zero without hiding failure status", () => {
  const failed = result({ valid: false, issueCount: 1, errorCount: 1, issues: [
    { level: "row", code: "RULE_FAILED", testId: "informational-check", message: "failed", importance: 0 }
  ] });
  const health = resultHealth(failed, "FAIL", "graded");
  assert.equal(failed.valid, false);
  assert.equal(health.label, "FAIL");
  assert.equal(health.score, 99);
  assert.notEqual(health.band, "perfect");
});

test("graded health uses configured outcome importance when no finding carries the weight", () => {
  const minor = result({ valid: false, ruleOutcomes: [{ id: "email-lowercase", selected: 1, passed: 0, failed: 1, importance: 0.25 }] });
  const major = result({ valid: false, ruleOutcomes: [{ id: "required-data", selected: 1, passed: 0, failed: 1, importance: 1 }] });
  assert.ok(resultHealth(minor, "FAIL", "graded").score > resultHealth(major, "FAIL", "graded").score);
});

test("outcome importance remains authoritative when a finding omits the optional weight", () => {
  const weighted = result({ valid: false, issueCount: 1, errorCount: 1,
    issues: [{ level: "row", code: "RULE_FAILED", testId: "email-lowercase", message: "failed" }],
    ruleOutcomes: [{ id: "email-lowercase", selected: 1, passed: 0, failed: 1, importance: 0.25 }] });
  const defaulted = result({ valid: false, issueCount: 1, errorCount: 1,
    issues: [{ level: "row", code: "RULE_FAILED", testId: "email-lowercase", message: "failed" }] });
  assert.ok(resultHealth(weighted, "FAIL", "graded").score > resultHealth(defaulted, "FAIL", "graded").score);
});

test("graded health aggregates multiple failures with different weights", () => {
  const minor = result({ valid: false, issueCount: 2, errorCount: 2, issues: [
    { level: "row", code: "RULE_FAILED", testId: "email-lowercase", message: "failed", importance: 0.25 },
    { level: "row", code: "RULE_FAILED", testId: "email-lowercase", message: "failed", importance: 0.25 }
  ] });
  const mixed = result({ valid: false, issueCount: 2, errorCount: 2, issues: [
    { level: "row", code: "RULE_FAILED", testId: "email-lowercase", message: "failed", importance: 0.25 },
    { level: "row", code: "RULE_FAILED", testId: "required-data", message: "failed", importance: 1 }
  ] });
  assert.ok(resultHealth(minor, "FAIL", "graded").score > resultHealth(mixed, "FAIL", "graded").score);
});

test("importance is opt-in and leaves legacy scores unchanged when absent", () => {
  const legacy = result({ valid: false, issueCount: 1, errorCount: 1,
    issues: [{ level: "row", code: "VALUE_INVALID", testId: "failed", message: "Review this value." }],
    checkOutcomes: [{ id: "failed", status: "fail" }, { id: "passed", status: "pass" }] });
  const withoutOutcomeMetadata = result({ ...legacy, checkOutcomes: undefined });
  assert.deepEqual(resultHealth(legacy, "FAIL", "graded"), resultHealth(withoutOutcomeMetadata, "FAIL", "graded"));
});

test("a more important failing rule has monotonically greater heuristic impact", () => {
  const failure = result({ valid: false, issueCount: 1, errorCount: 1,
    issues: [{ level: "row", code: "VALUE_INVALID", testId: "failed", message: "Review this value." }],
    checkOutcomes: [{ id: "failed", status: "fail" }, { id: "passed", status: "pass" }] });
  const ordinary = resultHealth(failure, "FAIL", "graded", { importanceByCheckId: { failed: 1, passed: 1 } });
  const important = resultHealth(failure, "FAIL", "graded", { importanceByCheckId: { failed: 5, passed: 1 } });
  assert.ok(important.score < ordinary.score);
  assert.deepEqual(weightedCheckFailureRate(failure, { importanceByCheckId: { failed: 5, passed: 1 } }),
    { rate: 5 / 6, failedWeight: 5, evaluatedWeight: 6 });
});

test("importance preserves warning severity", () => {
  const warning = result({ issueCount: 1, warningCount: 1,
    issues: [{ level: "row", code: "VALUE_REVIEW", testId: "warning", severity: "warning", message: "Review this value." }],
    checkOutcomes: [{ id: "warning", status: "fail" }, { id: "passed", status: "pass" }] });
  const error = result({ ...warning, valid: false, warningCount: 0, errorCount: 1,
    issues: [{ level: "row", code: "VALUE_INVALID", testId: "warning", message: "Review this value." }] });
  const options = { importanceByCheckId: { warning: 5, passed: 1 } };
  assert.ok(resultHealth(warning, "PASS", "graded", options).score > resultHealth(error, "FAIL", "graded", options).score);
});

test("sampled, indeterminate, and denominator-free weighted health are unavailable", () => {
  const options = { importanceByCheckId: { check: 2 } };
  const sampled = result({ preview: { scope: "sample", rowLimit: 10, exampleLimit: 5 }, checkOutcomes: [{ id: "check", status: "pass" }] });
  const unknown = result({ checkOutcomes: [{ id: "check", status: "unknown" }] });
  const notApplicable = result({ checkOutcomes: [{ id: "check", status: "not-applicable" }] });
  for (const health of [resultHealth(sampled, "PASS", "graded", options), resultHealth(unknown, "PASS", "graded", options),
    resultHealth(notApplicable, "PASS", "graded", options)]) {
    assert.equal(health.available, false);
    assert.equal(resultHealthCategory(health), "Health unavailable");
    assert.doesNotMatch(resultHealthTitle(health), /score/);
  }
});

test("an explicitly incomplete outcome inventory cannot produce weighted health", () => {
  const incomplete = result({
    checkOutcomes: [{ id: "check", status: "pass" }],
    outcomeRetention: {
      limit: 10, retained: 1, dropped: 1, truncated: true,
      counts: { pass: 1, fail: 0, "not-applicable": 0, "not-evaluated": 0, unknown: 0 },
      evaluationComplete: false
    }
  });
  const health = resultHealth(incomplete, "PASS", "graded", { importanceByCheckId: { check: 2 } });
  assert.equal(health.available, false);
  assert.equal(health.reason, "incomplete-evaluation");

  const detailLimited = result({ ...incomplete,
    outcomeRetention: { ...incomplete.outcomeRetention!, evaluationComplete: true }
  });
  assert.deepEqual(resultHealth(detailLimited, "PASS", "graded", { importanceByCheckId: { check: 2 } }),
    { score: 100, band: "perfect", label: "PASS" });
});

test("importance must be finite, positive, and bounded", () => {
  assert.equal(validateResultImportance(0.1), 0.1);
  assert.equal(validateResultImportance(10), 10);
  for (const value of [0, -1, 10.1, Number.NaN, Number.POSITIVE_INFINITY, "2"]) {
    assert.throws(() => validateResultImportance(value), /finite number from 0\.1 through 10/);
  }
});

test("ordered relationship importance is accepted and range-checked by the contract schema", () => {
  const definition = (importance: number) => JSON.stringify({
    version: 1, schema: { columns: { Event: { presence: "required" }, Sequence: { presence: "required" } } },
    orderedRules: [{ id: "events", orderBy: [{ column: "Sequence", type: "number" }], relations: [{
      id: "requires-prior", message: "A finish needs a start", importance,
      when: { column: "Event", operator: "equals", value: "finish" }, requirePrior: { column: "Event", operator: "equals", value: "start" }
    }] }]
  });
  assert.equal(parseContract(definition(3)).orderedRules![0].relations![0].importance, 3);
  assert.throws(() => parseContract(definition(11)), /importance|maximum/);
});

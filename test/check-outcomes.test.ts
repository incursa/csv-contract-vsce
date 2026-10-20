import { test } from "node:test";
import assert from "node:assert/strict";
import { CheckOutcomeCollector, outcomeContext } from "../src/core/check-outcomes";
import { attachCheckOutcomes } from "../src/core/evaluation";
import { validateCsv } from "../src/core/contract";
import type { CsvContract, ValidationResult } from "../src/core/model";

function result(partial: Partial<ValidationResult> = {}): ValidationResult {
  return {
    valid: true, rowCount: 0, columnCount: 1, testCount: 1, issueCount: 0,
    errorCount: 0, warningCount: 0, truncated: false, issues: [], ...partial
  };
}

test("conditional checks explicitly report not-applicable instead of inferred pass", () => {
  const contract: CsvContract = {
    version: 1,
    schema: { columns: { Status: { presence: "required" } } },
    rules: [{ id: "ready-only", when: { column: "Status", operator: "equals", value: "Ready" },
      expect: { column: "Status", operator: "notBlank" } }]
  };
  const legacy = result({ rowCount: 2, ruleOutcomes: [{ id: "ready-only", selected: 0, passed: 0, failed: 0 }] });
  const explicit = attachCheckOutcomes(contract, legacy);
  assert.deepEqual(explicit.checkOutcomes, [{
    id: "ready-only", kind: "row-rule", status: "not-applicable", selected: 0, passed: 0, failed: 0,
    notApplicable: 1, notEvaluated: 0, unknown: 0, rowDetailStatus: "unknown", reason: "aggregate-only"
  }]);
  assert.equal(explicit.valid, legacy.valid);
  assert.equal(explicit.issueCount, legacy.issueCount);
  assert.equal(explicit.testCount, legacy.testCount);
  assert.deepEqual(explicit.ruleOutcomes, legacy.ruleOutcomes);
});

test("a check blocked by an absent optional column is not reported as passing", () => {
  const contract: CsvContract = {
    version: 1,
    schema: { columns: { Id: { presence: "required" }, Optional: { presence: "optional" } } },
    rules: [{ id: "optional-check", expect: { column: "Optional", operator: "notBlank" } }]
  };
  const legacy = result({ valid: false, rowCount: 1, issueCount: 1, errorCount: 1, issues: [{
    level: "row", code: "RULE_COLUMN_MISSING", message: "Optional is absent.", column: "Optional", testId: "optional-check"
  }] });
  const explicit = attachCheckOutcomes(contract, legacy);
  assert.equal(explicit.checkOutcomes?.[0].status, "not-evaluated");
  assert.equal(explicit.checkOutcomes?.[0].passed, 0);
  assert.equal(explicit.checkOutcomes?.[0].reason, "rule-column-missing");
  assert.deepEqual({ valid: explicit.valid, issueCount: explicit.issueCount, errorCount: explicit.errorCount },
    { valid: legacy.valid, issueCount: legacy.issueCount, errorCount: legacy.errorCount });
});

test("fail-fast and bounded retention account for unevaluated and dropped records", () => {
  const collector = new CheckOutcomeCollector([
    { id: "first", kind: "row-rule" }, { id: "second", kind: "row-rule" }
  ], 1);
  collector.record({ checkId: "first", kind: "row-rule", status: "fail", row: 4 });
  collector.record({ checkId: "first", kind: "row-rule", status: "pass", row: 5 });
  collector.record({ checkId: "first", kind: "row-rule", status: "not-applicable", row: 6 });
  const finished = collector.finish({ complete: false, reason: "fail-fast" });
  assert.equal(finished.checkOutcomes.find(item => item.id === "first")?.status, "fail");
  assert.equal(finished.checkOutcomes.find(item => item.id === "first")?.rowDetailStatus, "unknown");
  assert.equal(finished.checkOutcomes.find(item => item.id === "first")?.reason, "retention-limit");
  assert.deepEqual(finished.checkOutcomes.find(item => item.id === "second"), {
    id: "second", kind: "row-rule", status: "not-evaluated", selected: 0, passed: 0, failed: 0,
    notApplicable: 0, notEvaluated: 1, unknown: 0, rowDetailStatus: "not-evaluated", reason: "fail-fast"
  });
  assert.deepEqual(finished.outcomeRetention, {
    limit: 1, retained: 1, dropped: 2, truncated: true,
    evaluationComplete: false, reason: "fail-fast",
    counts: { pass: 1, fail: 1, "not-applicable": 1, "not-evaluated": 0, unknown: 0 }
  });
});

test("aggregate-only SQL results make unavailable row detail explicit", () => {
  const contract: CsvContract = {
    version: 1,
    schema: { columns: { Id: { presence: "required" } } },
    sqlServer: { schema: "dbo", table: "People", conditionalRules: [{
      id: "known-id", expect: { column: "Id", operator: "notBlank" }
    }] }
  };
  const explicit = attachCheckOutcomes(contract, result({
    rowCount: 12, ruleOutcomes: [{ id: "known-id", selected: 12, passed: 12, failed: 0 }]
  }));
  assert.equal(explicit.checkOutcomes?.[0].status, "pass");
  assert.equal(explicit.checkOutcomes?.[0].rowDetailStatus, "unknown");
  assert.equal(explicit.rowOutcomes?.length, 0);
});

test("partial execution remains explicit even when every observed aggregate passed", () => {
  const contract: CsvContract = {
    version: 1,
    schema: { columns: { Id: { presence: "required" } } },
    rules: [{ id: "id", expect: { column: "Id", operator: "notBlank" } }]
  };
  const explicit = attachCheckOutcomes(contract, result({
    ruleOutcomes: [{ id: "id", selected: 1, passed: 1, failed: 0 }]
  }), { evaluationComplete: false, incompleteReason: "fail-fast" });
  assert.equal(explicit.checkOutcomes?.[0].status, "pass");
  assert.equal(explicit.outcomeRetention?.evaluationComplete, false);
  assert.equal(explicit.outcomeRetention?.reason, "fail-fast");
});

test("failure context has deterministic identity, aggregate and related-row trace", () => {
  assert.deepEqual(outcomeContext({
    identity: { Id: "A" }, group: { Batch: "B" }, relatedRows: [9, 3, 9], aggregate: { count: 2 }
  }), {
    identity: { Id: "A" }, group: { Batch: "B" }, relatedRows: [3, 9], aggregate: { count: 2 }
  });
});

test("retention limits are validated before evaluation", () => {
  assert.throws(() => new CheckOutcomeCollector([], -1), /retention/);
  assert.throws(() => new CheckOutcomeCollector([], 10001), /retention/);
});

test("normal CSV evaluation retains explicit pass, fail and conditional skip rows", () => {
  const contract: CsvContract = {
    version: 1,
    identity: { columns: ["Id"] },
    schema: { columns: { Id: { presence: "required" }, Status: { presence: "required" } } },
    rules: [{ id: "ready", when: { column: "Status", operator: "notEquals", value: "Skip" },
      expect: { column: "Status", operator: "equals", value: "Ready" } }]
  };
  const evaluated = validateCsv(contract, "Id,Status\nA,Ready\nB,Waiting\nC,Skip\n");
  assert.deepEqual(evaluated.ruleOutcomes, [{ id: "ready", selected: 2, passed: 1, failed: 1 }]);
  assert.deepEqual(evaluated.checkOutcomes?.map(item => ({ id: item.id, status: item.status,
    selected: item.selected, passed: item.passed, failed: item.failed, notApplicable: item.notApplicable })), [{
    id: "ready", status: "fail", selected: 2, passed: 1, failed: 1, notApplicable: 1
  }]);
  assert.deepEqual(evaluated.rowOutcomes?.map(item => ({ status: item.status, row: item.row, identity: item.context?.identity })), [
    { status: "pass", row: 2, identity: { Id: "A" } },
    { status: "fail", row: 3, identity: { Id: "B" } },
    { status: "not-applicable", row: 4, identity: { Id: "C" } }
  ]);
  assert.equal(evaluated.issueCount, 1);
  assert.equal(evaluated.errorCount, 1);
});

test("normal row tests explicitly retain aggregate success and non-selected rows", () => {
  const evaluated = validateCsv({
    version: 1,
    schema: { columns: { Id: { presence: "required" } } },
    rowTests: [{ id: "one-a", select: { Id: "A" }, expect: { count: { exact: 1 } } }]
  }, "Id\nA\nB\n");
  assert.equal(evaluated.checkOutcomes?.[0].status, "pass");
  assert.deepEqual(evaluated.rowOutcomes?.map(item => item.status), ["not-applicable", "pass"]);
  assert.deepEqual({ valid: evaluated.valid, issueCount: evaluated.issueCount, testCount: evaluated.testCount },
    { valid: true, issueCount: 0, testCount: 2 });
});

test("zero selected groups are N/A unless an explicit zero group-count expectation passes", () => {
  const child: CsvContract = {
    version: 1, schema: { columns: { Kind: { presence: "required" } } },
    rules: [{ id: "child", expect: { column: "Kind", operator: "notBlank" } }]
  };
  const base: CsvContract = {
    version: 1, schema: { columns: { Kind: { presence: "required" } } },
    groupTests: [{ id: "groups", groupBy: ["Kind"],
      select: { rowCount: { count: { exact: 0 } } }, contract: child }]
  };
  const skipped = validateCsv(base, "Kind\nA\n");
  assert.equal(skipped.checkOutcomes?.find(item => item.id === "groups")?.status, "not-applicable");
  const counted = validateCsv({ ...base, groupTests: [{ ...base.groupTests![0], groupCount: { exact: 0 } }] }, "Kind\nA\n");
  assert.equal(counted.checkOutcomes?.find(item => item.id === "groups")?.status, "pass");
});

test("nested unresolved rule packs cannot reach the evaluation engine", () => {
  const nested: CsvContract = {
    version: 1, schema: { columns: { Kind: { presence: "required" } } },
    rulePacks: [{ id: "shared", ref: "shared.rulepack.yaml", sha256: "a".repeat(64), definition: "checks" }]
  };
  const contract: CsvContract = {
    version: 1, schema: { columns: { Kind: { presence: "required" } } },
    groupTests: [{ id: "groups", groupBy: ["Kind"], contract: nested }]
  };
  assert.throws(() => validateCsv(contract, "Kind\nA\n"), /nested group contracts/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { RowOutcomeCollector } from "../src/core/row-outcomes";
import { validateCsv } from "../src/core/contract";

test("row outcomes retain explicit states and never fill missing evidence with pass", () => {
  const collector = new RowOutcomeCollector({ maxRows: 1 });
  collector.beginRow(2);
  collector.set("conditional", "not-applicable", "condition-false");
  collector.set("schema.Name", "pass");
  collector.set("broken", "fail");
  collector.endRow();
  collector.beginRow(3);
  collector.set("schema.Name", "pass");
  collector.endRow();
  const result = collector.result();
  assert.deepEqual(result.rowOutcomes[0], {
    row: 2,
    checks: {
      conditional: { state: "not-applicable", reason: "condition-false" },
      "schema.Name": { state: "pass" },
      broken: { state: "fail" }
    }
  });
  assert.deepEqual(result.rowOutcomeSummary, {
    retentionLimit: 1,
    retainedRows: 1,
    omittedRows: 1,
    complete: false,
    incompleteBecause: "truncated"
  });
});

test("sampled row outcomes are explicitly incomplete", () => {
  const collector = new RowOutcomeCollector({ maxRows: 10, sampled: true });
  collector.beginRow(1);
  collector.set("rule.x", "unknown", "sampled");
  collector.endRow();
  assert.equal(collector.result().rowOutcomeSummary.incompleteBecause, "sampled");
  assert.equal(collector.result().rowOutcomeSummary.complete, false);
});

test("memory validation distinguishes conditional, unsupported, and evaluated checks", () => {
  const result = validateCsv({
    version: 1,
    schema: { columns: { Status: { presence: "required" }, Value: { presence: "optional" } } },
    rowTests: [{ id: "ready", select: { Status: "Ready" }, expect: { cells: { Status: { equals: "Ready" } } } }],
    rules: [{ id: "missing-column", expect: { column: "Value", operator: "equals", value: "x" } }]
  }, "Status\nWaiting\nReady\n");
  assert.deepEqual(result.rowOutcomes?.map(row => row.checks), [
    {
      "schema.Value": { state: "not-evaluated", reason: "unsupported" },
      "row.ready": { state: "not-applicable", reason: "condition-false" },
      "rule.missing-column": { state: "not-evaluated", reason: "unsupported" }
    },
    {
      "schema.Value": { state: "not-evaluated", reason: "unsupported" },
      "row.ready": { state: "pass" },
      "rule.missing-column": { state: "not-evaluated", reason: "unsupported" }
    }
  ]);
});

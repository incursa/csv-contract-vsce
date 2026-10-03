import assert from "node:assert/strict";
import test from "node:test";
import { RowOutcomeCollector } from "../src/core/row-outcomes";
import { validateCsv } from "../src/core/contract";
import { validateCsvFile } from "../src/node/streaming-validator";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

test("streaming deferred checks update retained rows without changing aggregate semantics", async () => {
  const directory = await mkdtemp(join(tmpdir(), "csv-contract-row-outcomes-"));
  const csv = join(directory, "rows.csv");
  await writeFile(csv, "Id,Value\n1,a\n1,b\n2,c\n", "utf8");
  const result = (await validateCsvFile(csv, [{ spec: "rows", contract: {
    version: 1,
    schema: { columns: {
      Id: { presence: "required", constraints: { unique: true } },
      Value: { presence: "required" }
    } },
    orderedRules: [{
      id: "ordered",
      orderBy: [{ column: "Id", type: "number" }],
      relations: [{ id: "increasing", message: "Id 2 must follow b", when: { column: "Id", operator: "equals", value: "2" }, requirePrior: { column: "Value", operator: "equals", value: "b" } }]
    }]
  } }], { maxRowOutcomes: 10 })).runs[0].result;
  assert.equal(result.issues.some(issue => issue.code === "NOT_UNIQUE"), true);
  assert.equal(result.rowOutcomes?.find(row => row.row === 3)?.checks["schema.Id"].state, "fail");
  assert.equal(result.rowOutcomes?.find(row => row.row === 4)?.checks["ordered.increasing"].state, "pass");
  assert.equal(result.rowOutcomes?.find(row => row.row === 2)?.checks["ordered.increasing"], undefined);
});

import test from "node:test";
import assert from "node:assert/strict";
import { createValidationRunExport, issueRunsToCsv, parseValidationRunExport, validationRunExportJson } from "../src/issue-export";
import { validateCsvFile } from "../src/node/streaming-validator";
import { renderResults } from "../src/results-view";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const runs = [{
  target: "exports/customers.csv",
  result: {
    valid: false,
    rowCount: 3,
    columnCount: 2,
    testCount: 2,
    issueCount: 2,
    errorCount: 1,
    warningCount: 1,
    truncated: false,
    issues: [
      {
        level: "cell" as const,
        code: "CELL_NOT_EQUAL",
        testId: "active-customer",
        column: "Status",
        row: 3,
        message: "Expected Active, found Inactive.",
        actual: "Inactive",
        expected: "Active"
      },
      {
        level: "row" as const,
        code: "RULE_FAILED",
        severity: "warning" as const,
        message: "Review \"customer\" status."
      }
    ]
  }
}];

test("issue export includes every retained issue with target context", () => {
  const csv = issueRunsToCsv(runs);

  assert.match(csv, /^"Target","Severity","Level","Code","TestId","Column","Row","Message","Actual","Expected"\n/);
  assert.match(csv, /"exports\/customers\.csv","error","cell","CELL_NOT_EQUAL","active-customer","Status","3","Expected Active, found Inactive\.","Inactive","Active"/);
  assert.match(csv, /"exports\/customers\.csv","warning","row","RULE_FAILED","","","","Review ""customer"" status\.","",""/);
  assert.equal(csv.trim().split("\n").length, 3);
});

test("JSON export preserves complete run results and reports detail completeness", () => {
  const output = createValidationRunExport("contracts/customers.csvtest.yaml", runs);
  assert.deepEqual(output.totals, {
    targets: 1,
    passed: 0,
    rowsScanned: 3,
    errors: 1,
    warnings: 1,
    issues: 2,
    retainedIssueDetails: 2,
    issueDetailsComplete: true
  });
  assert.deepEqual(output.runs, runs);
  const serialized = JSON.parse(validationRunExportJson("contracts/customers.csvtest.yaml", runs));
  assert.deepEqual({ ...serialized, exportedAt: output.exportedAt }, output);
  const imported = parseValidationRunExport(JSON.stringify(serialized));
  assert.equal(imported.contract, "contracts/customers.csvtest.yaml");
  assert.deepEqual(imported.runs, runs);
  assert.match(imported.exportedAt!, /^\d{4}-\d{2}-\d{2}T/);
});

test("results import rejects unrelated JSON and malformed finding details", () => {
  assert.throws(() => parseValidationRunExport("{}"), /Unsupported results JSON/);
  const invalid = createValidationRunExport("contracts/customers.csvtest.yaml", runs);
  (invalid.runs[0].result!.issues[0] as { message?: string }).message = undefined;
  assert.throws(() => parseValidationRunExport(JSON.stringify(invalid)), /missing its level, code, or message/);
});

test("JSON export discloses when validation retained fewer issue details than it counted", () => {
  const truncatedRuns = [{
    ...runs[0],
    result: { ...runs[0].result, issueCount: 12, errorCount: 11, truncated: true }
  }];
  const output = createValidationRunExport("contracts/customers.csvtest.yaml", truncatedRuns);
  assert.equal(output.totals.issues, 12);
  assert.equal(output.totals.retainedIssueDetails, 2);
  assert.equal(output.totals.issueDetailsComplete, false);
  assert.equal(output.runs[0].result!.truncated, true);
});

test("a Workbench-sized retention setting exports more than one thousand CSV findings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "csv-contract-export-"));
  try {
    const csvPath = join(directory, "entities.csv");
    await writeFile(csvPath, ["State", ...Array.from({ length: 1205 }, () => "invalid")].join("\n") + "\n");
    const result = (await validateCsvFile(csvPath, [{ spec: join(directory, "entities.csvtest.yaml"), contract: {
      version: 1, schema: { columns: { State: { presence: "required", constraints: { allowedValues: ["valid"] } } } }
    } }], { maxIssues: Number.MAX_SAFE_INTEGER })).runs[0].result;
    assert.equal(result.issueCount, 1205);
    assert.equal(result.issues.length, 1205);
    assert.equal(result.truncated, false);
    const csv = issueRunsToCsv([{ target: "entities.csv", result }]);
    assert.equal(csv.trim().split("\n").length, 1206);
    const html = renderResults([{ target: "entities.csv", result }]);
    assert.match(html, /Showing the first 500 matching details/);
    assert.equal((html.match(/data-result-search=/g) ?? []).length, 500);
    assert.match(html, /finding-card/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

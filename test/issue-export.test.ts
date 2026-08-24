import test from "node:test";
import assert from "node:assert/strict";
import { createValidationRunExport, issueRunsToCsv, validationRunExportJson } from "../src/issue-export";

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
  assert.deepEqual(JSON.parse(validationRunExportJson("contracts/customers.csvtest.yaml", runs)), output);
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
  assert.equal(output.runs[0].result.truncated, true);
});

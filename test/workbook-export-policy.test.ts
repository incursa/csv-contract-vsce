import test from "node:test";
import assert from "node:assert/strict";
import { strFromU8, unzipSync } from "fflate";
import { badRowsXlsx, contractCheckCatalog } from "../src/bad-rows-xlsx";
import { prepareWorkbookExport } from "../src/workbook-export-policy";
import type { CsvContract, ValidationResult } from "../src/core/model";

const contract: CsvContract = {
  version: 1,
  schema: { columns: {
    EmployeeName: { presence: "required", constraints: { allowedValues: ["SECRET-GOLD"] } },
    Code: { presence: "required", constraints: { matches: "^VIP-[0-9]+$" } },
    Amount: { presence: "required" }
  } },
  rowTests: [{ id: "employee-amount", select: { EmployeeName: "Ada Lovelace" }, expect: { cells: { Amount: { equals: "9876.54" } } } }],
  rules: [{ id: "internal-name", expect: { column: "EmployeeName", operator: "notEquals", value: "Internal Only" } }]
};

const result: ValidationResult = {
  valid: false, rowCount: 1, columnCount: 3, testCount: 5, issueCount: 1, errorCount: 1, warningCount: 0, truncated: false,
  checkOutcomes: [
    { id: "employee-amount", kind: "row-test", status: "fail", selected: 1, passed: 0, failed: 1 },
    { id: "internal-name", kind: "row-rule", status: "pass", selected: 1, passed: 1, failed: 0 }
  ],
  issues: [{ level: "row", code: "RULE_FAILED", testId: "employee-amount", message: "Ada Lovelace amount 9876.54 failed.", actual: "9876.54", expected: "SECRET-GOLD",
    evidence: { samples: [{ primary: { label: "people.csv", row: 2, values: { EmployeeName: "Ada Lovelace", Amount: "9876.54", Code: "VIP-123" } } }] } }]
};

function workbookText(bytes: Uint8Array): string {
  return Object.values(unzipSync(bytes)).map(value => strFromU8(value)).join("\n");
}

test("aggregate-only workbook policy removes literals from evidence and contract catalog descriptions", () => {
  const input = [{ target: "people.csv", status: "FAIL", result }];
  const options = { title: "Protected validation", checkCatalog: () => contractCheckCatalog(contract) };
  const aggregate = prepareWorkbookExport(input, options, "aggregate-only");
  const aggregateText = workbookText(badRowsXlsx(aggregate.runs, aggregate.options));
  for (const literal of ["Ada Lovelace", "9876.54", "SECRET-GOLD", "^VIP-[0-9]+$", "Internal Only", "VIP-123"]) {
    assert.doesNotMatch(aggregateText, new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `aggregate workbook leaked ${literal}`);
  }
  assert.match(aggregateText, /employee-amount/);
  assert.match(aggregateText, /Row test/i);
  assert.match(aggregateText, /Review the definition for protected or literal criteria/);

  const detailed = prepareWorkbookExport(input, options, "detail");
  const detailedText = workbookText(badRowsXlsx(detailed.runs, detailed.options));
  for (const literal of ["Ada Lovelace", "9876.54", "SECRET-GOLD", "^VIP-[0-9]+$", "Internal Only", "VIP-123"]) {
    assert.match(detailedText, new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `detailed workbook should retain ${literal}`);
  }
});

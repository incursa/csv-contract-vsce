import test from "node:test";
import assert from "node:assert/strict";
import { strFromU8, unzipSync } from "fflate";
import { badRowsXlsx, contractCheckCatalog, targetDisplayLabel } from "../src/bad-rows-xlsx";
import { sqlServerTargetLabel } from "../src/core/sql-server-targets";
import type { CsvContract, ValidationResult } from "../src/core/model";

const contract: CsvContract = {
  version: 1,
  schema: { columns: {
    Id: { presence: "required", constraints: { notNull: true, unique: true } },
    Status: { presence: "required", constraints: { allowedValues: ["Active"] } }
  } },
  rules: [{ id: "status-rule", expect: { column: "Status", operator: "equals", value: "Active" } }]
};

const result: ValidationResult = {
  valid: false, rowCount: 2, columnCount: 2, testCount: 4, issueCount: 2, errorCount: 2, warningCount: 0, truncated: false,
  issues: [
    { level: "row", code: "RULE_FAILED", testId: "status-rule", row: 2, message: "Status must be active.", evidence: { samples: [{
      primary: { label: "source.csv", row: 2, values: { Id: "00123", Status: "Inactive" } },
      related: [
        { label: "lookup", row: 8, values: { Category: "Closed" } },
        { label: "lookup", row: 9, values: { Category: "Blocked" } }
      ]
    }] } },
    { level: "cell", code: "NOT_ALLOWED", column: "Status", row: 2, message: "Status is not allowed.", evidence: { samples: [{
      primary: { label: "source.csv", row: 2, values: { Id: "00123", Status: "Inactive" } }
    }] } }
  ]
};

test("SQL target labels use the resolved execution endpoint and ignore display names", () => {
  assert.equal(sqlServerTargetLabel({ connection: "profile", resolvedConnection: { server: "sql01", database: "Sales" }, schema: "dbo", table: "Orders", name: "friendly name" }), "sql01.Sales.dbo.Orders");
  assert.equal(sqlServerTargetLabel({ connection: "unused", integratedConnection: { server: "sql02", database: "Warehouse" }, schema: "stage", table: "Orders" }), "sql02.Warehouse.stage.Orders");
});

test("validation package uses one canonical target label across reviewer sheets", () => {
  const canonical = "sql01.Sales.dbo.Orders";
  assert.equal(targetDisplayLabel({ target: canonical, displayTarget: canonical, member: "sql-test" }, 0), canonical);
  const files = unzipSync(badRowsXlsx([{
    member: "sql-test", target: canonical, displayTarget: canonical, status: "FAIL", result: {
      ...result,
      issues: [{ level: "file", code: "ROW_COUNT_MIN", message: "Too few rows.", actual: 0, expected: 1, evidence: { samples: [], aggregate: { actual: 0, expected: 1 } } }]
    }
  }], { title: "SQL package", checkCatalog: () => [{ id: "row-count-min", category: "File", description: "At least one row." }] }));
  const overview = strFromU8(files["xl/worksheets/sheet1.xml"]);
  const rules = strFromU8(files["xl/worksheets/sheet2.xml"]);
  const aggregate = strFromU8(files["xl/worksheets/sheet3.xml"]);
  const readme = strFromU8(files["xl/worksheets/sheet4.xml"]);
  assert.equal((overview.match(new RegExp(canonical, "g")) ?? []).length, 1);
  assert.match(rules, new RegExp(canonical));
  assert.match(aggregate, new RegExp(canonical));
  assert.match(readme, new RegExp(canonical));
});

test("bad-row workbook consolidates one target across test files with qualified sparse checks", () => {
  const secondContract: CsvContract = {
    version: 1,
    schema: { columns: { Id: { presence: "required" }, Status: { presence: "required" } } },
    rules: [{ id: "status-rule", expect: { column: "Id", operator: "notEquals", value: "" } }]
  };
  const secondResult: ValidationResult = {
    ...result,
    testCount: 3,
    issueCount: 1,
    errorCount: 1,
    issues: [{ level: "row", code: "RULE_FAILED", testId: "status-rule", row: 2, message: "Id must be populated.", evidence: { samples: [{
      primary: { label: "source.csv", row: 2, values: { Status: "Inactive", Id: "00123" } }
    }] } }]
  };
  const runs = [
    { member: "status-test", target: "exports/source.csv", status: "FAIL", durationMs: 1250, result },
    { member: "identity-test", target: "exports/source.csv", status: "FAIL", durationMs: 800, result: secondResult }
  ];
  const bytes = badRowsXlsx(runs, {
    title: "Synthetic validation package", checkCatalog: (_run, index) => contractCheckCatalog(index === 0 ? contract : secondContract)
  });
  assert.equal(String.fromCharCode(...bytes.slice(0, 2)), "PK");
  const files = unzipSync(bytes);
  const workbook = strFromU8(files["xl/workbook.xml"]);
  const overview = strFromU8(files["xl/worksheets/sheet1.xml"]);
  const rules = strFromU8(files["xl/worksheets/sheet2.xml"]);
  const matrix = strFromU8(files["xl/worksheets/sheet3.xml"]);
  const readme = strFromU8(files["xl/worksheets/sheet4.xml"]);
  assert.match(workbook, /Overview/);
  assert.match(workbook, /Rules/);
  assert.match(workbook, /Read Me/);
  assert.match(workbook, /Bad - exports source.csv/);
  assert.match(overview, /Overall/);
  assert.match(overview, /Moderate impact|High impact|Limited impact/);
  assert.match(overview, /Duration \(seconds\)/);
  assert.match(rules, /What was tested/);
  assert.match(rules, /Status equals Active/);
  assert.match(rules, /Status must be one of: Active/);
  assert.match(rules, /Id must be present/);
  assert.match(readme, /FALSE \(red\).*Blank means not failed/);
  assert.match(matrix, /<t>00123<\/t>/, "numeric-looking identifiers must remain text");
  assert.match(matrix, /identity-test, status-test/);
  assert.match(matrix, /status-test - lookup - Category/);
  assert.match(matrix, /status-test - lookup #2 - Category/);
  assert.match(matrix, /Check - status-test - Id\.not-null/);
  assert.match(matrix, /Check - status-test - Id\.unique/);
  assert.match(matrix, /Check - status-test - Status\.allowed-values/);
  assert.match(matrix, /Check - status-test - status-rule/);
  assert.match(matrix, /Check - identity-test - status-rule/);
  assert.equal((matrix.match(/t="b" s="3"><v>0<\/v>/g) ?? []).length, 3, "only failed checks should contain styled FALSE values");
  assert.match(matrix, /<autoFilter/);
  assert.match(matrix, /state="frozen"/);
});

test("validation package maps aggregate count findings to the configured rule", () => {
  const countContract: CsvContract = { version: 1, schema: { rowCount: { min: 3 }, columns: { Id: { presence: "required" } } } };
  const countResult: ValidationResult = {
    valid: false, rowCount: 2, columnCount: 1, testCount: 1, issueCount: 1, errorCount: 1, warningCount: 0, truncated: false,
    issues: [{ level: "file", code: "ROW_COUNT_MIN", message: "Too few rows.", actual: 2, expected: 3, evidence: { samples: [], aggregate: { actual: 2, expected: 3 } } }]
  };
  const files = unzipSync(badRowsXlsx([{ member: "count-test", target: "source.csv", status: "FAIL", result: countResult }], {
    title: "Count package", checkCatalog: () => contractCheckCatalog(countContract)
  }));
  const rules = strFromU8(files["xl/worksheets/sheet2.xml"]);
  const aggregate = strFromU8(files["xl/worksheets/sheet3.xml"]);
  assert.equal((rules.match(/row-count-min/g) ?? []).length, 1);
  assert.match(rules, /FAILED/);
  assert.match(aggregate, /row-count-min/);
});

test("validation package keeps explicit CSV labels and distinct case-sensitive targets", () => {
  const longA = `exports/${"a".repeat(40)}.csv`;
  const longB = `exports/${"A".repeat(40)}.csv`;
  const runs = [longB, longA].map(target => ({ member: "csv-test", target, status: "ERROR", error: "Login failed; User ID=alice; Password=secret; Server=sql01; Database=Sales" }));
  const files = unzipSync(badRowsXlsx(runs, { title: "CSV package" }));
  const overview = strFromU8(files["xl/worksheets/sheet1.xml"]);
  assert.match(overview, new RegExp(longA));
  assert.match(overview, new RegExp(longB));
  assert.doesNotMatch(overview, /alice|secret|sql01|Sales/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { strFromU8, unzipSync } from "fflate";
import { badRowsXlsx, contractCheckCatalog } from "../src/bad-rows-xlsx";
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
  assert.doesNotMatch(matrix, /Check - status-test - Id\.not-null/);
  assert.doesNotMatch(matrix, /Check - status-test - Id\.unique/);
  assert.match(matrix, /Check - status-test - Status\.allowed-values/);
  assert.match(matrix, /Check - status-test - status-rule/);
  assert.match(matrix, /Check - identity-test - status-rule/);
  assert.equal((matrix.match(/t="b" s="3"><v>0<\/v>/g) ?? []).length, 3, "only failed checks should contain styled FALSE values");
  assert.match(matrix, /<autoFilter/);
  assert.match(matrix, /state="frozen"/);
});

test("rules sheet is an explicit per-target matrix and canonicalizes trusted source metadata", () => {
  const passing: ValidationResult = { ...result, valid: true, issueCount: 0, errorCount: 0, issues: [], ruleOutcomes: [{ id: "status-rule", name: "Status rule", selected: 2, passed: 2, failed: 0 }] };
  const files = unzipSync(badRowsXlsx([
    { member: "status-test", status: "PASS", source: { server: "srv", database: "warehouse", schema: "dbo", table: "people" }, result: passing },
    { member: "status-test", target: "sample.csv", status: "SAMPLED", result: { ...passing, preview: { scope: "sample", rowLimit: 10, exampleLimit: 2 } } },
    { member: "status-test", target: "skipped.csv", status: "SKIPPED" },
    { member: "status-test", target: "unknown.csv", status: "ERROR", error: "Unavailable" }
  ], { title: "Matrix", checkCatalog: () => [{ id: "status-rule", category: "Rule", description: "Status is valid." }, { id: "no-outcome", category: "Rule", description: "No explicit outcome." }] }));
  const workbook = strFromU8(files["xl/workbook.xml"]);
  const rules = strFromU8(files["xl/worksheets/sheet2.xml"]);
  assert.match(workbook, /Rules/);
  assert.match(rules, /srv\.warehouse\.dbo\.people/);
  assert.match(rules, /PASS/);
  assert.match(rules, /SAMPLED/);
  assert.match(rules, /NOT RUN/);
  assert.match(rules, /UNKNOWN/);
  assert.match(rules, /xSplit="4"/);
  assert.match(rules, /status-rule[\s\S]*PASS[\s\S]*SAMPLED[\s\S]*NOT RUN[\s\S]*UNKNOWN/);
});

test("rules sheet discovers explicit aggregate-only check outcomes without a contract catalog or issues", () => {
  const aggregateOnly: ValidationResult = {
    valid: false, rowCount: 20, columnCount: 2, testCount: 3, issueCount: 2, errorCount: 2, warningCount: 0, truncated: false, issues: [],
    checkOutcomes: [
      { id: "passed-check", name: "Business pass", kind: "row-rule", status: "pass", selected: 20, passed: 20, failed: 0 },
      { id: "failed-check", name: "Business failure", kind: "group-rule", status: "fail", groups: 4, passed: 2, failed: 2 },
      { id: "deferred-check", name: "Deferred validation", kind: "sql-rule", status: "not-evaluated", notEvaluated: 20 }
    ]
  };
  const files = unzipSync(badRowsXlsx([{ target: "saved-review", status: "FAIL", result: aggregateOnly }], { title: "Aggregate review" }));
  const workbook = strFromU8(files["xl/workbook.xml"]);
  const rules = strFromU8(files["xl/worksheets/sheet2.xml"]);
  assert.match(workbook, /Rules/);
  assert.match(rules, /passed-check/);
  assert.match(rules, /Business pass/);
  assert.match(rules, /Row Rule/);
  assert.match(rules, /failed-check/);
  assert.match(rules, /Business failure/);
  assert.match(rules, /Group Rule/);
  assert.match(rules, /deferred-check/);
  assert.match(rules, /Deferred validation/);
  assert.match(rules, /Sql Rule/);
  assert.match(rules, /PASS/);
  assert.match(rules, /FAIL/);
  assert.match(rules, /NOT RUN/);
});

test("rules sheet discovers legacy rule and group outcomes conservatively", () => {
  const legacy: ValidationResult = {
    valid: true, rowCount: 2, columnCount: 1, testCount: 2, issueCount: 0, errorCount: 0, warningCount: 0, truncated: false, issues: [],
    ruleOutcomes: [{ id: "legacy-rule", name: "Legacy rule", selected: 2, passed: 2, failed: 0 }],
    groupOutcomes: [{ id: "legacy-group", name: "Legacy empty group", groups: 0, passed: 0, failed: 0 }]
  };
  const files = unzipSync(badRowsXlsx([{ target: "legacy", status: "PASS", result: legacy }], { title: "Legacy review" }));
  const rules = strFromU8(files["xl/worksheets/sheet2.xml"]);
  assert.match(rules, /legacy-rule/);
  assert.match(rules, /legacy-group/);
  assert.match(rules, /PASS/);
  assert.match(rules, /UNKNOWN/);
});

test("bad-row sheet uses retained row outcomes and states when identity is unavailable", () => {
  const outcomeOnly: ValidationResult = {
    valid: false, rowCount: 1, columnCount: 1, testCount: 1, issueCount: 1, errorCount: 1, warningCount: 0, truncated: false, issues: [],
    checkOutcomes: [{ id: "required-value", name: "Required value", kind: "row-rule", status: "fail", failed: 1 }],
    rowOutcomes: [{ checkId: "required-value", checkName: "Required value", kind: "row-rule", status: "fail" }],
    outcomeRetention: { limit: 10, retained: 1, dropped: 0, truncated: false, counts: { pass: 0, fail: 1, "not-applicable": 0, "not-evaluated": 0, unknown: 0 } }
  };
  const files = unzipSync(badRowsXlsx([{ member: "required-test", target: "source.csv", status: "FAIL", result: outcomeOnly }], {
    title: "Retained outcomes", checkCatalog: () => [{ id: "required-value", category: "Rule", description: "A value is required." }]
  }));
  const matrix = strFromU8(files["xl/worksheets/sheet3.xml"]);
  assert.match(matrix, /Source row \/ identity/);
  assert.match(matrix, /Identity unavailable/);
  assert.match(matrix, /Check - required-test - required-value/);
});

test("matrix combines duplicate target labels conservatively and does not infer a legacy zero-selection pass", () => {
  const pass: ValidationResult = { ...result, valid: true, issues: [], issueCount: 0, errorCount: 0, ruleOutcomes: [{ id: "status-rule", selected: 2, passed: 2, failed: 0 }] };
  const fail: ValidationResult = { ...result, ruleOutcomes: [{ id: "status-rule", selected: 2, passed: 1, failed: 1 }] };
  const zero: ValidationResult = { ...pass, ruleOutcomes: [{ id: "status-rule", selected: 0, passed: 0, failed: 0 }] };
  const files = unzipSync(badRowsXlsx([
    { member: "same-test", target: "duplicate.csv", status: "PASS", result: pass },
    { member: "same-test", target: "duplicate.csv", status: "FAIL", result: fail },
    { member: "same-test", target: "zero.csv", status: "PASS", result: zero }
  ], { title: "Conservative matrix", checkCatalog: () => [{ id: "status-rule", category: "Rule", description: "Status is valid." }] }));
  const rules = strFromU8(files["xl/worksheets/sheet2.xml"]);
  assert.match(rules, /duplicate.csv/);
  assert.match(rules, /FAIL/);
  assert.match(rules, /zero.csv/);
  assert.match(rules, /UNKNOWN/);
});

test("workbook merges retained row outcomes and separates group evidence from bad rows", () => {
  const mixed: ValidationResult = {
    ...result,
    checkOutcomes: [{ id: "second-check", kind: "row-rule", status: "fail", failed: 1 }, { id: "group-check", kind: "group-rule", status: "fail", failed: 1, groups: 1 }],
    rowOutcomes: [
      { checkId: "second-check", kind: "row-rule", status: "fail", row: 3, context: { identity: { Id: "row-3" } } },
      { checkId: "group-check", kind: "group-rule", status: "fail", context: { group: { Region: "West" } } }
    ]
  };
  const files = unzipSync(badRowsXlsx([{ member: "mixed-test", target: "source.csv", status: "FAIL", result: mixed }], {
    title: "Mixed evidence", checkCatalog: () => [
      { id: "second-check", category: "Rule", description: "Second check." }, { id: "group-check", category: "Group rule", description: "Group check." }
    ]
  }));
  const workbook = strFromU8(files["xl/workbook.xml"]);
  const matrix = strFromU8(files["xl/worksheets/sheet3.xml"]);
  const group = strFromU8(files["xl/worksheets/sheet4.xml"]);
  const readme = strFromU8(files["xl/worksheets/sheet5.xml"]);
  assert.match(matrix, /row-3/);
  assert.match(matrix, /Check - mixed-test - second-check/);
  assert.match(workbook, /Group Findings/);
  assert.match(group, /group-check/);
  assert.match(group, /Region/);
  assert.match(readme, /Retained bad rows/);
  assert.match(readme, /Retained failing groups/);
});

test("unknown or unsupported target statuses never fall through to overall pass", () => {
  const files = unzipSync(badRowsXlsx([{ member: "test", target: "source.csv", status: "UNSUPPORTED", result: { ...result, valid: true, issues: [], issueCount: 0, errorCount: 0 } }], {
    title: "Unknown status", checkCatalog: () => [{ id: "status-rule", category: "Rule", description: "Status is valid." }]
  }));
  const overview = strFromU8(files["xl/worksheets/sheet1.xml"]);
  const rules = strFromU8(files["xl/worksheets/sheet2.xml"]);
  assert.match(overview, /UNKNOWN/);
  assert.match(rules, /UNKNOWN/);
});

test("overview leaves weighted health scores blank when health is unavailable", () => {
  const unavailable: ValidationResult = {
    valid: true, rowCount: 10, columnCount: 1, testCount: 1, issueCount: 0, errorCount: 0, warningCount: 0, truncated: false, issues: [],
    checkOutcomes: [{ id: "weighted-check", kind: "row-rule", status: "unknown", importance: 2 }]
  };
  const files = unzipSync(badRowsXlsx([{ member: "weighted-test", target: "source.csv", status: "UNKNOWN", result: unavailable }], {
    title: "Unavailable weighted health", checkCatalog: () => [{ id: "weighted-check", category: "Rule", description: "Weighted check." }]
  }));
  const overview = strFromU8(files["xl/worksheets/sheet1.xml"]);
  assert.equal((overview.match(/Health unavailable/g) ?? []).length, 2, "overall and target impact must be unavailable");
  assert.doesNotMatch(overview, /r="E2"/, "overall numeric health score must be blank");
  assert.doesNotMatch(overview, /r="E3"/, "target numeric health score must be blank");
  assert.match(overview, /r="D2"[^>]*s="11"/);
  assert.match(overview, /r="D3"[^>]*s="11"/);
  assert.match(overview, /indeterminate checks/);
});

test("low Excel limits shard rows and columns without losing retained failures", () => {
  const samples = Array.from({ length: 5 }, (_, index) => ({ primary: {
    label: "wide.csv", row: index + 2, values: { Id: `id-${index + 1}`, Alpha: `a-${index + 1}`, Beta: `b-${index + 1}` }
  } }));
  const wide: ValidationResult = {
    valid: false, rowCount: 5, columnCount: 3, testCount: 1, issueCount: 5, errorCount: 5, warningCount: 0, truncated: false,
    checkOutcomes: [{ id: "wide-check", kind: "row-rule", status: "fail", selected: 5, passed: 0, failed: 5 }],
    issues: [{ level: "row", code: "RULE_FAILED", testId: "wide-check", message: "Synthetic failure.", evidence: { samples, totalSamples: 5 } }]
  };
  const files = unzipSync(badRowsXlsx([{ member: "wide-test", target: "wide.csv", status: "FAIL", result: wide }], {
    title: "Sharded", limits: { maxRowsPerSheet: 3, maxColumnsPerSheet: 4 },
    checkCatalog: () => [{ id: "wide-check", category: "Rule", description: "Wide check." }]
  }));
  const workbook = strFromU8(files["xl/workbook.xml"]);
  const relationships = strFromU8(files["xl/_rels/workbook.xml.rels"]);
  const contentTypes = strFromU8(files["[Content_Types].xml"]);
  const names = [...workbook.matchAll(/<sheet name="([^"]+)"/g)].map(match => match[1]);
  const sheetFiles = Object.keys(files).filter(path => /^xl\/worksheets\/sheet\d+\.xml$/.test(path));
  assert.equal(names.length, sheetFiles.length);
  assert.equal(new Set(names.map(name => name.toLocaleLowerCase())).size, names.length);
  assert.ok(names.every(name => name.length <= 31));
  assert.equal((relationships.match(/relationships\/worksheet/g) ?? []).length, sheetFiles.length);
  assert.equal((contentTypes.match(/spreadsheetml\.worksheet\+xml/g) ?? []).length, sheetFiles.length);
  const badSheets = sheetFiles.map(path => strFromU8(files[path])).filter(xml => /Bad - wide\.csv/.test(workbook) && /Source row \/ identity/.test(xml));
  assert.ok(badSheets.length > 1, "bad-row data should shard");
  for (const xml of badSheets) {
    assert.ok((xml.match(/<row /g) ?? []).length <= 3);
    assert.ok((xml.match(/<c r="[A-Z]+1"/g) ?? []).length <= 4);
    assert.match(xml, /Test files/);
    assert.match(xml, /Source/);
    assert.match(xml, /Source row \/ identity/);
  }
  const badXml = badSheets.join("");
  for (let index = 1; index <= 5; index++) assert.match(badXml, new RegExp(`id-${index}`));
  assert.equal((badXml.match(/t="b" s="3"><v>0<\/v>/g) ?? []).length, 5, "each retained failed check must stay FALSE exactly once");
});

test("in-memory workbook enforces a bounded serialization budget", () => {
  assert.throws(() => badRowsXlsx([{ member: "test", target: "source.csv", status: "FAIL", result }], {
    title: "Budget", syncUncompressedByteLimit: 128, checkCatalog: () => contractCheckCatalog(contract)
  }), /use the desktop or standalone streamed export/);
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
  assert.match(rules, /FAIL/);
  assert.match(aggregate, /row-count-min/);
});

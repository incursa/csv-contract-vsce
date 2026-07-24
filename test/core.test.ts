import test from "node:test";
import assert from "node:assert/strict";
import { parseContract, validateCsv } from "../src/core/contract";
import type { CsvContract } from "../src/core/model";

function base(): CsvContract {
  return {
    version: 1,
    csv: { nullValues: [""], caseSensitive: true, trimValues: false },
    schema: {
      allowAdditionalColumns: true,
      columns: {
        Company: { presence: "required", constraints: { notNull: true } },
        EmployeeId: { presence: "required", constraints: { notNull: true, unique: true, matches: "^\\d+$" } },
        OptionalComment: { presence: "optional", constraints: { maxLength: 10 } }
      }
    }
  };
}

test("validates a passing contract while preserving leading zeroes", () => {
  const contract = base();
  contract.rowTests = [{
    id: "spot-check",
    select: { Company: "01", EmployeeId: "000123" },
    expect: { count: { exact: 1 }, cells: { EmployeeId: { equals: "000123" } } }
  }];
  const result = validateCsv(contract, "Company,EmployeeId\n01,000123\n02,000124\n");
  assert.equal(result.valid, true);
  assert.equal(result.rowCount, 2);
});

test("skips constraints for an absent optional column", () => {
  const result = validateCsv(base(), "Company,EmployeeId\n01,000123\n");
  assert.equal(result.valid, true);
  assert.equal(result.issues.length, 0);
});

test("fails when a row selector references an absent optional column", () => {
  const contract = base();
  contract.rowTests = [{
    id: "optional-selector",
    select: { OptionalComment: "x" },
    expect: { count: { exact: 1 } }
  }];
  const result = validateCsv(contract, "Company,EmployeeId\n01,000123\n");
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "TEST_COLUMN_MISSING"));
});

test("reports uniqueness, null, and regex violations", () => {
  const result = validateCsv(base(), "Company,EmployeeId\n01,000123\n02,000123\n03,\n04,ABC\n");
  assert.ok(result.issues.some((issue) => issue.code === "NOT_UNIQUE"));
  assert.ok(result.issues.some((issue) => issue.code === "NULL_VALUE"));
  assert.ok(result.issues.some((issue) => issue.code === "REGEX_MISMATCH"));
});

test("rejects undeclared extras only when configured", () => {
  const contract = base();
  contract.schema.allowAdditionalColumns = false;
  const result = validateCsv(contract, "Company,EmployeeId,Surprise\n01,000123,x\n");
  assert.ok(result.issues.some((issue) => issue.code === "ADDITIONAL_COLUMN"));
});

test("parses the example YAML shape", () => {
  const contract = parseContract("version: 1\nschema:\n  columns:\n    A:\n      presence: required\n");
  assert.equal(contract.schema.columns.A.presence, "required");
});

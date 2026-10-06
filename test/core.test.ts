import test from "node:test";
import assert from "node:assert/strict";
import { parseContract, validateCsv } from "../src/core/contract";
import { resultHealth } from "../src/core/result-health";
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

test("weights CSV rule failures without changing validation or default behavior", () => {
  const contract: CsvContract = {
    version: 1,
    schema: { columns: { Email: { presence: "required" }, Required: { presence: "required" } } },
    rules: [
      { id: "email-lowercase", importance: 0.25, expect: { column: "Email", operator: "matches", value: "^[a-z0-9._%+-]+@[a-z0-9.-]+$" } },
      { id: "required-data", expect: { column: "Required", operator: "notBlank" } }
    ]
  };
  const result = validateCsv(contract, "Email,Required\nAlice@Example.com,\n");
  assert.equal(result.valid, false);
  assert.equal(result.issues.find((issue) => issue.testId === "email-lowercase")?.importance, 0.25);
  assert.equal(result.issues.find((issue) => issue.testId === "required-data")?.importance, undefined);
  assert.equal(result.ruleOutcomes?.find((outcome) => outcome.id === "required-data")?.importance, undefined);
  const weighted = resultHealth(result, "FAIL", "graded");
  const minorOnly = validateCsv({ ...contract, rules: [contract.rules![0]] }, "Email,Required\nAlice@Example.com,ok\n");
  const majorOnly = validateCsv({ ...contract, rules: [contract.rules![1]] }, "Email,Required\nok,\n");
  assert.ok(resultHealth(minorOnly, "FAIL", "graded").score > resultHealth(majorOnly, "FAIL", "graded").score);
  assert.ok(weighted.score < resultHealth(minorOnly, "FAIL", "graded").score);
});

test("weights row-test failures and rejects importance outside the documented range", () => {
  const contract = base();
  contract.rowTests = [{
    id: "email-lowercase",
    importance: 0.25,
    select: { Company: "01" },
    expect: { cells: { Company: { equals: "02" } } }
  }];
  const result = validateCsv(contract, "Company,EmployeeId\n01,000123\n");
  assert.equal(result.valid, false);
  assert.equal(result.issues.find((issue) => issue.testId === "email-lowercase")?.importance, 0.25);

  assert.throws(() => parseContract(`version: 1\nschema:\n  columns:\n    A: { presence: required }\nrules:\n  - id: invalid\n    importance: 2\n    expect: { column: A, operator: notBlank }\n`), /Invalid contract|importance must be a finite number from 0 to 1/);
});

test("conditional warning rules use numeric predicates without failing the contract", () => {
  const contract: CsvContract = {
    version: 1,
    schema: { columns: { Company: { presence: "required" }, Value: { presence: "required" } } },
    rules: [{
      id: "negative-value",
      severity: "warning",
      when: { column: "Company", operator: "equals", value: "01" },
      expect: { column: "Value", operator: "greaterThanOrEqual", value: 0 }
    }]
  };
  const result = validateCsv(contract, "Company,Value\n01,-25\n");
  assert.equal(result.valid, true);
  assert.equal(result.errorCount, 0);
  assert.equal(result.warningCount, 1);
  assert.equal(result.issues[0].severity, "warning");
});

test("conditional rules support nested predicates and report failures", () => {
  const contract = base();
  contract.rules = [{
    id: "active-payee",
    when: {
      any: [
        { column: "Company", operator: "startsWith", value: "0" },
        { column: "Company", operator: "contains", value: "East" }
      ]
    },
    expect: {
      all: [
        { column: "EmployeeId", operator: "notBlank" },
        { column: "EmployeeId", operator: "matches", value: "^\\d+$" }
      ]
    }
  }];
  const result = validateCsv(contract, "Company,EmployeeId\n01,ABC\n");
  assert.equal(result.valid, false);
  assert.equal(result.errorCount, 2); // the column regex and the conditional rule both fail
  assert.ok(result.issues.some((issue) => issue.code === "RULE_FAILED" && issue.testId === "active-payee"));
});

test("group rules require exact values and fragments within each group", () => {
  const contract: CsvContract = {
    version: 1,
    schema: {
      columns: {
        Person: { presence: "required" },
        Balance: { presence: "required" }
      }
    },
    groupRules: [{
      id: "tax-family",
      when: { column: "Balance", operator: "contains", value: "City" },
      groupBy: ["Person"],
      require: { column: "Balance", contains: ["Gross", "Subject", "Withheld"] }
    }]
  };
  const result = validateCsv(contract, "Person,Balance\n1,City Gross\n2,City Gross\n1,City Subject\n1,City Withheld\n2,City Subject\n");
  assert.equal(result.valid, false);
  const issue = result.issues.find((candidate) => candidate.code === "GROUP_REQUIRED_VALUE_MISSING");
  assert.equal(issue?.expected, "Withheld");
  assert.match(issue?.message ?? "", /Person=2/);
});

test("exact column order follows schema declaration order", () => {
  const contract = base();
  contract.schema.columnOrder = "exact";
  const result = validateCsv(contract, "EmployeeId,Company,OptionalComment\n000123,01,\n");
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "COLUMN_ORDER_MISMATCH"));
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { CsvContract } from "../src/core/model";
import { parseContract } from "../src/core/contract";
import { generateSqlServerValidation } from "../src/core/sql-server-generator";
import { resolveSqlServerTargets } from "../src/core/sql-server-targets";
import { suggestSqlColumnMappings } from "../src/core/sql-server-column-mapping";

function contract(): CsvContract {
  return {
    version: 1,
    csv: { nullValues: ["", "NULL"], trimValues: true, caseSensitive: false },
    schema: {
      columns: {
        LoadId: { presence: "required", constraints: { notNull: true } },
        SourceRow: { presence: "required", constraints: { unique: true } },
        Status: { presence: "required", constraints: { allowedValues: ["Open", "Complete"] } },
        CompletionDate: { presence: "optional" },
        SourceType: { presence: "required" },
        Category: { presence: "required", constraints: { maxLength: 20, matches: "^[A-Z]+$" } }
      }
    },
    sqlServer: {
      schema: "staging",
      table: "Daytime Load",
      rowLocator: ["LoadId", "SourceRow"],
      detailLimit: 25,
      scope: { column: "LoadId", parameter: "LoadId", sqlType: "nvarchar(100)" },
      conditionalRules: [
        {
          id: "completed-requires-date",
          name: "Completed rows have a completion date",
          when: { column: "Status", operator: "equals", value: "Complete" },
          expect: { column: "CompletionDate", operator: "notNull" }
        },
        {
          id: "employee-category",
          severity: "warning",
          when: {
            all: [
              { column: "SourceType", operator: "equals", value: "Employee" },
              { column: "Status", operator: "in", values: ["Open", "Complete"] }
            ]
          },
          expect: { column: "Category", operator: "equals", value: "Labor" }
        }
      ]
    }
  };
}

test("generates read-only scoped SQL for column and conditional rules", () => {
  const result = generateSqlServerValidation(contract());
  assert.equal(result.ruleCount, 6);
  assert.match(result.sql, /DECLARE @LoadId nvarchar\(100\) = NULL/);
  assert.match(result.sql, /FROM \[staging\]\.\[Daytime Load\] AS t/);
  assert.match(result.sql, /N'completed-requires-date' AS RuleId/);
  assert.match(result.sql, /TOP \(25\).*t\.\[LoadId\], t\.\[SourceRow\], t\.\*/);
  assert.match(result.sql, /LOWER\(LTRIM\(RTRIM\(CONVERT\(nvarchar\(max\), t\.\[Status\]\)\)\)\)/);
  assert.doesNotMatch(result.sql, /\b(?:INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE)\b/i);
  assert.deepEqual(result.warnings, [
    "Category.matches uses a JavaScript regular expression and requires exact client-side fallback when executed."
  ]);
});

test("quotes identifiers and values without allowing SQL injection", () => {
  const input = contract();
  input.sqlServer!.table = "Load]Data";
  input.sqlServer!.conditionalRules![0].expect = { column: "Category", operator: "equals", value: "O'Brien'; DROP TABLE x;--" };
  const sql = generateSqlServerValidation(input).sql;
  assert.match(sql, /\[Load]]Data\]/);
  assert.match(sql, /N'O''Brien''; DROP TABLE x;--'/);
  assert.doesNotMatch(sql, /N'O'Brien/);
});

test("rejects unsafe scope types and malformed predicates", () => {
  const unsafeType = contract();
  unsafeType.sqlServer!.scope!.sqlType = "nvarchar(100); DROP TABLE staging.Data";
  assert.throws(() => generateSqlServerValidation(unsafeType), /safe type list/);

  const missingValue = contract();
  missingValue.sqlServer!.conditionalRules![0].when = { column: "Status", operator: "equals" };
  assert.throws(() => generateSqlServerValidation(missingValue), /requires value/);
});

test("translates row tests to server-side count rules", () => {
  const input = contract();
  input.rowTests = [{ id: "one-row", select: { Status: "Open" }, expect: { count: { exact: 1 } } }];
  const result = generateSqlServerValidation(input);
  assert.equal(result.ruleCount, 7);
  assert.match(result.sql, /N'one-row-count-exact'/);
  assert.doesNotMatch(result.sql, /rowTests were not generated/);
});

test("translates shared conditional and grouped rules", () => {
  const input = contract();
  input.rules = [{
    id: "status-prefix",
    expect: { column: "Status", operator: "startsWith", value: "O" }
  }];
  input.groupRules = [{
    id: "source-status",
    groupBy: ["SourceType"],
    require: { column: "Status", values: ["Open"] }
  }];
  const result = generateSqlServerValidation(input);
  assert.match(result.sql, /N'status-prefix'/);
  assert.match(result.sql, /GROUP_REQUIRED_VALUE_MISSING/);
  assert.match(result.sql, /CHARINDEX|LEFT/);
});

test("the documented staging example parses and generates seven rules", async () => {
  const input = parseContract(await readFile("examples/sql-server-staging.csvtest.yaml", "utf8"));
  assert.equal(generateSqlServerValidation(input).ruleCount, 7);
  JSON.parse(await readFile("schemas/csvtest.schema.json", "utf8"));
});

test("resolves multiple tables and connection profiles without changing shared rules", () => {
  const input = contract();
  input.sqlServer = {
    rowLocator: ["SourceRow"],
    targets: [
      { name: "test", connection: "test-readonly", schema: "dbo", table: "Payroll" },
      { name: "prod", connection: "prod-readonly", schema: "reporting", table: "Payroll" }
    ]
  };
  const targets = resolveSqlServerTargets(input);
  assert.deepEqual(targets.map((target) => [target.name, target.connection, target.schema, target.table]), [
    ["test", "test-readonly", "dbo", "Payroll"],
    ["prod", "prod-readonly", "reporting", "Payroll"]
  ]);
  assert.match(generateSqlServerValidation(input, { target: targets[1] }).sql, /\[reporting\]\.\[Payroll\]/);
});

test("uses target-specific physical column names while preserving canonical report names", () => {
  const input = contract();
  input.sqlServer!.columnMap = {
    LoadId: "load_id",
    SourceRow: "source_row",
    Status: "status_code",
    CompletionDate: "completion_date",
    SourceType: "source_type",
    Category: "category_code"
  };
  const result = generateSqlServerValidation(input);
  assert.match(result.sql, /t\.\[load_id\]/);
  assert.match(result.sql, /t\.\[status_code\]/);
  assert.match(result.sql, /N'LoadId\.not-null' AS RuleId/);
  assert.match(result.sql, /N'LoadId' AS ColumnName/);
  assert.doesNotMatch(result.sql, /t\.\[LoadId\]/);
  assert.equal(result.rules.find((rule) => rule.id === "LoadId.not-null")?.column, "LoadId");
});

test("suggests conservative exact, case-insensitive, and standardized column mappings", () => {
  const suggestion = suggestSqlColumnMappings(
    ["CustomerId", "EmailAddress", "Status", "Unmapped"],
    ["customer_id", "EMAILADDRESS", "Status", "DifferentColumn"]
  );
  assert.deepEqual(suggestion.matches, [
    { contractColumn: "CustomerId", physicalColumn: "customer_id", method: "standardized" },
    { contractColumn: "EmailAddress", physicalColumn: "EMAILADDRESS", method: "case-insensitive" },
    { contractColumn: "Status", physicalColumn: "Status", method: "exact" }
  ]);
  assert.deepEqual(suggestion.columnMap, { CustomerId: "customer_id", EmailAddress: "EMAILADDRESS" });
  assert.deepEqual(suggestion.unmatched, ["Unmapped"]);
  assert.deepEqual(suggestion.ambiguous, []);
});

test("column mapping suggestions reserve exact matches before standardized matches", () => {
  const suggestion = suggestSqlColumnMappings(["customer_id", "CustomerId"], ["CustomerId"]);
  assert.deepEqual(suggestion.matches, [
    { contractColumn: "CustomerId", physicalColumn: "CustomerId", method: "exact" }
  ]);
  assert.deepEqual(suggestion.unmatched, ["customer_id"]);
});

test("rejects invalid target column maps before querying SQL Server", () => {
  const undeclared = contract();
  undeclared.sqlServer!.columnMap = { Missing: "missing_column" };
  assert.throws(() => resolveSqlServerTargets(undeclared, false), /maps undeclared contract columns: Missing/);

  const duplicate = contract();
  duplicate.sqlServer!.columnMap = { LoadId: "shared_column", SourceRow: "SHARED_COLUMN" };
  assert.throws(() => resolveSqlServerTargets(duplicate, false), /more than one contract column/);
});

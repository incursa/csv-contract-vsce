import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { CsvContract } from "../src/core/model";
import { parseContract } from "../src/core/contract";
import { generateSqlServerValidation } from "../src/core/sql-server-generator";

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
    "Category.matches was not generated because JavaScript regular expressions do not have an exact SQL Server equivalent."
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

test("reports CSV-only row tests as explicit translation warnings", () => {
  const input = contract();
  input.rowTests = [{ id: "one-row", select: { Status: "Open" }, expect: { count: { exact: 1 } } }];
  const result = generateSqlServerValidation(input);
  assert.ok(result.warnings.some((warning) => warning.startsWith("rowTests were not generated")));
  assert.match(result.sql, /-- WARNING: rowTests were not generated/);
});

test("the documented staging example parses and generates seven rules", async () => {
  const input = parseContract(await readFile("examples/sql-server-staging.csvtest.yaml", "utf8"));
  assert.equal(generateSqlServerValidation(input).ruleCount, 7);
  JSON.parse(await readFile("schemas/csvtest.schema.json", "utf8"));
});

import test from "node:test";
import assert from "node:assert/strict";
import { mergeImportedSchema, parseCreateTable, parseSqlSchemaSource } from "../src/core/sql-schema-import";
import type { CsvContract } from "../src/core/model";

const ddl = `
CREATE TABLE [staging].[Payroll Import]
(
    [LoadId] nvarchar(100) NOT NULL,
    [SourceRow] int NOT NULL,
    [Status] varchar(20) NULL CONSTRAINT [DF_Status] DEFAULT ('Open'),
    [Amount] decimal(19, 4) NULL,
    [Display] AS CONCAT([Status], ',', [SourceRow]),
    CONSTRAINT [PK_PayrollImport] PRIMARY KEY CLUSTERED ([LoadId], [SourceRow])
);
`;

test("imports SQL Server CREATE TABLE types, nullability, computed columns, and primary keys", () => {
  const [table] = parseCreateTable(ddl);
  assert.equal(table.schema, "staging");
  assert.equal(table.table, "Payroll Import");
  assert.deepEqual(table.primaryKeyColumns, ["LoadId", "SourceRow"]);
  assert.deepEqual(table.columns.map((column) => [column.name, column.sqlType, column.nullable, column.maxLength]), [
    ["LoadId", "nvarchar(100)", false, 100],
    ["SourceRow", "int", false, undefined],
    ["Status", "varchar(20)", true, 20],
    ["Amount", "decimal(19,4)", true, undefined],
    ["Display", "computed", true, undefined]
  ]);
  assert.equal(table.columns[3].precision, 19);
  assert.equal(table.columns[3].scale, 4);
  assert.equal(table.columns[4].computed, true);
});

test("imports Database Tracking canonical table models", () => {
  const [table] = parseSqlSchemaSource(JSON.stringify({
    schema: "staging", name: "Timecard", columns: [
      { ordinal: 1, name: "TimecardId", typeSchema: "sys", typeName: "bigint", maxLength: 8, precision: 19, scale: 0, nullable: false, identitySeed: "1" },
      { ordinal: 2, name: "Description", typeSchema: "sys", typeName: "nvarchar", maxLength: 400, precision: 0, scale: 0, nullable: true }
    ], indexes: [{ primaryKey: true, columns: [{ name: "TimecardId", keyOrdinal: 1, included: false }] }], checks: [], foreignKeys: [], triggers: []
  }), ".json");
  assert.equal(table.sourceKind, "database-tracking");
  assert.equal(table.columns[1].sqlType, "nvarchar(200)");
  assert.equal(table.columns[1].maxLength, 200);
  assert.equal(table.columns[0].identity, true);
  assert.deepEqual(table.primaryKeyColumns, ["TimecardId"]);
});

test("imports every table from a compact Database Knowledge snapshot", () => {
  const tables = parseSqlSchemaSource(JSON.stringify({ formatVersion: 1, objects: [
    { schema: "dbo", name: "Header", type: "table", columns: [{ ordinal: 1, name: "Id", dataType: "int", length: 4, precision: 10, scale: 0, nullable: false }], primaryKeys: [{ columns: [{ name: "Id" }] }] },
    { schema: "dbo", name: "ViewOnly", type: "view", columns: [] }
  ]}), ".json");
  assert.equal(tables.length, 1);
  assert.equal(tables[0].sourceKind, "database-knowledge");
  assert.equal(tables[0].table, "Header");
});

test("merges technical schema facts without overwriting reviewed business rules", () => {
  const existing: CsvContract = {
    version: 1,
    schema: { columns: {
      Status: { presence: "required", description: "Reviewed status", constraints: { notNull: true, maxLength: 12, allowedValues: ["Open", "Complete"] } },
      LegacyNote: { presence: "optional", constraints: { maxLength: 500 } }
    } },
    sqlServer: {
      schema: "old", table: "Old", detailLimit: 25,
      conditionalRules: [{ id: "status-rule", expect: { column: "Status", operator: "notBlank" } }]
    }
  };
  const [table] = parseCreateTable(ddl);
  const result = mergeImportedSchema(existing, table);
  assert.deepEqual(result.preview.addedColumns, ["LoadId", "SourceRow", "Amount", "Display"]);
  assert.deepEqual(result.preview.contractOnlyColumns, ["LegacyNote"]);
  assert.deepEqual(result.preview.preservedConflicts, ["Status.notNull", "Status.maxLength"]);
  assert.deepEqual(Object.keys(result.contract.schema.columns), ["LoadId", "SourceRow", "Status", "Amount", "Display", "LegacyNote"]);
  assert.deepEqual(result.contract.schema.columns.Status.constraints?.allowedValues, ["Open", "Complete"]);
  assert.equal(result.contract.schema.columns.Status.constraints?.maxLength, 12);
  assert.equal(result.contract.schema.columns.LegacyNote.constraints?.maxLength, 500);
  assert.equal(result.contract.sqlServer?.detailLimit, 25);
  assert.equal(result.contract.sqlServer?.conditionalRules?.[0].id, "status-rule");
  assert.equal(result.contract.sqlServer?.importedSchema?.sourceKind, "create-table");
  assert.deepEqual(result.contract.identity?.columns, ["LoadId", "SourceRow"]);
  assert.notEqual(result.contract, existing);
});

test("rejects invalid and unsupported schema sources", () => {
  assert.throws(() => parseCreateTable("SELECT 1;"), /No CREATE TABLE/);
  assert.throws(() => parseSqlSchemaSource("not json or ddl"), /CREATE TABLE script/);
  assert.throws(() => parseSqlSchemaSource('{"objects":[]}', ".json"), /no table objects/);
});

test("keeps generated identity and computed columns optional for CSV validation", () => {
  const [table] = parseCreateTable("CREATE TABLE dbo.Stage ([Id] bigint IDENTITY(1,1) NOT NULL PRIMARY KEY, [Value] varchar(10) NOT NULL, [Label] AS [Value] + 'x');");
  const merged = mergeImportedSchema({ version: 1, schema: { columns: {} } }, table).contract;
  assert.equal(merged.schema.columns.Id.presence, "optional");
  assert.equal(merged.schema.columns.Id.constraints, undefined);
  assert.equal(merged.schema.columns.Label.presence, "optional");
  assert.equal(merged.schema.columns.Value.constraints?.notNull, true);
  assert.equal(merged.identity, undefined);
});

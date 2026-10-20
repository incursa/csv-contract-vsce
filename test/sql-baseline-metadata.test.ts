import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptBaselineChanges, compareBaseline, parseBaseline, type BaselineSqlMetadata, type SchemaBaseline } from "../src/core/baseline";
import { SqlServerValidationSession, sqlSchemaSnapshot } from "../src/node/sql-server-validator";

const target = { connection: "mock", schema: "stage", table: "Child" };
const columns = [{ name: "TenantId", ordinal: 1 }, { name: "ParentId", ordinal: 2 }, { name: "Status", ordinal: 3 }];

const metadata = (): BaselineSqlMetadata => ({
  foreignKeys: { availability: "available", items: [{
    name: "FK_Child_Parent", schema: "stage", table: "Child", referencedSchema: "core", referencedTable: "Parent",
    columns: [
      { ordinal: 2, column: "ParentId", referencedColumn: "Id" },
      { ordinal: 1, column: "TenantId", referencedColumn: "TenantId" }
    ], updateAction: "NO_ACTION", deleteAction: "CASCADE"
  }] },
  indexes: { availability: "available", items: [{
    name: "IX_Child_Active", unique: true, disabled: false, filterPredicate: "([Status]=(1))",
    keyColumns: [
      { name: "ParentId", ordinal: 2, direction: "desc" },
      { name: "TenantId", ordinal: 1, direction: "asc" }
    ], includedColumns: [{ name: "Status", ordinal: 3 }]
  }] }
});

function baseline(sqlMetadata?: BaselineSqlMetadata): SchemaBaseline {
  return { baselineVersion: 1, revision: 1, capturedAt: "2026-10-12T00:00:00.000Z", sourceKind: "sql",
    captureMethod: "sql-metadata", object: { schema: target.schema, name: target.table }, columns, ...(sqlMetadata ? { sqlMetadata } : {}) };
}

test("SQL baseline canonicalizes ordered FK pairs and filtered index members", () => {
  const snapshot = sqlSchemaSnapshot(target, columns, metadata());
  assert.deepEqual(snapshot.sqlMetadata?.foreignKeys?.availability === "available" && snapshot.sqlMetadata.foreignKeys.items[0].columns.map(c => c.column), ["TenantId", "ParentId"]);
  assert.deepEqual(snapshot.sqlMetadata?.indexes?.availability === "available" && snapshot.sqlMetadata.indexes.items[0].keyColumns.map(c => `${c.ordinal}:${c.name}:${c.direction}`), ["1:TenantId:asc", "2:ParentId:desc"]);
  assert.equal(compareBaseline(baseline(metadata()), snapshot).length, 0);
});

test("legacy baselines do not interpret absent SQL metadata as deleted", () => {
  const current = sqlSchemaSnapshot(target, columns, metadata());
  assert.deepEqual(compareBaseline(baseline(), current), []);
});

test("requested but unavailable SQL metadata reports unknown rather than an empty collection", () => {
  const unavailable: BaselineSqlMetadata = { foreignKeys: { availability: "unavailable" }, indexes: { availability: "unavailable" } };
  assert.deepEqual(compareBaseline(baseline(metadata()), baseline(unavailable)).map(change => change.kind), ["unknown:foreignKeys", "unknown:indexes"]);
});

test("FK actions and filtered index definitions produce deterministic collection drift", () => {
  const changed = metadata();
  if (changed.foreignKeys?.availability === "available") changed.foreignKeys.items[0].deleteAction = "NO_ACTION";
  if (changed.indexes?.availability === "available") {
    changed.indexes.items[0].filterPredicate = "([Status]=(2))";
    changed.indexes.items[0].disabled = true;
  }
  assert.deepEqual(compareBaseline(baseline(metadata()), baseline(changed)).map(change => change.kind), ["foreignKeys", "indexes"]);
});

test("baseline parser retains canonical SQL metadata and unavailable metadata cannot be accepted", () => {
  const parsed = parseBaseline(JSON.stringify(baseline(metadata())));
  assert.equal(parsed.sqlMetadata?.foreignKeys?.availability, "available");
  assert.equal(parsed.sqlMetadata?.indexes?.availability, "available");
  const unavailable = baseline({ foreignKeys: { availability: "unavailable" }, indexes: { availability: "unavailable" } });
  const unknown = compareBaseline(parsed, unavailable)[0];
  assert.throws(() => acceptBaselineChanges(parsed, unavailable, [unknown.id]), /Unavailable metadata cannot be accepted/);
});

test("captureSchema uses parameter-bound catalog queries and groups synthetic metadata rows", async () => {
  const queries: string[] = [];
  const inputs: Array<[string, unknown]> = [];
  const session = new SqlServerValidationSession(() => { throw new Error("Synthetic capture must not resolve a connection."); });
  Object.defineProperty(session, "getPool", { value: async () => ({ api: { NVarChar: () => "nvarchar" }, pool: { request: () => {
    const request = { input(name: string, _type: unknown, value: unknown) { inputs.push([name, value]); return request; }, cancel() {}, async query(text: string) {
      queries.push(text);
      if (text.includes("FROM sys.columns AS c")) return { recordset: columns };
      assert.match(text, /sys\.foreign_key_columns/);
      assert.match(text, /sys\.index_columns/);
      return { recordset: [{ metadataAvailable: true }], recordsets: [
        [{ metadataAvailable: true }],
        [
          { name: "FK_Child_Parent", schema: "stage", table: "Child", referencedSchema: "core", referencedTable: "Parent", ordinal: 2, column: "ParentId", referencedColumn: "Id", updateAction: "NO_ACTION", deleteAction: "CASCADE" },
          { name: "FK_Child_Parent", schema: "stage", table: "Child", referencedSchema: "core", referencedTable: "Parent", ordinal: 1, column: "TenantId", referencedColumn: "TenantId", updateAction: "NO_ACTION", deleteAction: "CASCADE" }
        ],
        [
          { name: "IX_Child_Active", unique: 1, disabled: 0, filterPredicate: "([Status]=(1))", column: "Status", keyOrdinal: 0, indexColumnOrdinal: 3, descending: 0, included: 1 },
          { name: "IX_Child_Active", unique: 1, disabled: 0, filterPredicate: "([Status]=(1))", column: "TenantId", keyOrdinal: 1, indexColumnOrdinal: 1, descending: 0, included: 0 }
        ]
      ] };
    } };
    return request;
  } } }) });
  const captured = await session.captureSchema(target);
  assert.deepEqual(inputs, [["schema", "stage"], ["table", "Child"], ["schema", "stage"], ["table", "Child"]]);
  assert.equal(queries.length, 2);
  assert.equal(captured.sqlMetadata?.foreignKeys?.availability, "available");
  assert.equal(captured.sqlMetadata?.indexes?.availability === "available" && captured.sqlMetadata.indexes.items[0].includedColumns[0].name, "Status");
});

test("referenced-side FK metadata hidden by asymmetric permissions is unavailable, not empty", async () => {
  const session = new SqlServerValidationSession(() => { throw new Error("Synthetic capture must not resolve a connection."); });
  Object.defineProperty(session, "getPool", { value: async () => ({ api: { NVarChar: () => "nvarchar" }, pool: { request: () => {
    const request = { input() { return request; }, cancel() {}, async query(text: string) {
      if (text.includes("FROM sys.columns AS c")) return { recordset: columns };
      return { recordset: [{ metadataAvailable: true }], recordsets: [
        [{ metadataAvailable: true }],
        [{ name: "FK_Child_Hidden", schema: "stage", table: "Child", referencedSchema: null, referencedTable: null,
          ordinal: 1, column: "ParentId", referencedColumn: null, updateAction: "NO_ACTION", deleteAction: "NO_ACTION" }],
        []
      ] };
    } };
    return request;
  } } }) });
  const captured = await session.captureSchema(target);
  assert.deepEqual(captured.sqlMetadata?.foreignKeys, { availability: "unavailable" });
  assert.deepEqual(captured.sqlMetadata?.indexes, { availability: "available", items: [] });
});

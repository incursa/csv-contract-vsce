import { test } from "node:test";
import assert from "node:assert/strict";
import { SqlServerValidationSession, queryWithCancellation } from "../src/node/sql-server-validator";
import type { CsvContract } from "../src/core/model";

const target = { connection: "mock", schema: "dbo", table: "Synthetic" };
function sessionWithQuery(query: (text: string) => Promise<unknown>): SqlServerValidationSession {
  const session = new SqlServerValidationSession(() => { throw new Error("Mock tests must never resolve credentials or connect."); });
  Object.defineProperty(session, "getPool", { value: async () => ({ api: { NVarChar: () => "nvarchar" }, pool: { request: () => {
    const request = { input: () => request, query, cancel: () => {} };
    return request;
  } } }) });
  return session;
}
const contract: CsvContract = { version: 1, schema: { columns: { Id: { presence: "required" } } }, sqlServer: target,
  rules: [{ id: "constant", expect: { column: "Id", operator: "equals", value: "0001" } }] };

test("explicit SQL preview bounds retrieval and collects real passing/failing examples", async () => {
  const session = sessionWithQuery(async text => {
    if (text.includes("sys.columns")) return { recordset: [{ name: "Id", ordinal: 1 }] };
    assert.match(text, /SELECT TOP \(2\)/);
    return { recordset: [{ Id: "0001" }, { Id: "0002" }] };
  });
  const result = await session.validate(contract, target, { preview: { rowLimit: 2, exampleLimit: 1 } });
  assert.equal(result.preview?.scope, "sample");
  assert.deepEqual(result.ruleOutcomes, [{ id: "constant", selected: 2, passed: 1, failed: 1 }]);
  assert.deepEqual(result.examples?.map(e => e.outcome), ["passed", "failed"]);
});

test("SQL target baseline overrides contract baseline without changing either", async () => {
  const baseline = { baselineVersion: 1 as const, revision: 1, capturedAt: "2026-09-11T00:00:00Z", sourceKind: "sql" as const, captureMethod: "sql-metadata" as const, columns: [{ name: "Id", ordinal: 1, maxLength: 10 }] };
  const session = sessionWithQuery(async text => {
    if (text.includes("sys.columns")) return { recordset: [{ name: "Id", ordinal: 1, maxLength: 20 }] };
    if (text.includes("AS RuleId")) return { recordsets: [[{ RuleId: "constant", RuleName: "constant", Code: "RULE_EXPECTATION_FAILED", Severity: "error", FailureCount: 0, SelectedCount: 1 }]] };
    return { recordset: [{ count: 1 }] };
  });
  const result = await session.validate({ ...contract, baseline }, { ...target, baseline: { ...baseline, columns: [{ name: "Id", ordinal: 1, maxLength: 20 }] } });
  assert.equal(result.valid, true);
  assert.equal(baseline.columns[0].maxLength, 10);
});

test("SQL session preserves actual aggregate outcomes without retrieving example rows", async () => {
  const queries: string[] = [];
  const session = sessionWithQuery(async text => {
    queries.push(text);
    if (text.includes("sys.columns")) return { recordset: [{ name: "Id", ordinal: 1, sqlType: "nvarchar", nullable: false }] };
    if (text.includes("AS RuleId")) return { recordsets: [[{ RuleId: "constant", RuleName: "constant", Code: "RULE_EXPECTATION_FAILED", ColumnName: "", Severity: "error", FailureCount: 1, SelectedCount: 3 }]] };
    return { recordset: [{ count: 3 }] };
  });
  const result = await session.validate(contract, target);
  assert.equal(result.valid, false);
  assert.deepEqual(result.ruleOutcomes, [{ id: "constant", selected: 3, passed: 2, failed: 1 }]);
  assert(queries.every(q => !q.includes("t.*")));
});

test("metadata failures and missing SQL summaries are execution errors", async () => {
  const denied = sessionWithQuery(async () => { throw new Error("Metadata access denied"); });
  await assert.rejects(denied.validate(contract, target), /Metadata access denied/);
  const incomplete = sessionWithQuery(async text => text.includes("sys.columns") ? { recordset: [{ name: "Id", ordinal: 1 }] } : { recordsets: [[]] });
  await assert.rejects(incomplete.validate(contract, target), /did not return expected rule summaries/);
});

test("SQL date fallback carries native ISO dates without altering existing literal rules", async () => {
  const dates: CsvContract = { version: 1, schema: { columns: { Date: { presence: "required" } } }, sqlServer: target, rules: [
    { id: "literal", expect: { column: "Date", operator: "equals", value: "Sep 11 2026 12:00AM" } },
    { id: "date", expect: { column: "Date", operator: "dateOnOrAfter", value: "2026-09-11" } }
  ] };
  const session = sessionWithQuery(async text => {
    if (text.includes("sys.columns")) return { recordset: [{ name: "Date", ordinal: 1, sqlType: "datetime2" }] };
    assert.match(text, /127/);
    assert.match(text, /__csv_contract_date_0/);
    return { recordset: [{ Date: "Sep 11 2026 12:00AM", __csv_contract_date_0: "2026-09-11T00:00:00.0000000Z" }] };
  });
  const result = await session.validate(dates, target);
  assert.equal(result.valid, true);
  assert.equal(result.warningCount, 1);
  assert.deepEqual(result.ruleOutcomes?.map(r => r.passed), [1, 1]);
});

test("SQL cancellation invokes request.cancel and removes the listener after completion", async () => {
  const controller = new AbortController();
  let cancels = 0;
  let resolve!: (value: unknown) => void;
  const request = { query: () => new Promise(done => { resolve = done; }), cancel: () => { cancels++; } };
  const run = queryWithCancellation(request as Parameters<typeof queryWithCancellation>[0], "SELECT 1", controller.signal);
  controller.abort();
  assert.equal(cancels, 1);
  resolve({ recordset: [] });
  await run;
  await assert.rejects(queryWithCancellation(request as Parameters<typeof queryWithCancellation>[0], "SELECT 1", controller.signal));
  assert.equal(cancels, 1);
});

test("SQL transient retries are opt-in and never retry assertion results or permanent errors", async () => {
  const before = process.env.CSV_CONTRACT_SQL_RETRIES;
  try {
    process.env.CSV_CONTRACT_SQL_RETRIES = "1";
    let attempts = 0;
    const request = { cancel() {}, query: async () => { attempts++; if (attempts === 1) throw Object.assign(new Error("Synthetic timeout"), { code: "ETIMEOUT" }); return { recordset: [{ FailureCount: 1 }] }; } };
    const result = await queryWithCancellation(request as unknown as Parameters<typeof queryWithCancellation>[0], "SELECT 1");
    assert.equal(attempts, 2);
    assert.equal(result.recordset.length, 1);
    request.query = async () => { attempts++; throw Object.assign(new Error("Synthetic access denied"), { code: "EREQUEST" }); };
    await assert.rejects(queryWithCancellation(request as unknown as Parameters<typeof queryWithCancellation>[0], "SELECT 1"), /access denied/);
    assert.equal(attempts, 3);
  } finally { if (before === undefined) delete process.env.CSV_CONTRACT_SQL_RETRIES; else process.env.CSV_CONTRACT_SQL_RETRIES = before; }
});

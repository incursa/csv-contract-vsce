import { test } from "node:test";
import assert from "node:assert/strict";
import { crossResult, planCrossCheck, type CrossCheck, type SqlCrossConnectionPlan } from "../src/core/cross-checks";
import type { CsvContract } from "../src/core/model";
import { runSuite, type LoadedSuite } from "../src/core/suite";
import {
  createCrossConnectionExecutor,
  runCrossConnectionCheck,
  type CrossConnectionReadRequest,
  type CrossConnectionRow,
  type CrossConnectionSourceAdapter
} from "../src/node/cross-connection-runner";

const contract = (connection: string, table: string, columns: string[], scoped = false): CsvContract => ({
  version: 1,
  schema: { columns: Object.fromEntries(columns.map(column => [column, { presence: "required" as const }])) },
  sqlServer: {
    connection, schema: "dbo", table,
    ...(scoped ? { scope: { column: "LoadId", parameter: "load_id", sqlType: "nvarchar(40)" } } : {})
  }
});

const members = (scoped = false) => [
  { id: "source", contract: contract("left-profile", "SourceRows", ["Id", "Amount", "Ignored", ...(scoped ? ["LoadId"] : [])], scoped) },
  { id: "target", contract: contract("right-profile", "TargetRows", ["PersonId", "ExpectedAmount", "Ignored"], false) }
];

const check = (maxRows = 10): CrossCheck => ({
  id: "amount-relationship", kind: "relationship", from: "source", to: "target",
  keys: [{ from: "Id", to: "PersonId" }],
  lookup: { orderBy: [{ column: "PersonId", type: "string" }] },
  expect: { side: "from", column: "Amount", operator: "equalsColumn", other: { side: "to", column: "ExpectedAmount" } },
  missing: "fail", nulls: "fail", crossConnection: { enabled: true, maxRows }
});

function crossPlan(candidate = check(), scoped = false): SqlCrossConnectionPlan {
  const plan = planCrossCheck(candidate, members(scoped));
  assert.equal(plan.mode, "sql-cross-connection");
  if (plan.mode !== "sql-cross-connection") throw new Error("Expected cross-connection plan.");
  return plan;
}

class FakeAdapter implements CrossConnectionSourceAdapter {
  public readonly requests: Array<{ request: CrossConnectionReadRequest; signal?: AbortSignal }> = [];
  public constructor(
    private readonly rows: Record<string, CrossConnectionRow[]>,
    private readonly failure?: { participant: string; error: Error },
    private readonly limited?: string
  ) {}
  public async read(request: CrossConnectionReadRequest, signal?: AbortSignal) {
    this.requests.push({ request, signal });
    if (this.failure?.participant === request.participant) throw this.failure.error;
    return { rows: this.rows[request.participant] ?? [], limited: this.limited === request.participant };
  }
}

test("cross-connection planning is explicit and remains portable on one connection", async () => {
  const disabled = { ...check(), crossConnection: undefined };
  assert.throws(() => planCrossCheck(disabled, members()), /unless crossConnection\.enabled is explicitly set/);
  const plan = crossPlan();
  assert.deepEqual(plan.from.columns, ["Amount", "Id"]);
  assert.deepEqual(plan.to.columns, ["ExpectedAmount", "PersonId"]);
  assert(!plan.from.columns.includes("Ignored"));

  const mixedMembers = members();
  mixedMembers[1].contract = { version: 1, targets: [{ path: "target.csv" }], schema: mixedMembers[1].contract.schema };
  assert.throws(() => planCrossCheck(check(), mixedMembers), /mixed CSV and SQL participants are not supported/);

  const sameConnection = members();
  sameConnection[1].contract.sqlServer!.connection = "left-profile";
  const portable = planCrossCheck(check(), sameConnection);
  assert.equal(portable.mode, "sql-cross-connection");
  if (portable.mode !== "sql-cross-connection") throw new Error("Expected portable plan.");
  const caseSensitive = await runCrossConnectionCheck(portable, new FakeAdapter({
    source: [{ Id: "A", Amount: "1" }], target: [{ PersonId: "a", ExpectedAmount: "1" }]
  }));
  assert.equal(caseSensitive.valid, false);
});

test("reused members union role projections and are read only once", async () => {
  const both = contract("one-profile", "BothRoles", ["Id", "PersonId"]);
  const sameMember: CrossCheck = { id: "self", kind: "foreignKey", from: "both", to: "both",
    keys: [{ from: "Id", to: "PersonId" }], crossConnection: { enabled: true, maxRows: 10 } };
  const planned = planCrossCheck(sameMember, [{ id: "both", contract: both }]);
  assert.equal(planned.mode, "sql-cross-connection");
  if (planned.mode !== "sql-cross-connection") throw new Error("Expected portable plan.");
  const adapter = new FakeAdapter({ both: [{ Id: "1", PersonId: "1" }] });
  const result = await runCrossConnectionCheck(planned, adapter);
  assert.equal(result.valid, true);
  assert.equal(adapter.requests.length, 1);
  assert.deepEqual(adapter.requests[0].request.columns.map(column => column.logical), ["Id", "PersonId"]);
});

test("runner reads each connection independently and reuses bounded CSV cross-check semantics", async () => {
  const plan = crossPlan();
  const adapter = new FakeAdapter({
    source: [{ Id: "1", Amount: 10 }, { Id: "2", Amount: 99 }],
    target: [{ PersonId: "1", ExpectedAmount: 10 }, { PersonId: "2", ExpectedAmount: 20 }]
  });
  const result = await runCrossConnectionCheck(plan, adapter);
  assert.equal(result.valid, false);
  assert.equal(result.issueCount, 1);
  assert.equal(result.issues[0].evidence?.samples[0].primary?.values.Id, "2");
  assert.equal(adapter.requests.length, 2);
  assert(adapter.requests.every(({ request }) => request.readOnly && request.rowLimit === 11));
  assert.match(adapter.requests[0].request.sql, /^SELECT TOP \(11\) /);
  assert.match(adapter.requests[0].request.sql, /LEFT\(CONVERT\(nvarchar\(max\), \[Amount\], 126\), 65537\) AS \[Amount\].*LEFT\(CONVERT\(nvarchar\(max\), \[Id\], 126\), 65537\) AS \[Id\]/);
  assert.doesNotMatch(adapter.requests[0].request.sql, /Ignored|JOIN|OPENQUERY|DELETE|UPDATE|INSERT/);
  assert.match(adapter.requests[1].request.sql, /FROM \[dbo\]\.\[TargetRows\];$/);
});

test("runner requires scoped values and keeps them parameterized", async () => {
  const plan = crossPlan(check(10), true);
  const adapter = new FakeAdapter({ source: [], target: [] });
  await assert.rejects(() => runCrossConnectionCheck(plan, adapter), /requires a runtime scope value/);
  const result = await runCrossConnectionCheck(plan, adapter, { scopeValues: { source: "batch-'42" } });
  assert.equal(result.valid, true);
  const request = adapter.requests[0].request;
  assert.match(request.sql, /@cross_scope/);
  assert.match(request.sql, /TRY_CONVERT\(nvarchar\(40\), @cross_scope\)/);
  assert.doesNotMatch(request.sql, /batch-'42/);
  assert.equal(request.scope?.value, "batch-'42");
});

test("all scopes preflight before reads and SQL null remains distinct from a custom CSV marker", async () => {
  const bothScoped = members(true);
  bothScoped[1].contract.sqlServer!.scope = { column: "ExpectedAmount", parameter: "target_scope", sqlType: "int" };
  const planned = planCrossCheck(check(), bothScoped);
  assert.equal(planned.mode, "sql-cross-connection");
  if (planned.mode !== "sql-cross-connection") throw new Error("Expected portable plan.");
  const noReads = new FakeAdapter({ source: [], target: [] });
  await assert.rejects(() => runCrossConnectionCheck(planned, noReads, { scopeValues: { source: "A" } }), /target.*requires a runtime scope value/);
  assert.equal(noReads.requests.length, 0);

  const nullableSource = contract("left", "Nullable", ["Id"]); nullableSource.csv = { nullValues: ["NULL"] };
  const nullableTarget = contract("right", "Keys", ["PersonId"]);
  const nullCheck: CrossCheck = { id: "null", kind: "foreignKey", from: "source", to: "target",
    keys: [{ from: "Id", to: "PersonId" }], nulls: "ignore", crossConnection: { enabled: true, maxRows: 5 } };
  const nullPlan = planCrossCheck(nullCheck, [{ id: "source", contract: nullableSource }, { id: "target", contract: nullableTarget }]);
  assert.equal(nullPlan.mode, "sql-cross-connection");
  if (nullPlan.mode !== "sql-cross-connection") throw new Error("Expected portable plan.");
  assert.equal((await runCrossConnectionCheck(nullPlan, new FakeAdapter({ source: [{ Id: null }], target: [] }))).valid, true);
});

test("large SQL decimals are projected as text and compared without float rounding", async () => {
  const decimalCheck: CrossCheck = {
    id: "exact-total", kind: "equalTotal", from: "source", to: "target",
    valueColumns: { from: "Amount", to: "ExpectedAmount" }, tolerance: "0",
    crossConnection: { enabled: true, maxRows: 5 }
  };
  const plan = crossPlan(decimalCheck);
  const adapter = new FakeAdapter({
    source: [{ Amount: "9007199254740993.01" }],
    target: [{ ExpectedAmount: "9007199254740993.02" }]
  });
  const result = await runCrossConnectionCheck(plan, adapter);
  assert.equal(result.valid, false);
  assert.equal(result.issueCount, 1);
  assert.match(adapter.requests[0].request.sql, /CONVERT\(nvarchar\(max\), \[Amount\], 126\)/);
  assert.equal(result.issues[0].evidence?.aggregate?.fromTotal, "9007199254740993.01");

  const unsafe = new FakeAdapter({ source: [{ Amount: 9_007_199_254_740_992 }], target: [{ ExpectedAmount: "9007199254740992" }] });
  await assert.rejects(() => runCrossConnectionCheck(plan, unsafe), /cannot be represented exactly/);
});

test("over-limit and adapter failures reject instead of producing false PASS", async () => {
  const plan = crossPlan(check(2));
  const overLimit = new FakeAdapter({ source: [{ Id: "1" }, { Id: "2" }, { Id: "3" }], target: [] });
  await assert.rejects(() => runCrossConnectionCheck(plan, overLimit), /exceeded the controlled 2-row limit; result is unsupported/);

  const limited = new FakeAdapter({ source: [{ Id: "1" }], target: [] }, undefined, "source");
  await assert.rejects(() => runCrossConnectionCheck(plan, limited), /result is unsupported/);

  const unavailable = new Error("synthetic connection unavailable");
  const failed = new FakeAdapter({ source: [] }, { participant: "target", error: unavailable });
  await assert.rejects(() => runCrossConnectionCheck(plan, failed), unavailable);
});

test("suite integration records an over-limit source as ERROR rather than PASS", async () => {
  const candidate = check(2);
  const suite: LoadedSuite = { id: "controlled", source: "synthetic", isSuite: true, members: members().map(member => ({ ...member, source: "synthetic" })), crossChecks: [candidate] };
  const adapter = new FakeAdapter({ source: [{ Id: "1" }, { Id: "2" }, { Id: "3" }], target: [] });
  const report = await runSuite(suite, async () => crossResult(candidate, 0), false, undefined, {
    crossExecutor: createCrossConnectionExecutor(adapter)
  });
  const crossRun = report.runs.find(run => run.member === "cross:amount-relationship");
  assert.equal(crossRun?.status, "ERROR");
  assert.match(crossRun?.error ?? "", /result is unsupported/);
  assert.equal(report.status, "ERROR");
  assert.equal(report.valid, false);
});

test("executor forwards one cancellation signal to every source and discards canceled work", async () => {
  const plan = crossPlan();
  const controller = new AbortController();
  const adapter = new FakeAdapter({ source: [{ Id: "1", Amount: 1 }], target: [{ PersonId: "1", ExpectedAmount: 1 }] });
  const result = await createCrossConnectionExecutor(adapter)(plan, controller.signal);
  assert.equal(result.valid, true);
  assert.equal(adapter.requests.length, 2);
  assert(adapter.requests.every(call => call.signal === controller.signal));

  controller.abort();
  const canceled = new FakeAdapter({ source: [], target: [] });
  await assert.rejects(() => createCrossConnectionExecutor(canceled)(plan, controller.signal), /was canceled/);
  assert.equal(canceled.requests.length, 0);
});

test("invalid limits fail closed before any source is read", async () => {
  const invalid = check();
  invalid.crossConnection = { enabled: true, maxRows: 0 };
  const adapter = new FakeAdapter({ source: [], target: [] });
  await assert.rejects(() => runCrossConnectionCheck(crossPlan(invalid), adapter), /crossConnection\.maxRows must be an integer/);
  assert.equal(adapter.requests.length, 0);
  await assert.rejects(() => runCrossConnectionCheck(crossPlan(check(5)), new FakeAdapter({ source: [{ Id: "x".repeat(20), Amount: 1 }], target: [] }), { maxValueLength: 10 }), /value longer/);
});

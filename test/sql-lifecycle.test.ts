import test from "node:test";
import assert from "node:assert/strict";
import sql from "mssql";
import { withSqlSession } from "../src/node/sql-lifecycle";
import { SqlServerValidationSession, queryWithCancellation } from "../src/node/sql-server-validator";
import { runSuite } from "../src/core/suite";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSqlWorker } from "../src/node/sql-worker-client";

test("native worker returns only after process exit and force-cancels an unresponsive process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sql-worker-lifecycle-"));
  const worker = join(directory, "worker.cjs");
  await writeFile(worker, `const fs = require('node:fs');
    process.on('message', message => {
      if (message.kind === 'cancel') return;
      fs.writeFileSync(__filename + '.pid', String(process.pid));
      if (message.target.table === 'hang') { setInterval(() => {}, 1000); return; }
      process.send({ok:true,result:{valid:true,rowCount:process.pid}}, () => setTimeout(() => process.exit(0), 100));
    });`);
  const target = { connection: "mock", schema: "dbo", table: "complete" };
  try {
    const result = await runSqlWorker<import("../src/core/model").ValidationResult>({ kind: "schema", target }, undefined, worker);
    assert.throws(() => process.kill(result.rowCount, 0), /ESRCH|no such process/i);
    await rm(worker + ".pid");
    const controller = new AbortController();
    const canceled = runSqlWorker({ kind: "schema", target: { ...target, table: "hang" } }, controller.signal, worker, 100);
    const rejected = assert.rejects(canceled, /canceled; worker exited/);
    let pid: number | undefined;
    for (let i = 0; i < 200 && !pid; i++) {
      try { pid = Number(await readFile(worker + ".pid", "utf8")); } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    controller.abort();
    await rejected;
    assert(pid, "Synthetic child must have started.");
    assert.throws(() => process.kill(pid, 0), /ESRCH|no such process/i);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("packaged SQL worker exits with an error before attempting a profile connection", async () => {
  await assert.rejects(runSqlWorker({ kind: "schema", target: { connection: "never-connect", schema: "dbo", table: "T" } },
    undefined, join(process.cwd(), "dist/node/sql-worker.cjs")), /integrated connections only/);
});

test("suite targets finish cleanup before the next target starts or a report is returned", async () => {
  let open = 0;
  const events: string[] = [];
  const report = await runSuite({ id: "synthetic", source: "synthetic", isSuite: true, members: [{ id: "member", source: "synthetic", contract: {
    version: 1, schema: { columns: { Id: { presence: "required" } } },
    sqlServer: { targets: ["A", "B"].map(table => ({ connection: "mock", schema: "dbo", table })) }
  } }] }, async (_contract, target) => withSqlSession(() => {
    assert.equal(open, 0); open++;
    return { async dispose() { await Promise.resolve(); open--; events.push(`closed ${target.table}`); } };
  }, async () => {
    events.push(`ran ${target.table}`);
    return { valid: true, rowCount: 1, columnCount: 1, testCount: 1, issueCount: 0, errorCount: 0, warningCount: 0, truncated: false, issues: [] };
  }));
  assert.equal(report.valid, true); assert.equal(open, 0);
  assert.deepEqual(events, ["ran A", "closed A", "ran B", "closed B"]);
});

test("a failed connection attempt is closed without contacting a database", async () => {
  const prototype = sql.ConnectionPool.prototype;
  const connect = Object.getOwnPropertyDescriptor(prototype, "connect");
  const close = Object.getOwnPropertyDescriptor(prototype, "close");
  let closes = 0;
  Object.defineProperty(prototype, "connect", { configurable: true, value: async () => { throw new Error("synthetic login failure"); } });
  Object.defineProperty(prototype, "close", { configurable: true, value: async () => { closes++; } });
  try {
    await assert.rejects(withSqlSession(() => new SqlServerValidationSession(() => "Server=synthetic;Database=synthetic;"),
      session => session.captureSchema({ connection: "mock", schema: "dbo", table: "T" })), /synthetic login failure/);
    assert.equal(closes, 1);
  } finally {
    if (connect) Object.defineProperty(prototype, "connect", connect); else Reflect.deleteProperty(prototype, "connect");
    if (close) Object.defineProperty(prototype, "close", close); else Reflect.deleteProperty(prototype, "close");
  }
});

test("SQL operations await closure on success, assertion failure, execution error and cancellation", async () => {
  for (const outcome of ["success", "assertion", "error", "canceled"]) {
    let release!: () => void;
    let closing = false, completed = false;
    const closed = new Promise<void>(resolve => { release = resolve; });
    const operation = withSqlSession(() => ({ async dispose() { closing = true; await closed; } }), async () => {
      if (outcome === "error" || outcome === "canceled") throw new Error(outcome);
      return { valid: outcome === "success" };
    });
    const settled = operation.then(value => { completed = true; return value; }, error => { completed = true; return error; });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(closing, true); assert.equal(completed, false);
    release();
    const result = await settled;
    assert.equal(completed, true);
    if (outcome === "success" || outcome === "assertion") assert.equal(result.valid, outcome === "success");
    else assert.equal(result.message, outcome);
  }
});

test("cleanup failures prevent success and preserve the original execution error", async () => {
  const create = () => ({ async dispose() { throw new Error("close failed"); } });
  await assert.rejects(withSqlSession(create, async () => true), /closure could not be confirmed/);
  await assert.rejects(withSqlSession(create, async () => { throw new Error("query failed"); }), error => {
    assert(error instanceof AggregateError);
    assert.deepEqual(error.errors.map(e => e.message), ["query failed", "close failed"]);
    return true;
  });
});

test("session cleanup waits for every pool even if one close fails", async () => {
  const session = new SqlServerValidationSession(() => "unused");
  let release!: () => void;
  let secondClosed = false, completed = false;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  Object.defineProperty(session, "pools", { value: new Map([
    ["a", { pool: { async close() { throw new Error("first close failed"); } } }],
    ["b", { pool: { async close() { await waiting; secondClosed = true; } } }]
  ]) });
  const disposing = session.dispose().catch(error => { completed = true; return error; });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(completed, false);
  release();
  assert(await disposing instanceof AggregateError);
  assert.equal(secondClosed, true);
  await session.dispose();
  await assert.rejects(session.captureSchema({ connection: "unused", schema: "dbo", table: "Synthetic" }), /session is closed/);
});

test("driver destroy failures cannot be hidden by a successful pool close promise", async () => {
  const session = new SqlServerValidationSession(() => "unused");
  Object.defineProperty(session, "pools", { value: new Map([["mock", {
    closeFailures: [new Error("synthetic driver destroy timeout")], pool: { async close() {} }
  }]]) });
  await assert.rejects(session.dispose(), /pools failed to close/);
});

test("SQL batches explicitly disable implicit transactions", async () => {
  let executed = "";
  const request = { cancel() {}, async query(text: string) { executed = text; return { recordset: [] }; } };
  await queryWithCancellation(request as unknown as Parameters<typeof queryWithCancellation>[0], "SELECT 1;");
  assert.equal(executed, "SET IMPLICIT_TRANSACTIONS OFF;\nSELECT 1;");
});

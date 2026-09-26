import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify } from "yaml";
import type { CsvContract, OrderedRule } from "../src/core/model";
import { loadSuite } from "../src/core/suite";
import { fileSuiteIO } from "../src/node/suite-files";
import { validateCsv, parseContract } from "../src/core/contract";
import { validateCsvFile } from "../src/node/streaming-validator";
import { SqlServerValidationSession } from "../src/node/sql-server-validator";
import { generateSqlServerValidation } from "../src/core/sql-server-generator";

const headers = "EntityId,Event,Day,Seq,ExternalRef";
const ordered: OrderedRule = {
  id: "lifecycle",
  orderBy: [{ column: "Day", type: "date", format: "iso" }, { column: "Seq", type: "number", integer: true, minimum: 1 }],
  duplicateOrder: { id: "unique_order", message: "Order keys must be unique." },
  invalidOrder: { id: "valid_order", message: "Order keys must be valid." },
  event: { actionColumn: "Event", unmapped: { id: "known_event", message: "Event must have a reviewed mapping." },
    mappings: ["START", "NOTE", "PAUSE", "RESUME", "END", "RESTART"].map(event => ({ event, actionCodes: [event] })) },
  initial: { id: "starts_first", message: "START must be first.", state: "NEW", event: "START" },
  invalidTransition: { id: "valid_transition", message: "Event is not allowed in this state." },
  transitions: [
    { id: "start", message: "START opens the group.", from: "NEW", event: "START", to: "OPEN" },
    { id: "note", message: "NOTE requires an open group.", from: "OPEN", event: "NOTE", to: "OPEN" },
    { id: "pause", message: "PAUSE requires an open group.", from: "OPEN", event: "PAUSE", to: "PAUSED" },
    { id: "resume", message: "RESUME requires a paused group.", from: "PAUSED", event: "RESUME", to: "OPEN" },
    { id: "end", message: "END requires an open group.", from: "OPEN", event: "END", to: "ENDED" },
    { id: "restart", message: "RESTART requires an ended group.", from: "ENDED", event: "RESTART", to: "OPEN" }
  ],
  neutralEvents: ["NOTE"], finalStates: ["OPEN", "ENDED"],
  invalidFinal: { id: "final_state", message: "Group ends in an invalid state." },
  cardinality: [{ id: "one_start", message: "Exactly one START is required.", event: "START", exact: 1 }],
  adjacency: [
    { id: "pause_next", message: "PAUSE needs RESUME on the next day.", event: "PAUSE", following: "RESUME", dateRelation: "nextDay" },
    { id: "resume_previous", message: "RESUME needs PAUSE immediately before it.", event: "RESUME", preceding: "PAUSE" },
    { id: "end_next", message: "Any row after END must be RESTART later.", event: "END", following: "RESTART", dateRelation: "later", allowFinal: true },
    { id: "restart_previous", message: "RESTART needs END immediately before it.", event: "RESTART", preceding: "END" }
  ]
};

function child(): CsvContract {
  return { version: 1, schema: { rowCount: { min: 1 }, columns: {
    EntityId: { presence: "required" }, Event: { presence: "required" }, Day: { presence: "required" }, Seq: { presence: "required" }
  } }, orderedRules: [ordered] };
}

function parent(groupBy: string[] = ["EntityId"]): CsvContract {
  return { version: 1, schema: { columns: {
    EntityId: { presence: "required" }, Event: { presence: "required" }, Day: { presence: "required" },
    Seq: { presence: "required" }, ExternalRef: { presence: "optional" }
  } }, groupTests: [{ id: "events", groupBy, contract: child() }] };
}

async function withFiles(csv: string, action: (csvPath: string, specPath: string, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "csv-contract-groups-test-"));
  const csvPath = join(directory, "input.csv"), specPath = join(directory, "parent.csvtest.yaml");
  try {
    await writeFile(csvPath, csv);
    await writeFile(specPath, stringify(parent()));
    await action(csvPath, specPath, directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

const valid = [headers,
  "alpha,START,2026-01-01,1,old", "alpha,NOTE,2026-01-01,2,new", "alpha,NOTE,2026-01-01,3,new",
  "alpha,PAUSE,2026-01-02,1,new", "alpha,RESUME,2026-01-03,1,new", "alpha,END,2026-01-04,1,new",
  "beta,START,2026-02-01,1,other", "beta,NOTE,2026-02-01,2,other"].join("\n") + "\n";

test("child contracts validate multiple groups, same-day order, repeated neutral events and changed references", async () => {
  await withFiles(valid, async (csvPath, specPath) => {
    const result = (await validateCsvFile(csvPath, [{ spec: specPath, contract: parent() }])).runs[0].result;
    assert.equal(result.valid, true);
    assert.deepEqual(result.ruleOutcomes?.find(r => r.id === "events/one_start"),
      { id: "events/one_start", selected: 2, passed: 2, failed: 0 });
  });
});

test("group findings report group, source and related rows, and bound samples", async () => {
  const invalid = [headers, "alpha,START,2026-01-01,1,x", "alpha,PAUSE,2026-01-02,1,x",
    "alpha,NOTE,2026-01-02,1,x", "alpha,RESUME,2026-01-04,1,x", "beta,UNKNOWN,2026-02-01,1,y"].join("\n") + "\n";
  await withFiles(invalid, async (csvPath, specPath) => {
    const result = (await validateCsvFile(csvPath, [{ spec: specPath, contract: parent() }], { maxIssues: 3 })).runs[0].result;
    assert.equal(result.valid, false);
    assert(result.issueCount > result.issues.length);
    assert.equal(result.issues.length, 3);
    assert(result.issues.some(i => i.testId === "events/unique_order" && i.row === 4 && i.relatedRows?.includes(3)));
    assert(result.issues.every(i => i.group?.EntityId === "alpha"));
  });
});

test("terminal events, later restart, and required adjacency behave consistently", async () => {
  const passing = [headers, "alpha,START,2026-01-01,1,x", "alpha,END,2026-01-02,1,x",
    "alpha,RESTART,2026-01-03,1,x", "alpha,NOTE,2026-01-03,2,x"].join("\n") + "\n";
  const failing = [headers, "alpha,START,2026-01-01,1,x", "alpha,END,2026-01-02,1,x",
    "alpha,NOTE,2026-01-02,2,x", "alpha,RESTART,2026-01-03,1,x"].join("\n") + "\n";
  await withFiles(passing, async (csvPath, specPath) => {
    assert.equal((await validateCsvFile(csvPath, [{ spec: specPath, contract: parent() }])).valid, true);
  });
  await withFiles(failing, async (csvPath, specPath) => {
    const result = (await validateCsvFile(csvPath, [{ spec: specPath, contract: parent() }])).runs[0].result;
    assert(result.issues.some(i => i.testId === "events/end_next"));
    assert(result.issues.some(i => i.testId === "events/restart_previous"));
  });
});

test("reserved reason codes require a reviewed action mapping", () => {
  const definition = parent();
  const childContract = definition.groupTests![0].contract!;
  childContract.schema.columns.Reason = { presence: "required" };
  childContract.orderedRules![0] = { ...ordered, event: { ...ordered.event, reasonColumn: "Reason",
    reservedReasonCodes: ["HOLD"], mappings: [
      { event: "PAUSE", actionCodes: ["PAUSE"], reasonCodes: ["HOLD"] },
      ...ordered.event.mappings.map(mapping => ({ ...mapping, reasonPolicy: "any" as const }))
    ] } };
  const csv = "EntityId,Event,Reason,Day,Seq\nalpha,START,,2026-01-01,1\nalpha,NOTE,HOLD,2026-01-02,1\n";
  const result = validateCsv(definition, csv);
  assert(result.issues.some(i => i.testId === "events/known_event" && i.group?.EntityId === "alpha"));
});

test("whole-input groups run on empty data, and unordered child checks remain available", async () => {
  const whole = parent([]);
  whole.groupTests![0].contract = { version: 1, schema: { rowCount: { exact: 0 }, columns: { EntityId: { presence: "required" } } } };
  await withFiles(headers + "\n", async (csvPath, specPath) => {
    const result = (await validateCsvFile(csvPath, [{ spec: specPath, contract: whole }])).runs[0].result;
    assert.equal(result.valid, true);
  });
  await withFiles(headers + "\n", async (csvPath, specPath) => {
    const grouped = parent();
    grouped.groupTests![0].groupCount = { min: 1 };
    const result = (await validateCsvFile(csvPath, [{ spec: specPath, contract: grouped }])).runs[0].result;
    assert(result.issues.some(i => i.code === "GROUP_COUNT" && i.testId === "events"));
  });
  const unordered = parent();
  unordered.groupTests![0].contract = { version: 1, schema: { columns: { EntityId: { presence: "required" }, Event: { presence: "required" } } },
    groupRules: [{ id: "has_note", groupBy: ["EntityId"], require: { column: "Event", values: ["NOTE"] } }] };
  await withFiles([headers, "alpha,START,2026-01-01,1,x"].join("\n") + "\n", async (csvPath, specPath) => {
    const result = (await validateCsvFile(csvPath, [{ spec: specPath, contract: unordered }])).runs[0].result;
    assert(result.issues.some(i => i.testId === "events/has_note" && i.group?.EntityId === "alpha"));
  });
});

test("references resolve relative to parent, and cycles are rejected", async () => {
  await withFiles(valid, async (_csvPath, specPath, directory) => {
    await writeFile(join(directory, "child.csvtest.yaml"), stringify(child()));
    const reference = parent();
    reference.groupTests![0] = { id: "events", groupBy: ["EntityId"], ref: "./child.csvtest.yaml" };
    await writeFile(specPath, stringify(reference));
    const loaded = await loadSuite(specPath, fileSuiteIO);
    assert.equal(loaded.members[0].contract?.groupTests?.[0].resolvedContract?.orderedRules?.[0].id, "lifecycle");
    const cyclic = { ...reference, groupTests: [{ id: "events", groupBy: ["EntityId"], ref: "./parent.csvtest.yaml" }] };
    await writeFile(specPath, stringify(cyclic));
    await assert.rejects(loadSuite(specPath, fileSuiteIO), /reference cycle/i);
  });
});

test("large groups spill to disk and match the in-memory evaluator", async () => {
  const rows = [headers, "alpha,START,2026-01-01,1,x"];
  for (let index = 2; index <= 12050; index++) rows.push(`alpha,NOTE,2026-01-01,${index},x`);
  const csv = rows.join("\n") + "\n";
  await withFiles(csv, async (csvPath, specPath) => {
    const streamed = (await validateCsvFile(csvPath, [{ spec: specPath, contract: parent() }])).runs[0].result;
    const inMemory = validateCsv(parent(), csv);
    assert.equal(streamed.valid, true);
    assert.equal(streamed.valid, inMemory.valid);
    assert.equal(streamed.ruleOutcomes?.find(r => r.id === "events/unique_order")?.selected, 12050);
  });
});

test("SQL grouped evaluation uses bounded target reads and matches CSV findings", async () => {
  const csv = [headers, "alpha,START,2026-01-01,1,x", "alpha,PAUSE,2026-01-02,1,x"].join("\n") + "\n";
  const data = [{ EntityId: "alpha", Event: "START", Day: "2026-01-01", Seq: "1", ExternalRef: "x" },
    { EntityId: "alpha", Event: "PAUSE", Day: "2026-01-02", Seq: "1", ExternalRef: "x" }];
  await withFiles(csv, async (csvPath, specPath) => {
    const comparison = (await validateCsvFile(csvPath, [{ spec: specPath, contract: parent() }])).runs[0].result;
    const target = { connection: "mock", schema: "dbo", table: "Events" };
    const definition: CsvContract = { ...parent(), schema: { ...parent().schema, rowCount: { min: 1 } },
      sqlServer: { rowLocator: ["EntityId", "Day", "Seq"] } };
    const generated = generateSqlServerValidation(definition, { target, includeDetailQueries: false });
    const queries: string[] = [];
    const session = new SqlServerValidationSession(() => { throw new Error("Mock must not connect."); });
    Object.defineProperty(session, "getPool", { value: async () => ({ api: { NVarChar: () => "nvarchar" }, pool: { request: () => {
      const request = { input: () => request, cancel: () => {}, query: async (sql: string) => {
        queries.push(sql);
        if (sql.includes("sys.columns")) return { recordset: Object.keys(data[0]).map((name, index) => ({ name, ordinal: index + 1, sqlType: "nvarchar" })) };
        if (sql.includes("OFFSET")) return { recordset: data };
        if (sql.includes("RuleId")) return { recordsets: [generated.rules.map(rule => ({ RuleId: rule.id, RuleName: rule.name,
          Severity: rule.severity, Code: rule.code, ColumnName: "", FailureCount: 0, SelectedCount: null }))] };
        return { recordset: [{ count: data.length }] };
      } }; return request;
    } } }) });
    const sqlResult = await session.validate(definition, target);
    assert.deepEqual(sqlResult.issues.filter(i => i.testId?.startsWith("events/")).map(i => i.testId),
      comparison.issues.filter(i => i.testId?.startsWith("events/")).map(i => i.testId));
    assert(queries.some(q => /FETCH NEXT 2000 ROWS ONLY/.test(q)));
  });
});

test("schema accepts grouped child contracts and rejects undeclared keys", () => {
  assert.equal(parseContract(stringify(parent())).groupTests?.length, 1);
  const invalid = parent();
  invalid.groupTests![0].groupBy = ["Missing"];
  assert.throws(() => parseContract(stringify(invalid)), /undeclared column/);
});

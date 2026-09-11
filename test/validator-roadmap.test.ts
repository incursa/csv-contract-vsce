import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptBaselineChanges, compareBaseline, CsvSchemaObservation, parseBaseline, type SchemaBaseline } from "../src/core/baseline";
import { readEditorContract, updateEditorContract } from "../src/core/editor-document";
import { validateCsv } from "../src/core/contract";
import { validateCsvFile } from "../src/node/streaming-validator";
import type { CsvContract } from "../src/core/model";
import { LiveTests } from "../src/core/live-tests";
import { insertPreset } from "../src/core/presets";
import { insertTemplate, coverageDiagnostics } from "../src/core/authoring";
import { crossResult, planCrossCheck } from "../src/core/cross-checks";
import { runSuite, type LoadedSuite } from "../src/core/suite";
import { renderResults, filterResultRuns, issueSelectionKey } from "../src/results-view";
import { issueRunsToCsv } from "../src/issue-export";
import { summarizeRules, compareRules } from "../src/core/history";
import { JSDOM } from "jsdom";
import { renderPredicate, readPredicate, editPredicateTree } from "../src/webview/rule-editor";

test("preview samples count actual outcomes, bound examples, and never pass a complete suite", async () => {
  const contract: CsvContract = { version: 1, targets: [{ path: "local.csv" }], schema: { columns: { Id: { presence: "required" } } }, rules: [{ id: "check", expect: { column: "Id", operator: "equals", value: "yes" } }] };
  const result = validateCsv(contract, "Id\nyes\nno\nyes\nno\n", undefined, undefined, { rowLimit: 3, exampleLimit: 1 });
  assert.equal(result.rowCount, 3);
  assert.deepEqual(result.ruleOutcomes, [{ id: "check", selected: 3, passed: 2, failed: 1 }]);
  assert.equal(result.examples?.length, 2);
  assert.match(renderResults([{ result }]), /SAMPLED/);
  const report = await runSuite({ id: "s", source: "s", isSuite: false, members: [{ id: "m", source: "m", contract }] }, async () => result, false, async () => result);
  assert.equal(report.status, "SAMPLED"); assert.equal(report.valid, false);
  assert.throws(() => validateCsv(contract, "Id\n", undefined, undefined, { rowLimit: 0, exampleLimit: 1 }), /row limit/);
});

test("history compares stable rules without retaining literals or inventing missing outcomes", () => {
  const result = validateCsv({ version: 1, schema: { columns: { Id: { presence: "required" } } }, rules: [{ id: "id", expect: { column: "Id", operator: "equals", value: "secret-literal" } }] }, "Id\nprivate-value\n");
  const summaries = summarizeRules(result);
  assert.deepEqual(summaries, [{ id: "id", selected: 1, passed: 0, failed: 1, retainedIssues: 1 }]);
  assert.doesNotMatch(JSON.stringify(summaries), /secret|private/);
  assert.equal(compareRules([], summaries)[0].availability, "only-current");
  assert.equal(compareRules(summaries, [])[0].after, undefined);
});

test("cross-table scopes are independently parameterized on both sides", () => {
  const make = (valueEnvironment: string): CsvContract => ({ version: 1, schema: { columns: { Id: { presence: "required" } } }, sqlServer: { connection: "local", schema: "dbo", table: "T", scope: { column: "Batch]Id", parameter: "load", sqlType: "nvarchar(20)", valueEnvironment } } });
  for (const kind of ["foreignKey", "equalPopulation", "equalTotal"] as const) {
    const plan = planCrossCheck({ id: "scoped", kind, from: "a", to: "b", keys: [{ from: "Id", to: "Id" }], valueColumns: { from: "Id", to: "Id" } }, [{ id: "a", contract: make("LEFT_BATCH") }, { id: "b", contract: make("RIGHT_BATCH") }]);
    assert.match(plan.sql, /@cross_from/); assert.match(plan.sql, /@cross_to/);
    assert.match(plan.sql, /\[Batch\]\]Id\]/);
    assert.equal(plan.from.scope?.valueEnvironment, "LEFT_BATCH");
    assert.equal(plan.to.scope?.valueEnvironment, "RIGHT_BATCH");
    assert.doesNotMatch(plan.sql, /LEFT_BATCH|RIGHT_BATCH/);
  }
});

test("nested branch editing preserves literals, order and nonempty predicates", () => {
  const dom = new JSDOM(`<form>${renderPredicate({ all: [{ column: "Id", operator: "equals", value: "0001" }] }, ["Id"])}</form>`);
  const doc = dom.window.document;
  const act = (selector: string) => editPredicateTree(doc.querySelector(selector)! as unknown as HTMLElement, ["Id"]);
  act('[data-predicate="group"] > [data-predicate-action="add"]');
  act('fieldset > fieldset:last-child [data-predicate-action="up"]');
  assert.deepEqual(readPredicate(doc.querySelector("fieldset")!), { all: [{ column: "Id", operator: "notNull" }, { column: "Id", operator: "equals", value: "0001" }] });
  act('fieldset > fieldset:first-of-type [data-predicate-action="remove"]');
  assert.throws(() => act('fieldset > fieldset [data-predicate-action="remove"]'), /at least one/);
  assert.deepEqual(readPredicate(doc.querySelector("fieldset")!), { all: [{ column: "Id", operator: "equals", value: "0001" }] });
});

test("selected result exports preserve counts and reject stale identities", () => {
  const result = validateCsv({ version: 1, schema: { columns: { Id: { presence: "required", constraints: { notNull: true } } } } }, 'Id,Other\n,x\n,y\n');
  const run = { workId: "run:1", runId: "run", evaluatedAt: "2026-09-11T00:00:00Z", scope: "all", target: "local", status: "FAIL", result };
  const selected = [issueSelectionKey(run, 0)];
  const filtered = filterResultRuns([run], "", selected);
  assert.equal(filtered[0].result.issues.length, 1);
  assert.equal(filtered[0].result.issueCount, result.issueCount);
  assert.equal(filtered[0].result.truncated, true);
  assert.match(issueRunsToCsv(filtered, { stale: true, selected }), /EvaluatedAt/);
  assert.match(issueRunsToCsv(filtered, { stale: true, selected }), /stale/);
  assert.throws(() => filterResultRuns([{ ...run, workId: "new:1" }], "", selected), /stale/);
  assert.equal(filterResultRuns([{ target: "x", status: "ERROR", error: "permission denied" }], "absent").length, 0);
});
import { previewContract } from "../src/core/preview";
import { resolveEvaluation } from "../src/core/evaluation";

test("relative dates, typed literals, precision and identity policies share streaming semantics", async () => {
  const evaluatedAt = "2026-09-11T12:34:56Z";
  const base: CsvContract = { version: 1, csv: { nullValues: ["", "NULL"] }, schema: { columns: { Id: { presence: "required" }, Date: { presence: "required" }, Amount: { presence: "required" } } } };
  let contract = insertPreset(base, { id: "recent", kind: "dateRange", column: "Date", dateAnchor: "today", minimum: "-1", maximum: "0" });
  contract = insertPreset(contract, { id: "money", kind: "numberRange", column: "Amount", minimum: "0", decimalPlaces: 2 });
  contract = insertPreset(contract, { id: "numeric-id", kind: "allowed", column: "Id", values: ["1"], valueType: "number", nulls: "ignore" });
  contract = insertPreset(contract, { id: "key", kind: "unique", column: "Id", columns: ["Id", "Date"], nulls: "allow" });
  const resolved = resolveEvaluation(contract, evaluatedAt);
  assert.match(JSON.stringify(resolved.rules?.[0]), /2026-09-10T00:00:00.000Z/);
  assert.match(JSON.stringify(contract.rules?.[0]), /relativeDate/);
  const csv = 'Id,Date,Amount\n0001,2026-09-10,1.20\n,2026-09-11,1.234\nNULL,2026-09-11,2\n';
  const memory = validateCsv(contract, csv, undefined, evaluatedAt);
  assert.equal(memory.errorCount, 2);
  assert.ok(memory.issues.some(i => i.testId === "key"));
  const directory = await mkdtemp(join(tmpdir(), "validator-policy-"));
  try {
    const file = join(directory, "data.csv"); await writeFile(file, csv);
    const streamed = await validateCsvFile(file, [{ spec: join(directory, "contract.yaml"), contract }], { evaluatedAt });
    assert.equal(streamed.runs[0].result.errorCount, memory.errorCount);
    assert.equal(streamed.runs[0].result.evaluatedAt, evaluatedAt);
    assert.deepEqual(streamed.runs[0].result.ruleOutcomes, memory.ruleOutcomes);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
import { preflight } from "../src/core/preflight";

test("aggregate previews isolate selected row/group rules without inventing row outcomes", () => {
  const contract: CsvContract = { version: 1, schema: { columns: { Id: { presence: "required", constraints: { unique: true } } } }, rowTests: [{ id: "population", select: { Id: "0001" }, expect: { count: { exact: 2 } } }], rules: [{ id: "unrelated", expect: { column: "Id", operator: "isNull" } }] };
  const result = validateCsv(previewContract(contract, "population"), "Id\n0001\n0001\n");
  assert.equal(result.valid, true);
  assert.equal(result.ruleOutcomes?.length ?? 0, 0);
  assert.equal(contract.schema.columns.Id.constraints?.unique, true);
});

test("shared preflight distinguishes missing columns from metadata execution errors", async () => {
  const contract: CsvContract = { version: 1, schema: { columns: { Id: { presence: "required" } } }, sqlServer: { targets: [{ schema: "dbo", table: "A", connection: "local" }, { schema: "dbo", table: "B", connection: "local" }] } };
  const result = await preflight(contract, async target => {
    if (target.table === "B") throw new Error("Synthetic permission denied");
    return { ...manual(), columns: [{ name: "Other", ordinal: 1 }] };
  });
  assert.deepEqual(result.map(r => r.status), ["FAIL", "ERROR"]);
  assert.match(result[1].message, /permission denied/);
});

const manual = (): SchemaBaseline => ({ baselineVersion: 1, revision: 1, capturedAt: "2026-09-11T00:00:00Z", sourceKind: "manual", captureMethod: "manual", columns: [{ name: "Id", ordinal: 1, sqlType: "nvarchar", maxLength: 20, nullable: false }] });
test("total checks quote mappings, reject tolerance injection and retain invalid-input guards", () => {
  const contract: CsvContract = { version: 1, schema: { columns: { Amount: { presence: "required" } } }, sqlServer: { connection: "synthetic", schema: "dbo", table: "Ledger", columnMap: { Amount: "Amount]Value" } } };
  const members = [{ id: "a", contract }, { id: "b", contract }];
  const check = { id: "total", kind: "equalTotal" as const, from: "a", to: "b", valueColumns: { from: "Amount", to: "Amount" }, tolerance: "0.001", nulls: "fail" as const };
  const plan = planCrossCheck(check, members);
  assert.match(plan.sql, /\[Amount\]\]Value\]/);
  assert.match(plan.sql, /decimal\(28,10\)/);
  assert.match(plan.sql, /IS NULL THEN 1/);
  assert.match(plan.sql, /Invalid/);
  assert.throws(() => planCrossCheck({ ...check, tolerance: "0'; DROP TABLE x" }, members), /tolerance/);
});

test("mapped baseline acceptance updates only the selected physical-column property", () => {
  const before = { ...manual(), columns: [{ ...manual().columns[0], name: "PhysicalId" }] };
  const after = { ...before, columns: [{ ...before.columns[0], maxLength: 10, nullable: true }] };
  const changes = compareBaseline(before, after, undefined, { Id: "PhysicalId" });
  const next = acceptBaselineChanges(before, after, [changes.find(c => c.kind === "maxLength")!.id], { Id: "PhysicalId" });
  assert.equal(next.columns[0].name, "PhysicalId");
  assert.equal(next.columns[0].maxLength, 10);
  assert.equal(next.columns[0].nullable, false);
});
test("drift retains unknown metadata, before/after, narrowing and explicit selective acceptance", () => {
  const before = manual();
  const after = manual();
  after.columns[0].maxLength = 10;
  after.columns[0].nullable = true;
  after.columns.push({ name: "Added", ordinal: 2 });
  const drift = compareBaseline(before, after);
  assert.deepEqual(drift.map(c => c.kind), ["maxLength", "nullable", "added"]);
  const accepted = acceptBaselineChanges(before, after, [drift[0].id]);
  assert.equal(accepted.revision, 2);
  assert.equal(accepted.columns[0].maxLength, 10);
  assert.equal(accepted.columns[0].nullable, false);
  assert.equal(accepted.columns.length, 1);
  assert.equal(before.columns[0].maxLength, 20);
  delete after.columns[0].maxLength;
  assert(compareBaseline(before, after).some(c => c.kind === "unknown:maxLength"));
  assert.throws(() => parseBaseline(JSON.stringify({ ...before, password: "never" })));
});
test("CSV observations preserve leading zeros and distinguish inference from declarations", () => {
  const observed = new CsvSchemaObservation(["Id", "Amount"]);
  observed.add(["0001", "2.5"]);
  observed.add(["0002", ""]);
  const baseline = observed.snapshot("sample");
  assert.equal(baseline.columns[0].observedType, "string");
  assert.equal(baseline.columns[1].observedType, "number");
  assert.equal(baseline.columns[1].observedNullable, true);
  assert.equal(baseline.columns[1].nullable, undefined);
  assert.equal(baseline.inference?.scope, "sample");
});
test("inline editor preserves sibling contracts, literals, metadata, comments and stable IDs", () => {
  const text = '# suite comment\nsuiteVersion: 1\nid: suite\nmembers:\n  - id: alpha\n    contract:\n      version: 1\n      metadata: {note: keep}\n      schema:\n        columns:\n          Id: {presence: required} # keep column\n      rules:\n        - id: literal # keep rule\n          expect: {column: Id, operator: equals, value: "0001"}\n  - id: beta\n    contract:\n      version: 1\n      schema: {columns: {Other: {presence: optional}}}\n';
  const contract = readEditorContract(text, "alpha");
  contract.schema.columns.Id.constraints = { notNull: true };
  const result = updateEditorContract(text, contract, "alpha");
  assert.match(result, /# keep rule/);
  assert.match(result, /# suite comment/);
  assert.equal(readEditorContract(result, "alpha").rules?.[0].expect && JSON.stringify(readEditorContract(result, "alpha").rules), JSON.stringify(contract.rules));
  assert.deepEqual(readEditorContract(result, "beta"), readEditorContract(text, "beta"));
});
test("CSV baseline and date predicates have streaming and in-memory parity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "roadmap-"));
  try {
    const contract: CsvContract = { version: 1, schema: { columns: { Id: { presence: "required" }, Date: { presence: "required" } } },
      baseline: { ...manual(), columns: [{ name: "Id", ordinal: 1 }, { name: "Date", ordinal: 2 }] },
      rules: [{ id: "date", expect: { all: [{ column: "Date", operator: "dateOnOrAfter", value: "2026-01-01" }, { column: "Date", operator: "dateBefore", value: "2027-01-01" }] } }] };
    const csv = "Id,Date,Added\n0001,2026-02-01,x\n0002,2026-02-30,x\n0003,2027-01-01,x\n";
    const path = join(directory, "local.csv");
    await writeFile(path, csv);
    const memory = validateCsv(contract, csv);
    const stream = await validateCsvFile(path, [{ spec: join(directory, "contract.yaml"), contract }]);
    assert.equal(memory.errorCount, 3);
    assert.equal(stream.runs[0].result.errorCount, memory.errorCount);
    assert(stream.runs[0].result.issues.some(i => i.code === "SCHEMA_DRIFT"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("presets preserve literal identifiers and previews report actual selected/pass/fail counts", () => {
  let contract: CsvContract = { version: 1, schema: { columns: { Id: { presence: "required" }, Status: { presence: "required" } } } };
  contract = insertPreset(contract, { kind: "constant", id: "constant-id", column: "Id", value: "0001", nulls: "fail" });
  const result = validateCsv(contract, "Id,Status\n0001,A\n0002,A\n,B\n");
  assert.deepEqual(result.ruleOutcomes, [{ id: "constant-id", selected: 3, passed: 1, failed: 2 }]);
  assert.throws(() => insertPreset(contract, { kind: "constant", id: "constant-id", column: "Id", value: "x" }), /already exists/);
  contract = insertPreset(contract, { kind: "requiredWhen", id: "zero", column: "Id", otherColumn: "Status", value: "Missing" });
  const zero = validateCsv(contract, "Id,Status\n0001,A\n");
  assert.equal(zero.ruleOutcomes?.[1].selected, 0);
  assert.match(renderResults([{ target: "synthetic", result: zero }]), /No rows matched/);
});

test("live edits debounce, invalid drafts never run, and superseded work cannot publish or overlap", async () => {
  const events: string[] = [];
  const completions: string[] = [];
  let finish!: () => void;
  let active = 0, maximum = 0;
  const live = new LiveTests<string, string>(async value => {
    active++; maximum = Math.max(active, maximum); events.push(value);
    if (value === "slow") await new Promise<void>(resolve => { finish = resolve; });
    active--; return value;
  }, value => completions.push(value), error => { throw error; }, 5);
  const tick = () => new Promise(resolve => setTimeout(resolve, 25));
  live.change({ key: "opening", value: "opening" });
  await tick(); assert.deepEqual(events, []);
  live.change({ key: "slow", value: "slow" }); live.enable();
  await tick();
  live.change({ key: "intermediate", value: "intermediate" });
  live.change();
  live.change({ key: "newest", value: "newest" });
  await tick(); finish(); await tick();
  assert.deepEqual(events, ["slow", "newest"]);
  assert.deepEqual(completions, ["newest"]);
  assert.equal(maximum, 1);
  live.pause(); live.change({ key: "paused", value: "paused" }); await tick();
  assert.deepEqual(completions, ["newest"]);
  live.dispose();
});

test("selective and canceled suite runs never report overall PASS; cross-checks execute with dependencies", async () => {
  const contract = (table: string): CsvContract => ({ version: 1, schema: { columns: { Id: { presence: "required" } } }, sqlServer: { connection: "local", schema: "dbo", table } });
  const suite: LoadedSuite = { id: "local", source: "suite", isSuite: true, members: [{ id: "child", source: "suite", contract: contract("Child") }, { id: "parent", source: "suite", contract: contract("Parent") }], crossChecks: [{ id: "fk", kind: "foreignKey", from: "child", to: "parent", keys: [{ from: "Id", to: "Id" }], nulls: "fail" }] };
  const plan = planCrossCheck(suite.crossChecks![0], suite.members);
  assert.match(plan.sql, /NOT EXISTS/);
  let checks = 0;
  const report = await runSuite(suite, async () => validateCsv(contract("Unused"), "Id\nx\n"), false, undefined, { members: ["child"], crossExecutor: async plan => { checks++; return crossResult(plan.check, 0); } });
  assert.equal(checks, 1); assert.equal(report.status, "SKIPPED"); assert.equal(report.valid, false);
  const controller = new AbortController(); controller.abort();
  const canceled = await runSuite(suite, async () => { throw new Error("must not run"); }, false, undefined, { signal: controller.signal });
  assert.equal(canceled.status, "CANCELED");
  suite.members[1].contract!.sqlServer!.connection = "other";
  assert.throws(() => planCrossCheck(suite.crossChecks![0], suite.members), /same connection/);
  assert.throws(() => crossResult(suite.crossChecks![0], undefined));
});

test("parameterized templates insert ordinary immutable rules and coverage identifies gaps", () => {
  const contract: CsvContract = { version: 1, schema: { columns: { Id: { presence: "required" } } } };
  assert(coverageDiagnostics(contract).some(d => d.includes("No substantive")));
  const template = { templateVersion: 1 as const, name: "Identifier", parameters: ["column", "literal"], rules: [{ id: "id", expect: { column: "${column}", operator: "equals" as const, value: "${literal}" } }] };
  const inserted = insertTemplate(contract, template, { column: "Id", literal: "0001" });
  assert.equal(validateCsv(inserted, "Id\n0001\n").valid, true);
  assert.equal(contract.rules, undefined);
  assert.equal(template.rules[0].expect.value, "${literal}");
});

test("native SQL date interpretation does not change ordinary string assertions", () => {
  const contract: CsvContract = { version: 1, schema: { columns: { Date: { presence: "required" } } }, rules: [
    { id: "raw", expect: { column: "Date", operator: "equals", value: "Sep 11 2026 12:00AM" } },
    { id: "date", expect: { column: "Date", operator: "dateOnOrAfter", value: "2026-09-11" } }
  ] };
  const result = validateCsv(contract, "Date\nSep 11 2026 12:00AM\n", { Date: ["2026-09-11T00:00:00.0000000Z"] });
  assert.equal(result.valid, true);
  assert.deepEqual(result.ruleOutcomes?.map(r => r.passed), [1, 1]);
});

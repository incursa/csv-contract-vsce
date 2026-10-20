import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import type { CsvContract } from "../src/core/model";
import { validateCsv } from "../src/core/contract";
import { generateSuiteSql, loadSuite, parseSuite, runSuite } from "../src/core/suite";
import { applySuiteTargetPolicy, diagnoseSuiteTargetPolicy, resolveSuiteSqlServerTargets, type SuiteTargetPolicy } from "../src/core/suite-target-policy";
import { combineSuite, fileSuiteIO, splitSuite } from "../src/node/suite-files";

const targetsContract = (): CsvContract => ({
  version: 1,
  schema: { columns: { Id: { presence: "required" } } },
  sqlServer: {
    targets: [
      { id: "app-dev", environment: "dev", enabled: true, connection: "test", schema: "dbo", table: "DevRows" },
      { id: "app-prod", environment: "prod", enabled: false, connection: "test", schema: "dbo", table: "ProdRows" },
      { id: "app-qa", environment: "qa", connection: "test", schema: "dbo", table: "QaRows" }
    ]
  }
});
const production: SuiteTargetPolicy = { sqlServer: { environments: { dev: false, prod: true } } };

test("target policy precedence is deterministic, extensible, and non-mutating", () => {
  const contract = targetsContract();
  const before = structuredClone(contract);
  const resolved = resolveSuiteSqlServerTargets(contract, production, [{ target: "app-prod", enabled: false }]);
  assert.deepEqual(resolved.targets.map((target) => [target.id, target.enabled, target.enabledSource]), [
    ["app-dev", false, "suite-policy"],
    ["app-prod", false, "member-override"],
    ["app-qa", true, "default"]
  ]);
  assert.deepEqual(contract, before);
  assert.equal(applySuiteTargetPolicy(contract, production).sqlServer?.targets?.[0].enabled, false);
  assert.equal(contract.sqlServer?.targets?.[0].enabled, true);
  assert.deepEqual(diagnoseSuiteTargetPolicy({ sqlServer: { environments: { sandbox: true } } }, [contract]).map((item) => item.environment), ["sandbox"]);
});

test("target IDs and member overrides reject ambiguous or unknown identities", () => {
  const duplicate = targetsContract();
  duplicate.sqlServer!.targets![1].id = "app-dev";
  assert.throws(() => resolveSuiteSqlServerTargets(duplicate), /unique within its contract/);
  assert.throws(() => resolveSuiteSqlServerTargets(targetsContract(), undefined, [{ target: "missing", enabled: true }]), /unknown SQL Server target id 'missing'/);
  const idless = targetsContract();
  delete idless.sqlServer!.targets![0].id;
  assert.throws(() => resolveSuiteSqlServerTargets(idless, production), /must declare a stable id/);
  assert.throws(() => parseSuite(stringify({ suiteVersion: 1, id: "bad", members: [{ id: "member", ref: "x.csvtest.yaml", targetOverrides: [
    { target: "app-dev", enabled: true }, { target: "app-dev", enabled: false }
  ] }] })), /duplicate target override/);
});

test("id-less legacy targets use stable target indexes and cannot collide on the same table", async () => {
  const contract: CsvContract = { version: 1, schema: { columns: { Id: { presence: "required" } } }, sqlServer: { targets: [
    { connection: "first", schema: "dbo", table: "Rows" }, { connection: "second", schema: "dbo", table: "Rows" }
  ] } };
  const suite = { id: "legacy", source: "legacy", isSuite: true, members: [{ id: "member", source: "legacy", contract }] };
  const run = () => runSuite(suite, async (definition) => validateCsv(definition, "Id\n1\n"));
  const first = await run();
  const second = await run();
  assert.equal(new Set(first.runs.map((item) => item.workId)).size, 2);
  assert.deepEqual(first.runs.map((item) => item.workId), second.runs.map((item) => item.workId));
  assert.notEqual(first.runs[0].scope, first.runs[1].scope);
});

test("runSuite reports disabled suite targets as skipped and executes the same effective set as SQL generation", async () => {
  const contract = targetsContract();
  const suite = { id: "production", source: "inline", isSuite: true, targetPolicy: production,
    members: [{ id: "app", source: "inline", contract }] };
  const executed: string[] = [];
  const report = await runSuite(suite, async (definition, target) => {
    executed.push(target.table);
    return validateCsv(definition, "Id\n1\n");
  });
  assert.deepEqual(executed, ["ProdRows", "QaRows"]);
  assert.deepEqual(report.runs.map((run) => [run.targetId, run.status, run.enabledSource]), [
    ["app-dev", "SKIPPED", "suite-policy"],
    ["app-prod", "PASS", "suite-policy"],
    ["app-qa", "PASS", "default"]
  ]);
  assert.deepEqual(generateSuiteSql(suite).batches.map((batch) => [batch.targetId, batch.table, batch.enabledSource]), [
    ["app-prod", "dbo.ProdRows", "suite-policy"],
    ["app-qa", "dbo.QaRows", "default"]
  ]);
  const rerun = await runSuite(suite, async (definition) => validateCsv(definition, "Id\n1\n"));
  assert.deepEqual(rerun.runs.map((run) => run.workId), report.runs.map((run) => run.workId));
  assert.notEqual(rerun.runId, report.runId);

  let standaloneCalls = 0;
  const standalone = await runSuite({ id: "standalone", source: "contract", isSuite: false, members: [{ id: "app", source: "contract", contract }] },
    async (definition) => { standaloneCalls++; return validateCsv(definition, "Id\n1\n"); });
  assert.equal(standaloneCalls, 2);
  assert.ok(standalone.runs.every((run) => run.status === "PASS"));
});

test("an empty effective SQL target set is visible and diagnosed without invoking execution", async () => {
  const contract = targetsContract();
  const policy = { sqlServer: { environments: { dev: false, prod: false, qa: false } } };
  let calls = 0;
  const suite = { id: "off", source: "inline", isSuite: true, targetPolicy: policy,
    members: [{ id: "app", source: "inline", contract }] };
  const report = await runSuite(suite, async () => { calls++; throw new Error("must not execute"); });
  assert.equal(calls, 0);
  assert.equal(report.status, "SKIPPED");
  assert.equal(report.exitCode, 2);
  assert.equal(report.summary.SKIPPED, 3);
  assert.ok(report.runs.every((run) => run.error === "Disabled by suite-policy."));
  assert.throws(() => generateSuiteSql(suite), /off\/app: no SQL Server target/);
});

test("referenced and inline suites load identically and combine/split preserves suite-only policy", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "suite-target-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "contracts"));
  const child = join(root, "contracts", "app.csvtest.yaml");
  await writeFile(child, stringify(targetsContract()));
  const member = { id: "app", ref: "./contracts/app.csvtest.yaml", targetOverrides: [{ target: "app-prod", enabled: false }] };
  const suiteDefinition = { suiteVersion: 1, id: "production", targetPolicy: production, members: [member] };
  const master = join(root, "production.csvsuite.yaml");
  await writeFile(master, stringify(suiteDefinition));
  const referenced = await loadSuite(master, fileSuiteIO);
  assert.equal(referenced.members[0].targetOverrides?.[0].target, "app-prod");
  assert.equal(referenced.members[0].contract?.sqlServer?.targets?.[0].enabled, true);

  const bundle = join(root, "portable.csvsuite.yaml");
  await combineSuite(master, bundle);
  const inline = await loadSuite(bundle, fileSuiteIO);
  assert.deepEqual(inline.targetPolicy, referenced.targetPolicy);
  assert.deepEqual(inline.members[0].targetOverrides, referenced.members[0].targetOverrides);
  const split = await splitSuite(bundle, join(root, "split"));
  const restoredText = await readFile(split.master, "utf8");
  const restoredDefinition = parseSuite(restoredText);
  assert.deepEqual(restoredDefinition.targetPolicy, production);
  assert.deepEqual(restoredDefinition.members[0].targetOverrides, member.targetOverrides);
  assert.deepEqual((await loadSuite(split.master, fileSuiteIO)).members[0].contract, referenced.members[0].contract);
  assert.deepEqual(targetsContract(), parseSuite(stringify({ ...suiteDefinition, members: [{ ...member, ref: undefined, contract: targetsContract() }] })).members[0].contract);
});

test("loadSuite keeps unknown target override failures on the affected member", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "suite-target-unknown-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "child.csvtest.yaml"), stringify(targetsContract()));
  const master = join(root, "bad.csvsuite.yaml");
  await writeFile(master, stringify({ suiteVersion: 1, id: "bad", members: [{ id: "child", ref: "./child.csvtest.yaml", targetOverrides: [{ target: "missing", enabled: true }] }] }));
  const loaded = await loadSuite(master, fileSuiteIO);
  assert.match(loaded.members[0].error ?? "", /unknown SQL Server target id 'missing'/);
});

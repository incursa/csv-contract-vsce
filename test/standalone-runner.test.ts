import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { inspectStandaloneDefinition, runStandaloneDefinition } from "../src/node/standalone-runner";

test("standalone runner inspects legacy synthetic CSV suites without reading target data", async (t) => {
  const fixture = await createFixture(t);
  const remoteContract = join(fixture.root, "remote.csvtest.yaml");
  const suite = join(fixture.root, "mixed.csvsuite.yaml");
  await writeFile(remoteContract, stringify({
    version: 1,
    targets: [{ url: "https://example.invalid/protected.csv" }],
    schema: { columns: { Id: { presence: "required" } } }
  }));
  await writeFile(suite, stringify({
    suiteVersion: 1,
    id: "synthetic-suite",
    members: [
      { id: "local", ref: "./local.csvtest.yaml" },
      { id: "remote", ref: "./remote.csvtest.yaml" }
    ]
  }));

  const inspected = await inspectStandaloneDefinition(suite);

  assert.equal(inspected.kind, "suite");
  assert.equal(inspected.id, "synthetic-suite");
  assert.deepEqual(inspected.errors, []);
  assert.equal(inspected.targets.length, 2);
  assert.equal(inspected.targets.find((target) => target.member === "local")?.allowed, true);
  assert.deepEqual(inspected.targets.find((target) => target.member === "remote"), {
    id: "remote:csv:0",
    member: "remote",
    kind: "csv",
    label: "https://example.invalid/protected.csv",
    allowed: false,
    reason: "Remote URL targets are disabled in the standalone runner."
  });
});

test("standalone runner requires confirmation and runs a local synthetic CSV end to end", async (t) => {
  const fixture = await createFixture(t);
  const inspected = await inspectStandaloneDefinition(fixture.contract);
  const progress: string[] = [];

  await assert.rejects(
    runStandaloneDefinition(fixture.contract, { targetIds: [] }),
    /Confirm every allowed target/
  );

  const output = await runStandaloneDefinition(fixture.contract, {
    targetIds: inspected.targets.map((target) => target.id),
    onProgress: (event) => progress.push(event.phase)
  });

  assert.equal(output.report.summary.PASS, 1);
  assert.equal(output.report.summary.FAIL, 0);
  assert.equal(output.reviewPackage.targets.length, 1);
  assert.match(output.reviewJson, /"aggregate-only"/);
  assert.match(output.reportHtml, /<!doctype html>/i);
  assert.equal(progress[0], "starting");
  assert.equal(progress.at(-1), "complete");
});

test("standalone runner honors cancellation before opening an executor", async (t) => {
  const fixture = await createFixture(t);
  const inspected = await inspectStandaloneDefinition(fixture.contract);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    runStandaloneDefinition(fixture.contract, {
      targetIds: inspected.targets.map((target) => target.id),
      signal: controller.signal
    }),
    (error: unknown) => error instanceof DOMException && error.name === "AbortError"
  );
});

test("standalone runner rejects a definition changed after target confirmation", async (t) => {
  const fixture = await createFixture(t);
  const inspected = await inspectStandaloneDefinition(fixture.contract);
  await writeFile(fixture.contract, stringify({
    version: 1,
    targets: [{ path: "./different.csv" }],
    schema: { columns: { Id: { presence: "required" } } }
  }));
  await assert.rejects(runStandaloneDefinition(fixture.contract, {
    targetIds: inspected.targets.map((target) => target.id),
    expectedFingerprint: inspected.fingerprint
  }), /changed.*Reopen/i);
});

async function createFixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "standalone-runner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const csv = join(root, "people.csv");
  const contract = join(root, "local.csvtest.yaml");
  await writeFile(csv, "Id,Name\n1,Ada\n2,Grace\n");
  await writeFile(contract, stringify({
    version: 1,
    targets: [{ path: "./people.csv" }],
    schema: {
      columnCount: { exact: 2 },
      columns: {
        Id: { presence: "required", constraints: { notNull: true, unique: true } },
        Name: { presence: "required", constraints: { notNull: true } }
      }
    }
  }));
  return { root, csv, contract };
}

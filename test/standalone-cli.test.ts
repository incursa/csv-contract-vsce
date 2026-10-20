import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { runCli } from "../src/cli";

test("runCli retains legacy .csvsuite.yaml combine compatibility", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "standalone-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const contractPath = join(root, "people.csvtest.yaml");
  const suitePath = join(root, "legacy.csvsuite.yaml");
  const outputPath = join(root, "portable.csvsuite.yaml");

  await writeFile(contractPath, stringify({
    version: 1,
    schema: { columns: { Id: { presence: "required" } } }
  }));
  await writeFile(suitePath, stringify({
    suiteVersion: 1,
    id: "legacy-suite",
    members: [{ id: "people", ref: "./people.csvtest.yaml" }]
  }));

  const exitCode = await runCli(["combine", "--spec", suitePath, "--out", outputPath]);

  assert.equal(exitCode, 0);
  const output = await readFile(outputPath, "utf8");
  assert.match(output, /suiteVersion:\s*1/);
  assert.match(output, /id:\s*legacy-suite/);
  assert.match(output, /Id:/);
});

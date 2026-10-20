import test from "node:test";
import assert from "node:assert/strict";
import { link, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { runCli } from "../src/cli";
import { createValidationReviewPackage } from "../src/core/review-package";

async function fixture(root: string): Promise<string> {
  const source = join(root, "review.json");
  const review = createValidationReviewPackage({
    source: "contracts/customers.validation.yaml",
    packageId: "customer-review",
    createdAt: "2026-01-01T00:00:00Z",
    definitions: [{ source: "contracts/customers.validation.yaml", text: "version: 1\nrules: customer-status\n" }],
    runs: [{
      target: "data/customers.csv",
      workId: "customer-status-run",
      scope: "all-rows",
      result: {
        valid: false,
        rowCount: 1,
        columnCount: 2,
        testCount: 1,
        issueCount: 1,
        errorCount: 1,
        warningCount: 0,
        truncated: false,
        checkOutcomes: [{ id: "customer-status", kind: "row-rule", status: "fail", selected: 1, passed: 0, failed: 1 }],
        issues: [{
          level: "row",
          code: "RULE_FAILED",
          testId: "customer-status",
          message: "Customer status failed.",
          evidence: { samples: [{ primary: { row: 2, values: { Customer: "Alice", Password: "secret-value" } } }], totalSamples: 1 }
        }]
      }
    }]
  }, { evidence: { mode: "detail" } });
  await writeFile(source, JSON.stringify(review), "utf8");
  return source;
}

async function workbookText(path: string): Promise<string> {
  const parts = unzipSync(new Uint8Array(await readFile(path)));
  return Object.values(parts).map(part => strFromU8(part)).join("\n");
}

test("CLI exports a saved package aggregate-only by default and details only by opt-in", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "review-export-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await fixture(root);
  const aggregate = join(root, "aggregate.xlsx");
  const detailed = join(root, "detailed.xlsx");

  assert.equal(await runCli(["export", "--source", source, "--out", aggregate]), 0);
  const aggregateText = await workbookText(aggregate);
  assert.doesNotMatch(aggregateText, /Alice/);
  assert.doesNotMatch(aggregateText, /secret-value/);

  assert.equal(await runCli(["export", "--source", source, "--out", detailed, "--include-details"]), 0);
  const detailedText = await workbookText(detailed);
  assert.match(detailedText, /Alice/);
  assert.doesNotMatch(detailedText, /secret-value/);
});

test("CLI protects existing output unless force is explicit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "review-export-force-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await fixture(root);
  const destination = join(root, "report.xlsx");

  await runCli(["export", "--source", source, "--out", destination]);
  await assert.rejects(() => runCli(["export", "--source", source, "--out", destination]), /Output already exists.*--force/);
  assert.equal(await runCli(["export", "--source", source, "--out", destination, "--force"]), 0);
  assert.ok((await readFile(destination)).length > 0);
});

test("CLI rejects unsafe destinations before publishing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "review-export-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await fixture(root);

  await assert.rejects(() => runCli(["export", "--source", source, "--out", join(root, "report.csv")]), /must use the \.xlsx extension/);
  const same = join(root, "same.xlsx");
  await writeFile(same, await readFile(source));
  await assert.rejects(() => runCli(["export", "--source", same, "--out", same]), /must be different files/);

  const alias = join(root, "source-alias.xlsx");
  await link(source, alias);
  await assert.rejects(() => runCli(["export", "--source", source, "--out", alias, "--force"]), /must be different files/);
  const preservedSource = await readFile(source, "utf8");
  assert.doesNotThrow(() => JSON.parse(preservedSource));
});

test("CLI uses the strict review-package parser and leaves no output for unknown versions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "review-export-version-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "unknown.json");
  const destination = join(root, "unknown.xlsx");
  await writeFile(source, JSON.stringify({ schema: "incursa.validation-review-package/v2" }), "utf8");

  await assert.rejects(() => runCli(["export", "--source", source, "--out", destination]), /Unsupported review package schema/);
  await assert.rejects(() => readFile(destination), /ENOENT/);
});

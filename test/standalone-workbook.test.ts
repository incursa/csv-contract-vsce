import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { ReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { stringify } from "yaml";
import { createValidationReviewPackage } from "../src/core/review-package";
import { createStandaloneWorkbookDownload } from "../src/node/standalone-workbook";
import { startStandaloneApp } from "../src/standalone";

function reviewFixture() {
  return createValidationReviewPackage({
    source: "synthetic.validation.yaml",
    definitions: [{ source: "synthetic.validation.yaml", text: "synthetic definition" }],
    runs: [{ target: "synthetic.csv", result: {
      valid: false, rowCount: 1, columnCount: 1, testCount: 1,
      issueCount: 1, errorCount: 1, warningCount: 0, truncated: false,
      checkOutcomes: [{ id: "allowed", kind: "row-rule", status: "fail", selected: 1, passed: 0, failed: 1 }],
      issues: [{ level: "row", code: "RULE_FAILED", testId: "allowed", message: "employee-private-sentinel",
        actual: "employee-private-sentinel", evidence: { samples: [{ primary: {
          row: 2, values: { Id: "employee-private-sentinel" }
        } }], totalSamples: 1 } }]
    } }]
  }, { evidence: { mode: "detail" } });
}

test("standalone Excel re-redacts retained detail and cleans up a completed stream", async () => {
  const artifact = await createStandaloneWorkbookDownload(reviewFixture(), new AbortController().signal);
  const path = String((artifact.stream as ReadStream).path);
  try {
    const chunks: Uint8Array[] = [];
    for await (const chunk of artifact.stream!) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    assert.equal(bytes.length, Number(artifact.headers!["Content-Length"]));
    const text = Object.values(unzipSync(bytes)).map(part => strFromU8(part)).join("\n");
    assert.match(text, /aggregate only/);
    assert.match(text, /FAIL/);
    assert.doesNotMatch(text, /employee-private-sentinel/);
  } finally { await artifact.cleanup!(); }
  await artifact.cleanup!();
  await assert.rejects(readFile(path), /ENOENT/);
  await assert.rejects(readFile(dirname(path)), /ENOENT/);
});

test("standalone Excel cleanup closes an unopened stream and pre-cancellation does not export", async () => {
  const artifact = await createStandaloneWorkbookDownload(reviewFixture(), new AbortController().signal);
  const stream = artifact.stream as ReadStream;
  await artifact.cleanup!();
  assert.equal(stream.closed, true);
  await assert.rejects(readFile(String(stream.path)), /ENOENT/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(createStandaloneWorkbookDownload(reviewFixture(), controller.signal), { name: "AbortError" });
});

test("standalone Excel route is authenticated and exports a saved run without reading its sources", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "standalone-workbook-test-"));
  const definition = join(directory, "synthetic.validation.yaml");
  const csv = join(directory, "synthetic.csv");
  await writeFile(csv, "Id\nemployee-private-sentinel\n");
  await writeFile(definition, stringify({ version: 1, targets: [{ path: "./synthetic.csv" }],
    schema: { columns: { Id: { presence: "required" } } },
    rules: [{ id: "allowed", expect: { column: "Id", operator: "equals", value: "allowed-value" } }]
  }));
  const app = await startStandaloneApp({ initialPath: definition, openBrowser: false });
  try {
    const headers = { Authorization: `Bearer ${app.token}`, Origin: app.origin,
      "X-Validation-Workbench-CSRF": app.token, "Content-Type": "application/json" };
    assert.equal((await fetch(`${app.origin}/api/runs/missing/review.xlsx`)).status, 401);
    assert.equal((await fetch(`${app.origin}/api/runs/missing/review.xlsx`, { headers })).status, 409);
    const started = await fetch(`${app.origin}/api/runs`, { method: "POST", headers,
      body: JSON.stringify({ targetIds: app.selected()!.targets.map(target => target.id) }) });
    assert.equal(started.status, 202);
    const { id } = await started.json() as { id: string };
    let complete = false;
    for (let attempt = 0; attempt < 500; attempt++) {
      const state = await (await fetch(`${app.origin}/api/runs/${id}`, { headers })).json() as { status: string; hasReview: boolean };
      if (state.hasReview) { assert.equal(state.status, "FAIL"); complete = true; break; }
      assert.notEqual(state.status, "ERROR");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(complete, true);
    await rm(definition);
    await rm(csv);
    for (let attempt = 0; attempt < 2; attempt++) {
      let response = await fetch(`${app.origin}/api/runs/${id}/review.xlsx`, { headers });
      // A client can receive the complete file before the server finishes its
      // asynchronous cleanup. The explicit single-export gate remains closed
      // until then; only that documented transient response is retryable.
      for (let retry = 0; response.status === 409 && retry < 200; retry++) {
        const conflict = await response.json() as { error: { code: string } };
        assert.equal(conflict.error.code, "export_active");
        await new Promise(resolve => setTimeout(resolve, 10));
        response = await fetch(`${app.origin}/api/runs/${id}/review.xlsx`, { headers });
      }
      assert.equal(response.status, 200);
      assert.match(response.headers.get("Content-Type")!, /spreadsheetml/);
      const bytes = new Uint8Array(await response.arrayBuffer());
      assert.equal(bytes.length, Number(response.headers.get("Content-Length")));
      const text = Object.values(unzipSync(bytes)).map(part => strFromU8(part)).join("\n");
      assert.match(text, /FAIL/);
      assert.doesNotMatch(text, /employee-private-sentinel/);
    }
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

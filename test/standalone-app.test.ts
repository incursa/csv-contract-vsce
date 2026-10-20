import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { startStandaloneApp } from "../src/standalone";

test("closing the standalone app cancels and drains an active run", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "standalone-app-close-"));
  try {
    const csv = join(root, "large.csv");
    const contract = join(root, "large.csvtest.yaml");
    await writeFile(csv, `Id\n${Array.from({ length: 250_000 }, (_, index) => `${index}\n`).join("")}`);
    await writeFile(contract, stringify({
      version: 1,
      targets: [{ path: "./large.csv" }],
      schema: { columns: { Id: { presence: "required", constraints: { notNull: true, unique: true } } } }
    }));
    const app = await startStandaloneApp({ initialPath: contract, openBrowser: false });
    const headers = {
      Authorization: `Bearer ${app.token}`,
      Origin: app.origin,
      "X-Validation-Workbench-CSRF": app.token,
      "Content-Type": "application/json"
    };
    const started = await fetch(`${app.origin}/api/runs`, {
      method: "POST", headers,
      body: JSON.stringify({ targetIds: app.selected()!.targets.filter((target) => target.allowed).map((target) => target.id) })
    });
    assert.equal(started.status, 202);
    assert.equal((await started.json() as { hasReview: boolean }).hasReview, false);

    const reopen = await fetch(`${app.origin}/api/open`, {
      method: "POST", headers, body: JSON.stringify({ path: contract })
    });
    assert.equal(reopen.status, 409);
    assert.equal((await reopen.json() as { error: { code: string } }).error.code, "run_active");

    const closing = app.close();
    try {
      const rejected = await fetch(`${app.origin}/api/runs`, { method: "POST", headers, body: JSON.stringify({ targetIds: [] }) });
      assert.equal(rejected.status, 503);
    } catch {
      // Closing the listener before the request arrives is also a safe rejection.
    }
    await closing;
    await rm(root, { recursive: true, force: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

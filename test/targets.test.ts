import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { CsvContract } from "../src/core/model";
import { createTargetPlans } from "../src/node/target-plan";
import { withMaterializedTarget } from "../src/node/target-source";

function contract(targets: CsvContract["targets"]): CsvContract {
  return {
    version: 1,
    targets,
    schema: { columns: { Id: { presence: "required" } } }
  };
}

test("resolves configured paths relative to each contract and groups shared targets", () => {
  const generalSpec = resolve("contracts", "general.csvtest.yaml");
  const spotSpec = resolve("contracts", "spot.csvtest.yaml");
  const inputs = [
    { spec: generalSpec, contract: contract([{ path: "../exports/a.csv" }, { path: "../exports/b.csv" }]) },
    { spec: spotSpec, contract: contract([{ path: "../exports/a.csv" }]) }
  ];
  const plans = createTargetPlans(inputs);
  assert.equal(plans.length, 2);
  assert.equal(plans[0].source, resolve(dirname(generalSpec), "../exports/a.csv"));
  assert.deepEqual(plans[0].inputs.map((input) => input.spec), [generalSpec, spotSpec]);
  assert.equal(plans[1].source, resolve(dirname(generalSpec), "../exports/b.csv"));
});

test("explicit paths and URLs override configured targets for every contract", () => {
  const inputs = [
    { spec: resolve("one.csvtest.yaml"), contract: contract([{ path: "ignored.csv" }]) },
    { spec: resolve("two.csvtest.yaml"), contract: contract([{ path: "also-ignored.csv" }]) }
  ];
  const plans = createTargetPlans(inputs, ["explicit.csv", "https://example.com/export.csv"]);
  assert.equal(plans.length, 2);
  assert.equal(plans[0].source, resolve("explicit.csv"));
  assert.equal(plans[0].inputs.length, 2);
  assert.equal(plans[1].source, "https://example.com/export.csv");
});

test("downloads an HTTP target to temporary disk before validation", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/csv");
    response.end("Id,Name\n001,Ada\n");
  });
  await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not start.");
  try {
    const content = await withMaterializedTarget(
      `http://127.0.0.1:${address.port}/export.csv`,
      {},
      (localPath) => readFile(localPath, "utf8")
    );
    assert.equal(content, "Id,Name\n001,Ada\n");
  } finally {
    await new Promise<void>((accept, reject) => server.close((error) => error ? reject(error) : accept()));
  }
});

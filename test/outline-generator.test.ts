import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createContractOutlineFromFile } from "../src/node/contract-generator";

test("outline generator declares columns and creates row and cell examples", async () => {
  const directory = await mkdtemp(join(tmpdir(), "csv-contract-outline-"));
  const path = join(directory, "input.csv");
  try {
    await writeFile(path, "Company,EmployeeId,Status\n01,000123,Active\n02,000124,Inactive\n", "utf8");
    const output = await createContractOutlineFromFile(path);
    assert.deepEqual(Object.keys(output.contract.schema.columns), ["Company", "EmployeeId", "Status"]);
    assert.equal(output.contract.schema.columnCount?.exact, 3);
    assert.deepEqual(output.contract.rowTests?.map((row) => row.id), ["sample-row-exists", "sample-cell-value"]);
    assert.equal(output.contract.rowTests?.[1].expect.cells?.Company.equals, "01");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("constraint inference is opt-in and bounded to the requested sample", async () => {
  const directory = await mkdtemp(join(tmpdir(), "csv-contract-outline-"));
  const path = join(directory, "input.csv");
  try {
    await writeFile(path, "Id,Name\n001,Ada\n002,Grace\n003,A very long later value\n", "utf8");
    const conservative = await createContractOutlineFromFile(path, { inferConstraints: false });
    assert.equal(conservative.contract.schema.columns.Name.constraints, undefined);
    const inferred = await createContractOutlineFromFile(path, { inferConstraints: true, sampleRows: 2 });
    assert.equal(inferred.sampledRows, 2);
    assert.equal(inferred.contract.schema.columns.Name.constraints?.maxLength, 5);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { createContractFromCsv, serializeContract } from "../src/core/contract";

test("creates declared columns and observed maximum lengths", () => {
  const contract = createContractFromCsv("Id,Name\n001,Ada\n002,Grace Hopper\n");
  assert.deepEqual(Object.keys(contract.schema.columns), ["Id", "Name"]);
  assert.equal(contract.schema.columns.Name.constraints?.maxLength, 12);
  assert.equal(contract.schema.columnCount?.exact, 2);
});

test("serialized contracts carry a YAML schema modeline", () => {
  const text = serializeContract(createContractFromCsv("Id\n001\n"));
  assert.match(text, /^# yaml-language-server: \$schema=/);
  assert.match(text, /version: 1/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseValidationFixtures, runValidationFixtures } from "../src/node/rule-fixtures";

const root = resolve(process.cwd());

test("runs passing, zero-applicable, and expected-failure cases through the validator", async () => {
  const run = await runValidationFixtures(resolve(root, "examples/validation-authoring/group-selection.validationfixtures.yaml"), root);
  assert.deepEqual({ total: run.total, passed: run.passed, failed: run.failed }, { total: 3, passed: 3, failed: 0 });
  const zero = run.cases.find(item => item.id === "zero-applicable-groups")!;
  assert.equal(zero.result.groupOutcomes?.[0].groups, 0);
  const boundary = run.cases.find(item => item.id === "upper-boundary-fails-rule")!;
  assert.equal(boundary.result.valid, false);
  assert.equal(boundary.result.groupOutcomes?.[0].groups, 1);
  assert.equal(boundary.passed, true, boundary.failures.join("\n"));
});

test("reports expectation failures instead of treating them as skipped", async () => {
  const directory = await mkdtemp(join(tmpdir(), "validation-fixtures-"));
  const source = join(directory, "wrong.validationfixtures.yaml");
  try {
    await writeFile(source, `version: 1\nid: wrong-expectation\ncontract:\n  inline:\n    version: 1\n    schema:\n      columns:\n        A: { presence: required }\ncases:\n  - id: mismatch\n    csv: |\n      A\n      value\n    expect:\n      valid: false\n      issueCount: 1\n`);
    const run = await runValidationFixtures(source, directory);
    assert.equal(run.failed, 1);
    assert.match(run.cases[0].failures.join(" "), /valid: expected false|issueCount: expected 1/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("resolves group child refs through the normal contract loader", async () => {
  const directory = await mkdtemp(join(tmpdir(), "validation-fixture-groups-"));
  try {
    await writeFile(join(directory, "child.validation.yaml"), `version: 1\nschema:\n  rowCount: { exact: 2 }\n  columns:\n    A: { presence: required }\n`);
    const source = join(directory, "groups.validationfixtures.yaml");
    await writeFile(source, `version: 1\nid: referenced-group\ncontract:\n  inline:\n    version: 1\n    schema:\n      columns:\n        A: { presence: required }\n    groupTests:\n      - id: pairs\n        groupBy: [A]\n        ref: ./child.validation.yaml\ncases:\n  - id: pair\n    csv: |\n      A\n      x\n      x\n    expect:\n      valid: true\n      groupOutcomes:\n        - { id: pairs, groups: 1, passed: 1, failed: 0 }\n`);
    const run = await runValidationFixtures(source, directory);
    assert.equal(run.failed, 0, run.cases[0].failures.join("\n"));
    assert.equal(run.cases[0].result.groupOutcomes?.[0].groups, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects weak fixtures, malicious refs, and duplicate case ids", () => {
  assert.throws(() => parseValidationFixtures(`version: 1\nid: weak\ncontract: { inline: { version: 1 } }\ncases:\n  - id: only-valid\n    csv: ''\n    expect: { valid: true }\n`), /assert more than valid/);
  assert.throws(() => parseValidationFixtures(`version: 1\nid: remote\ncontract:\n  ref: https://example.test/contract.yaml\n  sha256: ${"a".repeat(64)}\ncases:\n  - id: c\n    csv: ''\n    expect: { valid: true, rowCount: 0 }\n`), /relative local path/);
  assert.throws(() => parseValidationFixtures(`version: 1\nid: duplicate\ncontract: { inline: { version: 1 } }\ncases:\n  - { id: same, csv: '', expect: { valid: true, rowCount: 0 } }\n  - { id: same, csv: '', expect: { valid: true, rowCount: 0 } }\n`), /Duplicate fixture case id/);
});

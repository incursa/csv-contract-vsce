import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  explainResolvedRulePack,
  parseRulePack,
  resolveContractRulePacks,
  resolveRulePackDefinition,
  type RulePackUse,
  type RulePackIO
} from "../src/core/rule-packs";
import {
  discoverRulePackBindings,
  fileRulePackIO,
  prepareRulePackUpdateEdit,
  previewRulePackPin,
  previewRulePackUpdate
} from "../src/node/rule-pack-files";
import { fileSuiteIO } from "../src/node/suite-files";
import type { CsvContract } from "../src/core/model";
import { resolveGroupContracts } from "../src/core/group-contracts";

const root = resolve(process.cwd());
const example = resolve(root, "examples/validation-authoring/workforce.rulepack.yaml");

test("resolves a pinned local definition with parameters and provenance", async () => {
  const resolved = await resolveRulePackDefinition(example, "workforce-boundaries", { entityColumn: "EntityId" }, fileRulePackIO(dirname(example)));
  assert.deepEqual(resolved.fragment.rules?.map(rule => rule.id), ["status-required"]);
  const expectation = resolved.fragment.rules![0].expect;
  assert.equal("column" in expectation ? expectation.column : undefined, "Status");
  assert.deepEqual(resolved.fragment.groupTests?.[0].groupBy, ["EntityId"]);
  assert.equal(resolved.provenance.length, 2);
  assert.match(resolved.provenance[0].sha256, /^[a-f0-9]{64}$/);
  const explanation = explainResolvedRulePack(resolved);
  assert.deepEqual(explanation.applicationOrder.map(item => `${item.kind}:${item.id}`), [
    "rules:status-required", "groupTests:bounded-entity-history"
  ]);
  assert.match(explanation.groupSelections[0].selection, /rowCount/);
});

test("pin updates are preview-only and deterministic", async () => {
  const pack = parseRulePack(await import("node:fs/promises").then(fs => fs.readFile(example, "utf8")));
  const use = pack.definitions[0].uses![0];
  const preview = await previewRulePackPin(example, { ...use, sha256: "0".repeat(64) }, dirname(example));
  assert.equal(preview.changed, true);
  assert.equal(preview.proposedUse.sha256, preview.currentSha256);
  assert.equal(use.sha256, "3f67fd1de13d028999c86697a3e426155a827ab4e669498806ba908e0dd5f865");
});

test("merges pinned pack rules into an executable contract before local rules", async () => {
  const binding: RulePackUse = {
    id: "workforce",
    ref: "./workforce.rulepack.yaml",
    sha256: "PLACEHOLDER",
    definition: "workforce-boundaries",
    parameters: { entityColumn: "EntityId" },
    targets: ["prod"]
  };
  binding.sha256 = (await fileRulePackIO(dirname(example)).read(example)).sha256;
  const contract = {
    version: 1,
    schema: { columns: { EntityId: { presence: "required" }, Status: { presence: "required" } } },
    rules: [{ id: "local-rule", expect: { column: "Status", operator: "notBlank" } }],
    rulePacks: [binding]
  } as CsvContract & { rulePacks: RulePackUse[] };
  const resolved = await resolveContractRulePacks(contract, resolve(dirname(example), "contract.validation.yaml"), fileSuiteIO);
  assert.deepEqual(resolved.contract.rules?.map(rule => rule.id), ["status-required", "local-rule"]);
  assert.deepEqual(resolved.contract.rules?.map(rule => rule.targets), [["prod"], undefined]);
  assert.equal((resolved.contract as CsvContract & { rulePacks?: RulePackUse[] }).rulePacks, undefined);
  assert.equal(resolved.provenance.length, 2);
});

test("resolves pack-owned group refs relative to the defining pack", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rule-pack-group-origin-"));
  try {
    const child = join(directory, "child.validation.yaml");
    await writeFile(child, `version: 1\nschema:\n  rowCount: { exact: 2 }\n  columns:\n    A: { presence: required }\n`);
    const packText = `version: 1\nid: p\ndefinitions:\n  - id: d\n    fragment:\n      groupTests:\n        - id: pairs\n          groupBy: [A]\n          ref: ./child.validation.yaml\n`;
    const pack = join(directory, "groups.rulepack.yaml");
    await writeFile(pack, packText);
    const binding: RulePackUse = { id: "groups", ref: "../groups.rulepack.yaml",
      sha256: createHash("sha256").update(packText).digest("hex"), definition: "d" };
    const contract = { version: 1, schema: { columns: { A: { presence: "required" } } }, rulePacks: [binding] } as CsvContract & { rulePacks: RulePackUse[] };
    const consumer = join(directory, "consumer", "contract.validation.yaml");
    await mkdir(dirname(consumer));
    await writeFile(consumer, "# source marker\n");
    const packed = await resolveContractRulePacks(contract, consumer, fileSuiteIO);
    const resolved = await resolveGroupContracts(packed.contract, consumer, fileSuiteIO);
    assert.equal(resolved.groupTests?.[0].resolvedSource?.toLowerCase(), child.toLowerCase());
    assert.equal(resolved.groupTests?.[0].resolvedContract?.schema.rowCount?.exact, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function memoryIO(files: Record<string, { text: string; hash?: string }>): RulePackIO {
  return {
    async read(source) {
      const file = files[source];
      if (!file) throw new Error(`missing ${source}`);
      return { text: file.text, sha256: file.hash ?? createHash("sha256").update(file.text).digest("hex"), canonicalSource: source };
    },
    async resolve(containing, ref) { return `${containing.slice(0, containing.lastIndexOf("/") + 1)}${ref.replace(/^\.\//, "")}`; }
  };
}

test("rejects missing parameters, duplicate ids, cycles, and unsafe references", async () => {
  await assert.rejects(resolveRulePackDefinition(example, "workforce-boundaries", {}, fileRulePackIO(dirname(example))), /Missing required parameter entityColumn/);
  await assert.rejects(resolveRulePackDefinition(example, "workforce-boundaries", { entityColumn: "EntityId", execute: "process.exit()" },
    fileRulePackIO(dirname(example))), /Unknown parameter execute/);

  const duplicate = `version: 1\nid: p\ndefinitions:\n  - id: d\n    fragment:\n      rules:\n        - { id: same, expect: { column: A, operator: notBlank } }\n      groupRules:\n        - { id: same, groupBy: [A], require: { column: A } }\n`;
  await assert.rejects(resolveRulePackDefinition("/duplicate", "d", {}, memoryIO({ "/duplicate": { text: duplicate } })), /Duplicate resolved rule id same/);

  const cyclic = `version: 1\nid: p\ndefinitions:\n  - id: d\n    uses:\n      - { id: again, ref: ./self, sha256: ${"a".repeat(64)}, definition: d }\n`;
  await assert.rejects(resolveRulePackDefinition("/self", "d", {}, memoryIO({ "/self": { text: cyclic, hash: "a".repeat(64) } })), /cycle detected/i);

  for (const ref of ["https://example.test/rules.yaml", "file:///tmp/rules.yaml", "C:\\rules.yaml", "/tmp/rules.yaml", "\\\\server\\share\\rules.yaml"]) {
    const malicious = `version: 1\nid: p\ndefinitions:\n  - id: d\n    uses:\n      - { id: bad, ref: '${ref.replaceAll("\\", "\\\\")}', sha256: ${"a".repeat(64)}, definition: d }\n`;
    assert.throws(() => parseRulePack(malicious), /relative local path/);
  }
});

test("previews rich semantic pin changes and applies only the sha scalar", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rule-pack-update-"));
  try {
    const childText = `version: 1\nid: child\ndefinitions:\n  - id: added\n    fragment:\n      rules:\n        - { id: added, expect: { column: A, operator: notBlank } }\n`;
    const childHash = createHash("sha256").update(childText).digest("hex");
    await writeFile(join(directory, "child.rulepack.yaml"), childText);
    const oldPack = `version: 1\nid: main\ndefinitions:\n  - id: checks\n    fragment:\n      rules:\n        - { id: keep, message: old, expect: { column: A, operator: notBlank } }\n        - { id: removed, expect: { column: A, operator: notBlank } }\n`;
    const newPack = `version: 1\nid: main\ndefinitions:\n  - id: checks\n    uses:\n      - { id: child, ref: ./child.rulepack.yaml, sha256: ${childHash}, definition: added }\n    fragment:\n      rules:\n        - { id: keep, message: new, expect: { column: A, operator: notBlank } }\n`;
    const oldHash = createHash("sha256").update(oldPack).digest("hex");
    const newHash = createHash("sha256").update(newPack).digest("hex");
    const packPath = join(directory, "main.rulepack.yaml");
    await writeFile(packPath, newPack);
    const source = join(directory, "contract.validation.yaml");
    const documentText = `# preserve this comment\nversion: 1\nrulePacks:\n  - id: main\n    ref: ./main.rulepack.yaml\n    sha256: ${oldHash}\n    definition: checks\nschema:\n  columns:\n    A: { presence: required } # and this one\n`;
    await writeFile(source, documentText);
    const preview = await previewRulePackUpdate(source, documentText,
      { useId: "main", documentVersion: 7, workspaceRoot: directory, pinnedPackText: oldPack });
    assert.equal(preview.status, "ready");
    assert.equal(preview.proposedSha256, newHash);
    assert.deepEqual(preview.semanticDiff?.added.map(item => item.id), ["added"]);
    assert.deepEqual(preview.semanticDiff?.removed.map(item => item.id), ["removed"]);
    assert.deepEqual(preview.semanticDiff?.changed.map(item => item.id), ["keep"]);
    assert.equal(preview.dependencies[0].matches, true);
    assert.equal(preview.proposedProvenance.length, 2);
    const edit = await prepareRulePackUpdateEdit(preview, { documentText, documentVersion: 7, workspaceRoot: directory });
    assert.equal(edit.updatedText, documentText.replace(oldHash, newHash));
    assert.match(edit.updatedText, /# preserve this comment/);
    assert.match(edit.updatedText, /# and this one/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stale pins remain inspectable without inventing an old semantic delta", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rule-pack-stale-preview-"));
  try {
    const packText = `version: 1\nid: p\ndefinitions:\n  - id: d\n    fragment:\n      rules:\n        - { id: candidate, expect: { column: A, operator: notBlank } }\n`;
    await writeFile(join(directory, "p.rulepack.yaml"), packText);
    const source = join(directory, "c.validation.yaml");
    const documentText = `version: 1\nrulePacks:\n  - { id: p, ref: ./p.rulepack.yaml, sha256: "${"0".repeat(64)}", definition: d }\nschema: { columns: { A: { presence: required } } }\n`;
    const preview = await previewRulePackUpdate(source, documentText, { useId: "p", workspaceRoot: directory });
    assert.equal(preview.status, "ready");
    assert.equal(preview.semanticDiff?.baselineAvailable, false);
    assert.deepEqual(preview.semanticDiff?.added, []);
    assert.deepEqual(preview.semanticDiff?.proposed.map(item => item.id), ["candidate"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("apply rejects document, version, pack, and nested dependency TOCTOU changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rule-pack-toctou-"));
  try {
    const childText = `version: 1\nid: child\ndefinitions:\n  - id: d\n    fragment: { rules: [{ id: child, expect: { column: A, operator: notBlank } }] }\n`;
    const childPath = join(directory, "child.rulepack.yaml");
    await writeFile(childPath, childText);
    const childHash = createHash("sha256").update(childText).digest("hex");
    const packText = `version: 1\nid: p\ndefinitions:\n  - id: d\n    uses:\n      - { id: child, ref: ./child.rulepack.yaml, sha256: ${childHash}, definition: d }\n`;
    const packPath = join(directory, "p.rulepack.yaml");
    await writeFile(packPath, packText);
    const source = join(directory, "c.validation.yaml");
    const documentText = `version: 1\nrulePacks:\n  - { id: p, ref: ./p.rulepack.yaml, sha256: "${"0".repeat(64)}", definition: d }\nschema: { columns: { A: { presence: required } } }\n`;
    const preview = await previewRulePackUpdate(source, documentText, { useId: "p", documentVersion: 3, workspaceRoot: directory });
    await assert.rejects(prepareRulePackUpdateEdit(preview, { documentText: `${documentText}# changed\n`, documentVersion: 3, workspaceRoot: directory }), /document changed/i);
    await assert.rejects(prepareRulePackUpdateEdit(preview, { documentText, documentVersion: 4, workspaceRoot: directory }), /version changed/i);
    await writeFile(packPath, `${packText}# changed\n`);
    await assert.rejects(prepareRulePackUpdateEdit(preview, { documentText, documentVersion: 3, workspaceRoot: directory }), /rule pack changed/i);
    await writeFile(packPath, packText);
    await writeFile(childPath, `${childText}# changed\n`);
    await assert.rejects(prepareRulePackUpdateEdit(preview, { documentText, documentVersion: 3, workspaceRoot: directory }), /hash mismatch|dependency changed/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("discovery exposes inline owners and redirects referenced suite members", () => {
  const source = resolve("suite.validationsuite.yaml");
  const sha = "a".repeat(64);
  const discovery = discoverRulePackBindings(`version: 1\nid: suite\nmembers:\n  - id: inline\n    contract:\n      version: 1\n      rulePacks:\n        - { id: rules, ref: ./rules.yaml, sha256: ${sha}, definition: d }\n      schema: { columns: {} }\n  - { id: child, ref: ./child.validation.yaml }\n`, source);
  assert.equal(discovery.owners[0].memberId, "inline");
  assert.deepEqual(discovery.owners[0].path, ["members", 0, "contract", "rulePacks", 0]);
  assert.equal(discovery.references[0].memberId, "child");
  assert.equal(discovery.references[0].source, resolve(dirname(source), "child.validation.yaml"));
});

test("invalid candidate packs are inspectable but never applicable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rule-pack-invalid-update-"));
  try {
    await writeFile(join(directory, "broken.rulepack.yaml"), "version: 1\nid: broken\ndefinitions: [\n");
    const source = join(directory, "contract.validation.yaml");
    const documentText = `version: 1\nrulePacks:\n  - id: broken\n    ref: ./broken.rulepack.yaml\n    sha256: "${"0".repeat(64)}"\n    definition: checks\nschema: { columns: {} }\n`;
    const preview = await previewRulePackUpdate(source, documentText, { useId: "broken", workspaceRoot: directory });
    assert.equal(preview.status, "invalid");
    assert.equal(preview.canApply, false);
    assert.match(preview.diagnostic ?? "", /invalid rule pack|invalid rule pack yaml/i);
    await assert.rejects(prepareRulePackUpdateEdit(preview, { documentText, workspaceRoot: directory }), /not valid for apply/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("applies an inline-suite pin only in the owning member", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rule-pack-inline-suite-update-"));
  try {
    const packText = `version: 1\nid: p\ndefinitions:\n  - id: d\n    fragment: { rules: [{ id: check, expect: { column: A, operator: notBlank } }] }\n`;
    await writeFile(join(directory, "p.rulepack.yaml"), packText);
    const candidateHash = createHash("sha256").update(packText).digest("hex");
    const oldHash = "0".repeat(64);
    const source = join(directory, "suite.validationsuite.yaml");
    const suiteText = `# suite comment\nversion: 1\nid: suite\nmembers:\n  - id: inline\n    contract:\n      version: 1\n      rulePacks:\n        - { id: p, ref: ./p.rulepack.yaml, sha256: "${oldHash}", definition: d } # binding comment\n      schema: { columns: { A: { presence: required } } }\n  - { id: untouched, contract: { version: 1, schema: { columns: {} } } }\n`;
    const preview = await previewRulePackUpdate(source, suiteText,
      { useId: "p", memberId: "inline", documentVersion: 11, workspaceRoot: directory });
    const edit = await prepareRulePackUpdateEdit(preview,
      { documentText: suiteText, documentVersion: 11, workspaceRoot: directory });
    assert.equal(edit.updatedText, suiteText.replace(`"${oldHash}"`, candidateHash));
    assert.match(edit.updatedText, /# suite comment/);
    assert.match(edit.updatedText, /# binding comment/);
    assert.match(edit.updatedText, /id: untouched/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("preview rejects checks that conflict with the standalone consumer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rule-pack-consumer-collision-"));
  try {
    const packText = `version: 1\nid: p\ndefinitions:\n  - id: d\n    fragment: { rules: [{ id: same, expect: { column: A, operator: notBlank } }] }\n`;
    await writeFile(join(directory, "p.rulepack.yaml"), packText);
    const source = join(directory, "contract.validation.yaml");
    const documentText = `version: 1\nrulePacks:\n  - { id: p, ref: ./p.rulepack.yaml, sha256: "${"0".repeat(64)}", definition: d }\nschema: { columns: { A: { presence: required } } }\nrules:\n  - { id: same, expect: { column: A, operator: notBlank } }\n`;
    const preview = await previewRulePackUpdate(source, documentText, { useId: "p", workspaceRoot: directory });
    assert.equal(preview.status, "invalid");
    assert.equal(preview.canApply, false);
    assert.match(preview.diagnostic ?? "", /consuming contract.*duplicate resolved rule id same/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("preview rejects inline-suite checks that reference missing consumer columns", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rule-pack-consumer-columns-"));
  try {
    const packText = `version: 1\nid: p\ndefinitions:\n  - id: d\n    fragment: { rules: [{ id: needs-missing, expect: { column: Missing, operator: notBlank } }] }\n`;
    await writeFile(join(directory, "p.rulepack.yaml"), packText);
    const source = join(directory, "suite.validationsuite.yaml");
    const documentText = `version: 1\nid: suite\nmembers:\n  - id: inline\n    contract:\n      version: 1\n      rulePacks:\n        - { id: p, ref: ./p.rulepack.yaml, sha256: "${"0".repeat(64)}", definition: d }\n      schema: { columns: { A: { presence: required } } }\n`;
    const preview = await previewRulePackUpdate(source, documentText,
      { useId: "p", memberId: "inline", workspaceRoot: directory });
    assert.equal(preview.status, "invalid");
    assert.equal(preview.canApply, false);
    assert.match(preview.diagnostic ?? "", /undeclared column Missing/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

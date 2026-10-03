import test from "node:test";
import assert from "node:assert/strict";
import { contractDefinitionFingerprint, createPackageManifest, manifestFromRuns } from "../src/core/package-manifest";
import type { ValidationResult } from "../src/core/model";

test("package fingerprints are deterministic and change with effective definitions", () => {
  const first = { version: 1, schema: { columns: { id: { presence: "required" } } } };
  assert.equal(contractDefinitionFingerprint(first), contractDefinitionFingerprint(structuredClone(first)));
  assert.notEqual(contractDefinitionFingerprint(first), contractDefinitionFingerprint({ ...first, schema: { ...first.schema, columnOrder: "exact" } }));
});

test("sampled and truncated evidence is explicit in the shared manifest", () => {
  const manifest = createPackageManifest({ identity: "suite-a", kind: "suite", sampled: true, truncated: true, reportedIssues: 10, retainedIssueDetails: 2, scope: ["member-a"] });
  assert.equal(manifest.packageSchemaVersion, "1");
  assert.equal(manifest.evidence.complete, false);
  assert.equal(manifest.evidence.retention.reportedIssueDetails, 10);
  assert.equal(manifest.evidence.retention.retainedIssueDetails, 2);
  assert.equal(manifest.completenessNotices.length, 2);
});

test("manifest targets and source labels are stable across suite execution order", () => {
  const result: ValidationResult = { valid: true, rowCount: 0, columnCount: 0, testCount: 0, issueCount: 0, errorCount: 0, warningCount: 0, truncated: false, issues: [] };
  const first = manifestFromRuns("suite-a", [
    { member: "z-member", target: "z.csv", spec: "z.csvtest.yaml", result },
    { member: "a-member", target: "a.csv", spec: "a.csvtest.yaml", result }
  ], { members: [{ id: "z-member", connection: "secret-profile" }, { id: "a-member" }] }, "suite");
  const second = manifestFromRuns("suite-a", [
    { member: "a-member", target: "a.csv", spec: "a.csvtest.yaml", result },
    { member: "z-member", target: "z.csv", spec: "z.csvtest.yaml", result }
  ], { members: [{ id: "z-member", connection: "different-secret" }, { id: "a-member" }] }, "suite");
  assert.deepEqual(first.targets, second.targets);
  assert.deepEqual(first.sourceLabels, ["a.csvtest.yaml", "z.csvtest.yaml"]);
  assert.equal(first.identity.definitionFingerprint, second.identity.definitionFingerprint);
});

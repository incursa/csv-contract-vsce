import test from "node:test";
import assert from "node:assert/strict";
import { contractDefinitionFingerprint, createPackageManifest } from "../src/core/package-manifest";

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

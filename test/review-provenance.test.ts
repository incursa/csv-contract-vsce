import test from "node:test";
import assert from "node:assert/strict";
import { hasCompleteReviewDefinition, reviewDefinitionText } from "../src/core/review-provenance";
import { createValidationReviewPackage, reviewFingerprint } from "../src/core/review-package";
import { compareValidationReviewPackages } from "../src/core/review-diff";
import type { CsvContract } from "../src/core/model";

const plain = (): CsvContract => ({ version: 1, schema: { columns: { Id: { presence: "required" } } } });

test("saved comparison refuses unresolved executable dependency snapshots", () => {
  assert.equal(hasCompleteReviewDefinition(plain()), true);
  assert.equal(hasCompleteReviewDefinition({ ...plain(), baseline: { ref: "baseline.yaml" } }), false);
  assert.equal(hasCompleteReviewDefinition({ ...plain(), sqlServer: { targets: [{ schema: "dbo", table: "Example", baseline: { ref: "table.yaml" } }] } }), false);
  assert.equal(hasCompleteReviewDefinition({ ...plain(), groupTests: [{ id: "child", groupBy: [], ref: "child.yaml" }] }), false);
  assert.equal(hasCompleteReviewDefinition({ ...plain(), groupTests: [{ id: "child", groupBy: [], ref: "child.yaml", resolvedContract: plain() }] }), true);
  assert.equal(hasCompleteReviewDefinition({ ...plain(), groupTests: [{ id: "child", groupBy: [], contract: { ...plain(), baseline: { ref: "child-baseline.yaml" } } }] }), false);
  const cyclic = plain();
  cyclic.groupTests = [{ id: "cycle", groupBy: [], contract: cyclic }];
  assert.equal(hasCompleteReviewDefinition(cyclic), false);
});

test("runtime-only referenced child changes invalidate saved-run equivalence", () => {
  const withChild = (required: number): CsvContract => {
    const contract = { ...plain(), groupTests: [{ id: "child", groupBy: [], ref: "child.validation.yaml" }] };
    Object.defineProperty(contract.groupTests[0], "resolvedContract", {
      value: { ...plain(), rowCount: { exact: required } }, enumerable: false
    });
    return contract;
  };
  const before = withChild(1), after = withChild(2);
  assert.equal(JSON.stringify(before), JSON.stringify(after), "ordinary serialization omits the resolved dependency");
  assert.equal(hasCompleteReviewDefinition(before), true);
  assert.notEqual(reviewFingerprint(reviewDefinitionText(before)), reviewFingerprint(reviewDefinitionText(after)));
  assert.equal(JSON.parse(reviewDefinitionText(before)).groupTests[0].contract.rowCount.exact, 1);
  assert.equal(before.groupTests![0].ref, "child.validation.yaml", "snapshotting does not mutate the source");
  const pkg = (contract: CsvContract) => createValidationReviewPackage({
    source: "parent.validation.yaml", definitions: [{ source: "parent.validation.yaml", text: reviewDefinitionText(contract) }],
    runs: [{ target: "synthetic.csv", workId: "same-target", scope: "all-rows", result: {
      valid: true, rowCount: 1, columnCount: 1, testCount: 1, issueCount: 0, errorCount: 0, warningCount: 0, truncated: false, issues: []
    } }]
  });
  const comparison = compareValidationReviewPackages(pkg(before), pkg(after));
  assert.equal(comparison.definitionsMatch, false);
  assert.equal(comparison.summary.comparableTargets, 0);
  assert.equal(comparison.indeterminate[0].reason, "definitions-changed");
});

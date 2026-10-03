import test from "node:test";
import assert from "node:assert/strict";
import { evidenceProfileRedacts, previewEvidenceProfile, redactValidationResult, type EvidenceProfile } from "../src/evidence-profile";
import { createValidationRunExport, issueRunsToCsv } from "../src/issue-export";

const result = {
  valid: false, rowCount: 1, columnCount: 3, testCount: 1, issueCount: 1, errorCount: 1, warningCount: 0, truncated: false,
  issues: [{ level: "cell" as const, code: "BAD", column: "Id", row: 2, message: "bad", actual: "id-1", expected: "ok",
    group: { Region: "west" }, evidence: { samples: [{ primary: { row: 2, values: { Id: "id-1", Amount: 42, When: "2026-01-02" } }, related: [{ values: { Id: "id-1", Amount: 7 } }] }], aggregate: { Region: "west" } } }]
};

test("evidence preview gives exclude precedence and warns on unknown columns", () => {
  const profile: EvidenceProfile = { id: "safe", include: ["Id", "Amount", "Renamed"], exclude: ["Amount"], mask: { Id: "hash" } };
  assert.deepEqual(previewEvidenceProfile(profile, ["Id", "Amount", "When"]), {
    profileId: "safe", included: ["Id"], excluded: ["Amount", "When"], masked: ["Id"], unknown: ["Renamed"], redaction: true,
    warning: "Profile references unknown columns: Renamed. They were ignored."
  });
});

test("redaction applies consistently to primary, related, aggregate, and group evidence", () => {
  const profile: EvidenceProfile = { id: "package", include: ["Id", "Region"], mask: { Id: "hash", Region: "partial" } };
  const redacted = redactValidationResult(result, profile)!;
  const issue = redacted.issues[0];
  assert.notEqual(issue.actual, "id-1");
  assert.equal(issue.group?.Region, "w***");
  assert.equal(issue.evidence?.samples[0].primary?.values.Id, issue.evidence?.samples[0].related?.[0].values.Id);
  assert.notEqual(issue.evidence?.samples[0].primary?.values.Id, "id-1");
  assert.equal(issue.evidence?.aggregate?.Region, "w***");
  assert.equal(issue.evidence?.samples[0].primary?.values.Amount, undefined);
});

test("export metadata reports effective redaction for an include profile", () => {
  const runs = [{ target: "input.csv", result }];
  const profile: EvidenceProfile = { id: "unknown-only", include: ["Renamed"] };
  assert.equal(evidenceProfileRedacts(profile, ["Id", "Amount"]), true);
  assert.equal(createValidationRunExport("contract.csvtest.yaml", runs, profile).evidence?.redacted, true);
  assert.match(issueRunsToCsv(runs, undefined, profile), /"EvidenceRedacted"/);
});

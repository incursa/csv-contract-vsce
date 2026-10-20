import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createValidationRunExport, type IssueExportRun } from "../src/issue-export";
import { createValidationReviewPackage, parseValidationReviewPackage, reviewFingerprint } from "../src/core/review-package";

const result = {
  valid: true,
  rowCount: 2,
  columnCount: 3,
  testCount: 1,
  issueCount: 1,
  errorCount: 0,
  warningCount: 1,
  truncated: false,
  checkOutcomes: [{ id: "active-check", name: "Active check", kind: "row-test" as const, severity: "warning" as const, importance: 2.5, status: "pass" as const, selected: 2, passed: 2, reason: "Password=top-secret" }],
  rowOutcomes: [{ checkId: "active-check", checkName: "Active check", kind: "row-test" as const, status: "pass" as const, row: 2, context: { identity: { Employee: "Ada" }, group: { Region: "West" }, relatedRows: [3], aggregate: { MatchCount: 1, Owner: "Grace" } } }],
  outcomeRetention: { limit: 10, retained: 1, dropped: 0, truncated: false, evaluationComplete: true, reason: "Password=top-secret", counts: { pass: 1, fail: 0, "not-applicable": 0, "not-evaluated": 0, unknown: 0 } },
  examples: [{ id: "person-secret", outcome: "passed" as const, row: 2, values: { Employee: "Ada", Region: "West" } }],
  issues: [{
    level: "cell" as const,
    code: "CHECK",
    message: "Ada has salary 123",
    title: "Review Ada",
    diagnostic: "Password=top-secret",
    actual: "Ada",
    expected: "Allowed",
    group: { Employee: "Ada" },
    evidence: {
      samples: [{
        primary: { label: "Ada source", row: 2, values: { Employee: "Ada", Password: "top-secret" } },
        related: [{ values: { Manager: "Grace" } }]
      }],
      aggregate: { MatchCount: 1, Salary: 123, SalaryTotal: 12345, Owner: "Ada" },
      totalSamples: 1
    }
  }]
};

test("review package safe default is aggregate-only, detached, and truthfully complete", () => {
  const runs: IssueExportRun[] = [{ target: "people.csv", result, error: undefined }];
  const before = structuredClone(runs);
  const pkg = createValidationReviewPackage({ source: "people.csvtest.yaml", runs, toolVersion: "1.2.3", createdAt: "2026-10-12T12:00:00Z" });
  assert.deepEqual(runs, before);
  assert.equal(pkg.targets[0].status, "PASS");
  assert.equal(pkg.targets[0].verdict, "pass");
  assert.equal(pkg.summary.issueDetailsComplete, true);
  assert.equal(pkg.summary.evaluationComplete, true);
  assert.equal(pkg.evidence.mode, "aggregate-only");
  const exported = JSON.stringify(pkg);
  for (const secret of ["Ada", "Grace", "top-secret", "salary 123", "person-secret"]) assert.doesNotMatch(exported, new RegExp(secret, "i"));
  assert.doesNotMatch(exported, /Active check/);
  assert.equal(pkg.targets[0].result!.issues[0].evidence!.aggregate!.MatchCount, 1);
  assert.equal(pkg.targets[0].result!.issues[0].evidence!.aggregate!.Salary, "[redacted]");
  assert.equal(pkg.targets[0].result!.issues[0].evidence!.aggregate!.SalaryTotal, "[redacted]");
  assert.deepEqual(pkg.targets[0].result!.issues[0].evidence!.samples, []);
  assert.equal(pkg.targets[0].result!.checkOutcomes![0].id, "active-check");
  assert.equal(pkg.targets[0].result!.checkOutcomes![0].severity, "warning");
  assert.equal(pkg.targets[0].result!.checkOutcomes![0].importance, 2.5);
  assert.equal(pkg.targets[0].result!.checkOutcomes![0].reason, "[redacted]");
  assert.equal(pkg.targets[0].result!.rowOutcomes, undefined);
  assert.equal(pkg.targets[0].result!.outcomeRetention!.retained, 1);
  assert.equal(pkg.targets[0].result!.outcomeRetention!.evaluationComplete, true);
  assert.equal(pkg.targets[0].result!.outcomeRetention!.reason, "[redacted]");
});

test("detail include, exclude, and mask rules cover every evidence location and free-text field", () => {
  const pkg = createValidationReviewPackage({ source: "people", runs: [{ target: "people.csv", result }], createdAt: "2026-10-12T12:00:00Z" }, {
    evidence: { mode: "detail", include: ["Region", "MatchCount"], exclude: ["Employee", "Manager", "Password"], mask: ["$message", "$title", "$diagnostic", "$actual", "$expected", "$evidence.label", "$example.id"] }
  });
  const text = JSON.stringify(pkg);
  assert.doesNotMatch(text, /Ada|Grace|top-secret|salary 123|person-secret/);
  assert.match(text, /West/);
  assert.doesNotMatch(text, /"Employee":"Ada"|"Owner":"Grace"/);
  assert.deepEqual(pkg.targets[0].result!.rowOutcomes![0].context!.relatedRows, [3]);
  assert.equal(pkg.targets[0].result!.issues[0].evidence!.aggregate!.MatchCount, 1);
  assert.ok(pkg.evidence.redactedFields > 0);
  const excluded = createValidationReviewPackage({ source: "people", runs: [{ target: "people.csv", result, error: "Ada failed" }], createdAt: "2026-10-12T12:00:00Z" }, {
    evidence: { mode: "detail", exclude: ["Employee"] }
  });
  assert.doesNotMatch(JSON.stringify(excluded), /Ada failed|Ada has salary/);
  assert.equal(excluded.targets[0].status, "ERROR");
});

test("skipped, canceled, unknown, sampled, and errored targets never become passes while detail truncation stays separate", () => {
  const states: IssueExportRun[] = [
    { target: "skip", status: "SKIPPED", result },
    { target: "cancel", status: "CANCELLED", result },
    { target: "unknown", status: "UNKNOWN", result },
    { target: "sample", result: { ...result, preview: { scope: "sample", rowLimit: 2, exampleLimit: 1 } } },
    { target: "error", error: "Password=secret" },
    { target: "truncated", result: { ...result, truncated: true } },
    { target: "unsupported", status: "UNSUPPORTED", result },
    { target: "partial", status: "PARTIAL", result },
    { target: "unknown-check", result: { ...result, checkOutcomes: [{ id: "missing", status: "unknown" as const }] } },
    { target: "failed-and-incomplete", result: { ...result, valid: false, checkOutcomes: [{ id: "failed", status: "fail" as const }, { id: "missing", status: "not-evaluated" as const }] } },
    { target: "aborted", result: { ...result, outcomeRetention: { ...result.outcomeRetention, evaluationComplete: false, reason: "aborted" } } }
  ];
  const pkg = createValidationReviewPackage({ source: "states", runs: states, createdAt: "2026-10-12T12:00:00Z" });
  assert.deepEqual(pkg.targets.map(target => target.status), ["SKIPPED", "CANCELED", "UNKNOWN", "SAMPLED", "ERROR", "PASS", "UNKNOWN", "UNKNOWN", "UNKNOWN", "FAIL", "UNKNOWN"]);
  assert.ok(pkg.targets.filter(target => !["truncated", "failed-and-incomplete"].includes(target.target)).every(target => target.verdict === "not-assessed"));
  assert.equal(pkg.targets[5].completeness.issueDetails, "limited");
  assert.equal(pkg.targets[8].coverage.unknown, 1);
  assert.equal(pkg.targets[9].verdict, "fail");
  assert.equal(pkg.targets[9].completeness.evaluation, "unknown");
  assert.equal(pkg.targets[10].completeness.evaluation, "unknown");
  assert.equal(pkg.summary.evaluationComplete, false);
  assert.doesNotMatch(JSON.stringify(pkg), /Password=secret/);
});

test("warning-only failed checks preserve PASS while error-severity failures block it", () => {
  const warningOnly = {
    ...result,
    valid: true,
    errorCount: 0,
    warningCount: 1,
    checkOutcomes: [{ id: "advisory", severity: "warning" as const, status: "fail" as const, failed: 1 }]
  };
  const mixed = {
    ...warningOnly,
    checkOutcomes: [
      ...warningOnly.checkOutcomes,
      { id: "required", severity: "error" as const, status: "fail" as const, failed: 1 }
    ]
  };
  const pkg = createValidationReviewPackage({ source: "severity", runs: [{ target: "warning-only", result: warningOnly }, { target: "mixed", result: mixed }], createdAt: "2026-10-12T12:00:00Z" });
  assert.equal(pkg.targets[0].status, "PASS");
  assert.equal(pkg.targets[0].verdict, "pass");
  assert.equal(pkg.targets[0].coverage.fail, 1);
  assert.equal(pkg.summary.warnings, 2);
  assert.equal(pkg.targets[1].status, "FAIL");
  assert.equal(pkg.targets[1].verdict, "fail");
  assert.deepEqual(parseValidationReviewPackage(JSON.stringify(pkg)), JSON.parse(JSON.stringify(pkg)));
});

test("fingerprints and provenance are deterministic while secret-like values are removed", () => {
  assert.equal(reviewFingerprint({ b: 2, a: 1 }), reviewFingerprint({ a: 1, b: 2 }));
  assert.equal(reviewFingerprint("abc"), "sha256-6cc43f858fbb763301637b5af970e2a46b46f461f27e5a0f41e009c59b827b25");
  assert.equal(reviewFingerprint({ a: 1, b: 2 }), `sha256-${createHash("sha256").update('{"a":1,"b":2}').digest("hex")}`);
  const unicode = "Δ-data-".repeat(100);
  assert.equal(reviewFingerprint(unicode), `sha256-${createHash("sha256").update(JSON.stringify(unicode)).digest("hex")}`);
  const input = { source: "contract", runs: [{ target: "target", result }], createdAt: "2026-10-12T12:00:00Z", definitions: [{ source: "contract.yaml", text: "password: top-secret\nprivate_key: hidden\nversion: 1" }], provenance: { commit: "abc", apiToken: "top-secret" } };
  const first = createValidationReviewPackage(input, { includeDefinitions: true });
  const second = createValidationReviewPackage(input, { includeDefinitions: true });
  assert.deepEqual(first, second);
  assert.equal(first.provenance.supplied!.apiToken, "[redacted]");
  assert.doesNotMatch(first.provenance.definitions[0].text!, /top-secret/);
  assert.doesNotMatch(first.provenance.definitions[0].text!, /hidden/);
  assert.equal(first.provenance.definitions[0].includedTextFingerprint, reviewFingerprint(first.provenance.definitions[0].text));
  assert.deepEqual(parseValidationReviewPackage(JSON.stringify(first)), JSON.parse(JSON.stringify(first)));
  const tamperedText = structuredClone(first);
  tamperedText.provenance.definitions[0].text = "changed";
  assert.throws(() => parseValidationReviewPackage(JSON.stringify(tamperedText)), /included definition text fingerprint/);
  const ordered = createValidationReviewPackage({ ...input, definitions: [{ source: "z", text: "last" }, { source: "a", text: "first" }] });
  const reversed = createValidationReviewPackage({ ...input, definitions: [{ source: "a", text: "first" }, { source: "z", text: "last" }] });
  assert.equal(ordered.source.fingerprint, reversed.source.fingerprint);
  assert.deepEqual(ordered.targets[0].definitionFingerprints, []);
  const bound = createValidationReviewPackage({ ...input, definitions: [{ source: "a", text: "first" }, { source: "z", text: "last" }], definitionBindings: { target: ["z"] } });
  assert.deepEqual(bound.targets[0].definitionFingerprints, [bound.provenance.definitions.find(definition => definition.source === "z")!.fingerprint]);
  assert.throws(() => createValidationReviewPackage({ ...input, definitions: [{ source: "a", text: "first" }], definitionBindings: { target: ["missing"] } }), /unknown source missing/);
});

test("parser upgrades legacy exports and rejects unsupported or contradictory packages", () => {
  const legacy = createValidationRunExport("contract.csvtest.yaml", [{ target: "target.csv", result }]);
  legacy.exportedAt = "2026-10-12T12:00:00Z";
  const upgraded = parseValidationReviewPackage(JSON.stringify(legacy));
  assert.equal(upgraded.source.reference, "contract.csvtest.yaml");
  assert.equal(upgraded.evidence.mode, "aggregate-only");
  assert.deepEqual(parseValidationReviewPackage(JSON.stringify(upgraded)), JSON.parse(JSON.stringify(upgraded)));
  assert.throws(() => parseValidationReviewPackage('{"schema":"incursa.validation-review-package/v2"}'), /Unsupported review package schema/);
  const malformed = structuredClone(upgraded);
  malformed.targets[0].status = "SKIPPED";
  malformed.targets[0].verdict = "pass";
  assert.throws(() => parseValidationReviewPackage(JSON.stringify(malformed)), /contradictory verdict/);
  const incompletePass = structuredClone(upgraded);
  incompletePass.targets[0].result!.preview = { scope: "sample", rowLimit: 1, exampleLimit: 1 };
  assert.throws(() => parseValidationReviewPackage(JSON.stringify(incompletePass)), /cannot be a pass/);
  const inconsistentSummary = structuredClone(upgraded);
  inconsistentSummary.summary.statuses.PASS = 2;
  assert.throws(() => parseValidationReviewPackage(JSON.stringify(inconsistentSummary)), /status PASS is inconsistent/);
  const incompleteDetails = structuredClone(upgraded);
  incompleteDetails.targets[0].completeness.retainedIssues = 0;
  assert.throws(() => parseValidationReviewPackage(JSON.stringify(incompleteDetails)), /issue completeness is inconsistent/);
  const falseCoverage = structuredClone(upgraded);
  falseCoverage.targets[0].coverage.unknown = 1;
  assert.throws(() => parseValidationReviewPackage(JSON.stringify(falseCoverage)), /cannot be a pass|coverage is inconsistent/);
  const unexpectedResult = structuredClone(upgraded) as unknown as { targets: Array<{ result: Record<string, unknown> }> };
  unexpectedResult.targets[0].result.privateValue = "Ada";
  assert.throws(() => parseValidationReviewPackage(JSON.stringify(unexpectedResult)), /unsupported field privateValue/);
  const unexpectedIssue = structuredClone(upgraded) as unknown as { targets: Array<{ result: { issues: Array<Record<string, unknown>> } }> };
  unexpectedIssue.targets[0].result.issues[0].privateValue = "Ada";
  assert.throws(() => parseValidationReviewPackage(JSON.stringify(unexpectedIssue)), /unsupported field privateValue/);
  assert.throws(() => parseValidationReviewPackage("not json"), /not valid JSON/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseContract, validateCsv } from "../src/core/contract";
import { compareValidationReviewPackages } from "../src/core/review-diff";
import {
  createValidationReviewPackage,
  parseValidationReviewPackage,
  reviewFingerprint,
  validationReviewPackageJson
} from "../src/core/review-package";
import { loadSuite, runSuite, type LoadedSuite, type SuiteIO, type SuiteReport } from "../src/core/suite";
import type { CsvTarget, ValidationResult } from "../src/core/model";
import type { IssueExportRun } from "../src/issue-export";
import { validateCsvFile } from "../src/node/streaming-validator";
import { renderReviewDiffHtml } from "../src/review-diff-report";
import { renderValidationReportHtml } from "../src/validation-report";

const SUITE_SOURCE = "/delivery.validationsuite.yaml";
const CONTRACT_SOURCE = "/member.validation.yaml";
const PACK_SOURCE = "/shared.rulepack.yaml";
const TARGET = "synthetic.csv";
const CREATED_BEFORE = "2026-10-12T12:00:00.000Z";
const CREATED_AFTER = "2026-10-12T12:01:00.000Z";

const packText = `version: 1
id: delivery-shared
definitions:
  - id: status-check
    fragment:
      rules:
        - id: status-required
          name: Required delivery status
          importance: 5
          expect: { column: Status, operator: equals, value: Ready }
`;
const packSha256 = createHash("sha256").update(packText).digest("hex");

function contractText(localImportance = 2): string {
  return `version: 1
rulePacks:
  - id: shared-status
    ref: ./shared.rulepack.yaml
    sha256: ${packSha256}
    definition: status-check
targets:
  - path: ${TARGET}
identity:
  columns: [Id]
schema:
  columns:
    Id: { presence: required }
    PersonName: { presence: required }
    Amount: { presence: required }
    Status: { presence: required }
rules:
  - id: skipped-local
    importance: ${localImportance}
    when: { column: Status, operator: equals, value: Skip }
    expect: { column: PersonName, operator: notBlank }
groupTests:
  - id: selected-groups
    importance: 3
    groupBy: [Id]
    select:
      rowCount:
        where: { column: Status, operator: equals, value: Selected }
        count: { min: 1 }
    contract:
      version: 1
      schema:
        columns:
          Status: { presence: required }
`;
}

const suiteText = `suiteVersion: 1
id: delivery-suite
members:
  - id: member-a
    ref: ./member.validation.yaml
`;

function memoryIO(files: Record<string, string>): SuiteIO {
  return {
    async read(source) {
      const text = files[source];
      if (text === undefined) throw new Error(`Missing synthetic definition ${source}.`);
      return text;
    },
    resolve(containing, reference) {
      const directory = containing.slice(0, containing.lastIndexOf("/") + 1);
      return `${directory}${reference.replace(/^\.\//, "")}`;
    },
    async canonical(source) { return source; }
  };
}

async function loadedSuite(memberText = contractText()): Promise<LoadedSuite> {
  return loadSuite(SUITE_SOURCE, memoryIO({
    [SUITE_SOURCE]: suiteText,
    [CONTRACT_SOURCE]: memberText,
    [PACK_SOURCE]: packText
  }));
}

async function runStreamingSuite(suite: LoadedSuite, csvPath: string, signal?: AbortSignal): Promise<SuiteReport> {
  return runSuite(
    suite,
    async () => { throw new Error("The synthetic delivery suite has no SQL target."); },
    false,
    async (contract, _source, target: CsvTarget): Promise<ValidationResult> => {
      assert.equal("path" in target ? target.path : undefined, TARGET);
      // The streamed validator canonicalizes its spec path while resolving already-loaded
      // baselines/group contracts, so use the real synthetic file as that runtime origin.
      const streamed = await validateCsvFile(csvPath, [{ spec: csvPath, contract }], { signal, progressInterval: 1 });
      return streamed.runs[0].result;
    },
    { signal }
  );
}

function exportRuns(report: SuiteReport): IssueExportRun[] {
  return report.runs.map(run => ({
    target: run.target ?? run.table ?? `${run.suite}/${run.member}`,
    status: run.status,
    result: run.result,
    error: run.error,
    runId: run.runId,
    workId: run.workId,
    evaluatedAt: run.evaluatedAt,
    scope: run.scope
  }));
}

function reviewInput(report: SuiteReport, memberText: string, createdAt: string) {
  const workId = report.runs[0].workId!;
  return {
    source: SUITE_SOURCE,
    createdAt,
    packageId: `delivery-${createdAt}`,
    definitions: [
      { source: SUITE_SOURCE, text: suiteText },
      { source: CONTRACT_SOURCE, text: memberText },
      { source: PACK_SOURCE, text: packText }
    ],
    definitionBindings: { [workId]: [CONTRACT_SOURCE, PACK_SOURCE] },
    runs: exportRuns(report)
  };
}

test("loaded reuse, importance, and zero-selection outcomes reach the actual validator", async () => {
  const suite = await loadedSuite();
  const member = suite.members[0];
  assert.equal(member.error, undefined);
  assert.deepEqual(member.rulePackProvenance?.map(item => [item.viaUseId, item.sha256, item.definitionId]), [
    ["shared-status", packSha256, "status-check"]
  ]);
  assert.deepEqual(member.contract?.rules?.map(rule => rule.id), ["status-required", "skipped-local"]);

  const result = validateCsv(member.contract!, "Id,PersonName,Amount,Status\n1,Ada Lovelace,9876.54,Ready\n");
  const outcomes = new Map(result.checkOutcomes?.map(outcome => [outcome.id, outcome]));
  assert.equal(outcomes.get("status-required")?.importance, 5);
  assert.equal(outcomes.get("skipped-local")?.importance, 2);
  assert.equal(outcomes.get("skipped-local")?.status, "not-applicable");
  assert.equal(outcomes.get("selected-groups")?.importance, 3);
  assert.notEqual(outcomes.get("selected-groups")?.status, "pass", "zero selected groups must not silently pass");
});

test("streamed suite runs round-trip through aggregate review packages and compare conservatively", async () => {
  const directory = await mkdtemp(join(tmpdir(), "validation-delivery-"));
  const csvPath = join(directory, TARGET);
  try {
    const memberText = contractText();
    const suite = await loadedSuite(memberText);
    await writeFile(csvPath, "Id,PersonName,Amount,Status\n1,Ada Lovelace,9876.54,Blocked\n");
    const failing = await runStreamingSuite(suite, csvPath);
    await writeFile(csvPath, "Id,PersonName,Amount,Status\n1,Grace Hopper,1234.56,Ready\n");
    const passing = await runStreamingSuite(suite, csvPath);

    assert.equal(failing.status, "FAIL", JSON.stringify(failing));
    assert.equal(passing.status, "PASS", JSON.stringify(passing));
    assert.equal(failing.runs[0].workId, passing.runs[0].workId);
    assert.notEqual(failing.runs[0].runId, passing.runs[0].runId);
    assert.equal(failing.runs[0].result?.issues[0].testId, "status-required");

    const beforeJson = validationReviewPackageJson(reviewInput(failing, memberText, CREATED_BEFORE));
    const afterJson = validationReviewPackageJson(reviewInput(passing, memberText, CREATED_AFTER));
    const before = parseValidationReviewPackage(beforeJson);
    const after = parseValidationReviewPackage(afterJson);
    const expectedBindings = [reviewFingerprint(memberText), reviewFingerprint(packText)].sort();
    assert.deepEqual(before.targets[0].definitionFingerprints, expectedBindings);
    assert.match(before.source.fingerprint, /^sha256-[a-f0-9]{64}$/);
    assert.equal(before.targets[0].workId, after.targets[0].workId);
    assert.equal(before.targets[0].coverage.fail, 1);
    assert.ok(before.targets[0].coverage.notApplicable >= 1);

    for (const unsafe of ["Ada Lovelace", "Grace Hopper", "9876.54", "1234.56", "Blocked"]) {
      assert.doesNotMatch(beforeJson + afterJson, new RegExp(unsafe.replace(".", "\\."), "i"));
    }
    assert.equal(before.evidence.mode, "aggregate-only");
    assert.equal(before.targets[0].result?.rowOutcomes, undefined);
    const safeActual = before.targets[0].result?.issues[0].actual;
    assert.ok(safeActual === undefined || safeActual === "[redacted]");
    const reportHtml = renderValidationReportHtml(before);
    assert.doesNotMatch(reportHtml, /Ada Lovelace|9876\.54|Blocked/i);
    assert.match(reportHtml, /Not retained/);

    const resolved = compareValidationReviewPackages(before, after);
    assert.deepEqual(resolved.resolvedFailures.map(item => item.identity.ruleId), ["status-required"]);
    assert.equal(resolved.newFailures.length, 0);
    const introduced = compareValidationReviewPackages(after, before);
    assert.deepEqual(introduced.newFailures.map(item => item.identity.ruleId), ["status-required"]);
    assert.equal(introduced.resolvedFailures.length, 0);
    const diffHtml = renderReviewDiffHtml(resolved);
    assert.match(diffHtml, /Resolved failures/);
    assert.doesNotMatch(diffHtml, /Ada Lovelace|9876\.54|Blocked/i);

    const changedText = contractText(4);
    const changedPackage = createValidationReviewPackage(reviewInput(passing, changedText, "2026-10-12T12:02:00.000Z"));
    const changed = compareValidationReviewPackages(before, changedPackage);
    assert.equal(changed.resolvedFailures.length, 0);
    assert.ok(changed.indeterminate.some(item => item.reason === "definitions-changed" || item.reason === "target-definitions-changed"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unknown coverage and cancellation remain non-passing and redact execution notes", async () => {
  const unknownContract = parseContract(`version: 1
schema:
  columns:
    Id: { presence: required }
    OptionalValue: { presence: optional }
rules:
  - id: optional-value
    importance: 4
    expect: { column: OptionalValue, operator: notBlank }
`);
  const unknownResult = validateCsv(unknownContract, "Id\n1\n");
  assert.equal(unknownResult.checkOutcomes?.[0].status, "not-evaluated");
  assert.equal(unknownResult.checkOutcomes?.[0].importance, 4);
  const unknownPackage = createValidationReviewPackage({
    source: "/unknown.validation.yaml",
    createdAt: CREATED_BEFORE,
    definitions: [{ source: "/unknown.validation.yaml", text: "synthetic unknown contract" }],
    runs: [{ target: "unknown.csv", workId: "unknown-work", scope: "all", result: unknownResult }]
  });
  assert.equal(unknownPackage.targets[0].coverage.notEvaluated, 1);
  assert.equal(unknownPackage.targets[0].completeness.evaluation, "unknown");
  assert.equal(unknownPackage.summary.evaluationComplete, false);
  assert.notEqual(unknownPackage.targets[0].verdict, "pass");

  const suite = await loadedSuite();
  const controller = new AbortController();
  controller.abort(new Error("synthetic cancellation secret"));
  const canceled = await runSuite(
    suite,
    async () => { throw new Error("SQL validation must not start after cancellation."); },
    false,
    async () => { throw new Error("File validation must not start after cancellation."); },
    { signal: controller.signal }
  );
  assert.equal(canceled.status, "CANCELED");
  assert.equal(canceled.runs[0].status, "CANCELED");
  assert.match(canceled.runs[0].error ?? "", /Canceled before member execution/);

  const canceledPackage = createValidationReviewPackage({
    source: SUITE_SOURCE,
    createdAt: CREATED_AFTER,
    definitions: [{ source: CONTRACT_SOURCE, text: contractText() }],
    definitionBindings: { [canceled.runs[0].workId!]: [CONTRACT_SOURCE] },
    runs: exportRuns(canceled)
  });
  assert.equal(canceledPackage.targets[0].status, "CANCELED");
  assert.equal(canceledPackage.targets[0].verdict, "not-assessed");
  assert.equal(canceledPackage.targets[0].completeness.evaluation, "not-run");
  assert.equal(canceledPackage.targets[0].error, "[redacted]");
  const serialized = JSON.stringify(canceledPackage);
  assert.doesNotMatch(serialized, /Canceled before member execution|synthetic cancellation secret/i);
});

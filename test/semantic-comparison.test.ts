import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compareCsvTexts } from "../src/comparison/engine";
import { createEvidenceFiles } from "../src/comparison/evidence";
import type { ComparisonOptions } from "../src/comparison/model";
import { compareCsvPathsDesktop } from "../src/node/semantic-comparison";

interface ParityCase {
  name: string;
  left: string;
  right: string;
  options: ComparisonOptions;
  exitCode: number;
  removed?: number;
  changed?: number;
  duplicateKeysLeft?: number;
  schemaChanges?: number;
  errorCode?: string;
}

const fixtureRoot = join(process.cwd(), "test", "fixtures", "semantic");
const manifest = JSON.parse(readFileSync(join(fixtureRoot, "manifest.json"), "utf8")) as { cases: ParityCase[] };

for (const fixture of manifest.cases) {
  test(`PowerShell semantic parity: ${fixture.name}`, () => {
    if (fixture.errorCode) {
      assert.throws(
        () => compareCsvTexts(
          readFileSync(join(fixtureRoot, fixture.left), "utf8"),
          readFileSync(join(fixtureRoot, fixture.right), "utf8"),
          fixture.options
        ),
        (error: { code?: string }) => error.code === fixture.errorCode
      );
      return;
    }
    const result = compareCsvTexts(
      readFileSync(join(fixtureRoot, fixture.left), "utf8"),
      readFileSync(join(fixtureRoot, fixture.right), "utf8"),
      fixture.options
    );
    assert.equal(result.summary.exitCode, fixture.exitCode);
    if (fixture.removed !== undefined) assert.equal(result.summary.differences.removed, fixture.removed);
    if (fixture.changed !== undefined) assert.equal(result.summary.differences.changed, fixture.changed);
    if (fixture.duplicateKeysLeft !== undefined) assert.equal(result.summary.differences.duplicateKeysLeft, fixture.duplicateKeysLeft);
    if (fixture.schemaChanges !== undefined) assert.equal(result.summary.differences.schemaChanges, fixture.schemaChanges);
  });
}

test("keyed duplicates are reported without arbitrary changed-cell pairing", () => {
  const result = compareCsvTexts(
    "Id,Name,Hours\n0001,Ada,8\n0001,Grace,7\n0002,Linus,5\n",
    "Id,Name,Hours\n0001,Ada,9\n0002,Linus,6\n",
    { keyColumns: ["Id"], maxDiagnostics: 2 }
  );
  assert.equal(result.summary.status, "duplicate-keys");
  assert.equal(result.summary.differences.duplicateKeysLeft, 1);
  assert.equal(result.summary.differences.changed, 1);
  assert.equal(result.summary.differences.changedCells, 1);
  assert.equal(result.details.changedCells[0].keyValues[0], "0002");
  assert.equal(result.summary.diagnostics.included, 2);
  assert.equal(result.summary.diagnostics.truncated, false);
  assert.ok(result.summary.diagnostics.items.every((diagnostic) => !("value" in diagnostic)));
});

test("two truly empty CSV files are semantically equal", () => {
  const result = compareCsvTexts("", "");
  assert.equal(result.summary.semanticEqual, true);
  assert.equal(result.summary.left.rowCount, 0);
  assert.deepEqual(result.summary.columns.comparableColumns, []);
});

test("normalization is opt-in and preserves raw leading-zero identifiers", () => {
  const raw = compareCsvTexts("Id,Amount\n0001,1.00\n", "Id,Amount\n1,1\n");
  assert.equal(raw.summary.semanticEqual, false);
  const decimalOnly = compareCsvTexts("Id,Amount\n0001,1.00\n", "Id,Amount\n0001,1\n", {
    normalization: { decimalColumns: ["Amount"] }
  });
  assert.equal(decimalOnly.summary.semanticEqual, true);
  assert.equal(decimalOnly.details.normalizedLeftRows[0][0], "0001");
});

test("invalid explicit normalization reports column and row but not source value", () => {
  assert.throws(
    () => compareCsvTexts("Id,Amount\n1,secret-value\n", "Id,Amount\n1,1\n", {
      normalization: { decimalColumns: ["Amount"] }
    }),
    (error: Error) => error.message.includes("Amount") && error.message.includes("record 1") && !error.message.includes("secret-value")
  );
});

test("evidence files are deterministic and include JSON, CSV, Markdown, and normalized diff inputs", () => {
  const result = compareCsvTexts("Id,Name\n1,Ada\n", "Id,Name\n1,Grace\n", { keyColumns: ["Id"], name: "Review" });
  const first = createEvidenceFiles(result);
  const second = createEvidenceFiles(result);
  assert.deepEqual(first, second);
  assert.ok(first.some((file) => file.name === "ComparisonSummary.json"));
  assert.ok(first.some((file) => file.name === "ChangedRows.csv"));
  assert.ok(first.some((file) => file.name === "ColumnChangeSummary.csv"));
  assert.ok(first.some((file) => file.name === "NormalizedLeft.csv"));
  assert.match(first[1].content, /"diagnostic","key-changed"/);
});

test("desktop spill comparison preserves exact multiset and keyed duplicate behavior", async () => {
  const root = mkdtempSync(join(tmpdir(), "csv-contract-semantic-test-"));
  try {
    const left = join(root, "left.csv");
    const right = join(root, "right.csv");
    writeFileSync(left, "Id,Name\n0001,Ada\n0001,Grace\n0002,Linus\n", "utf8");
    writeFileSync(right, "Id,Name\n0001,Ada\n0002,Torvalds\n", "utf8");
    const result = await compareCsvPathsDesktop(left, right, { keyColumns: ["Id"] }, 1);
    assert.equal(result.summary.status, "duplicate-keys");
    assert.equal(result.summary.differences.duplicateKeysLeft, 1);
    assert.equal(result.summary.differences.changed, 1);
    assert.equal(result.summary.left.distinctRowCount, 3);
    assert.equal(result.details.normalizedRowsTruncated, true);
    const evidenceNames = createEvidenceFiles(result).map((file) => file.name);
    assert.ok(evidenceNames.includes("ComparisonSummary.json"));
    assert.ok(evidenceNames.includes("ChangedRows.csv"));
    assert.ok(!evidenceNames.includes("NormalizedLeft.csv"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

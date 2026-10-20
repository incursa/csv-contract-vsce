import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { strFromU8, unzipSync } from "fflate";
import { badRowsXlsx, type BadRowsRun } from "../src/bad-rows-xlsx";
import { writeBadRowsXlsxFile } from "../src/node/xlsx-stream";
import type { ValidationResult } from "../src/core/model";

let root = "";
before(async () => { root = await mkdtemp(join(tmpdir(), "csv-contract-xlsx-stream-")); });
after(async () => { await rm(root, { recursive: true, force: true }); });

function runs(count: number): BadRowsRun[] {
  const samples = Array.from({ length: count }, (_, index) => ({ primary: {
    label: "source.csv", row: index + 2, values: { Id: `id-${index}`, Value: `value-${index}` }
  } }));
  const result: ValidationResult = {
    valid: false, rowCount: count, columnCount: 2, testCount: 1, issueCount: count, errorCount: count, warningCount: 0, truncated: false,
    checkOutcomes: [{ id: "value-check", kind: "row-rule", status: "fail", selected: count, passed: 0, failed: count }],
    issues: [{ level: "row", code: "RULE_FAILED", testId: "value-check", message: "Value failed.", evidence: { samples, totalSamples: count } }]
  };
  return [{ member: "value-test", target: "source.csv", status: "FAIL", result }];
}

const options = {
  title: "Streamed workbook", limits: { maxRowsPerSheet: 4, maxColumnsPerSheet: 4 },
  checkCatalog: () => [{ id: "value-check", category: "Rule", description: "Value is valid." }]
};

test("streamed XLSX has consistent package relationships and the same parts as sync output", async () => {
  const destination = join(root, "success.xlsx");
  const written = await writeBadRowsXlsxFile(runs(7), options, destination);
  assert.equal(written.path, destination);
  assert.ok(written.sheets > 1);
  assert.ok(written.rows > 0);
  assert.ok(written.bytes > 0);
  const streamed = unzipSync(new Uint8Array(await readFile(destination)));
  const synchronous = unzipSync(badRowsXlsx(runs(7), options));
  assert.deepEqual(Object.keys(streamed).sort(), Object.keys(synchronous).sort());
  const workbook = strFromU8(streamed["xl/workbook.xml"]);
  const rels = strFromU8(streamed["xl/_rels/workbook.xml.rels"]);
  const sheetIds = [...workbook.matchAll(/<sheet [^>]*r:id="rId(\d+)"/g)].map(match => Number(match[1]));
  assert.equal(sheetIds.length, written.sheets);
  for (const id of sheetIds) {
    assert.match(rels, new RegExp(`<Relationship Id="rId${id}"[^>]*Target="worksheets/sheet${id}\\.xml"`));
    assert.ok(streamed[`xl/worksheets/sheet${id}.xml`]);
  }
  assert.equal((strFromU8(streamed["[Content_Types].xml"]).match(/spreadsheetml\.worksheet\+xml/g) ?? []).length, written.sheets);
  assert.deepEqual((await readdir(root)).filter(name => name.includes(".tmp")), []);
});

test("stream cancellation leaves no destination or partial temporary file", async () => {
  const destination = join(root, "canceled.xlsx");
  const controller = new AbortController();
  const writing = writeBadRowsXlsxFile(runs(4_000), { ...options, limits: undefined }, destination, { signal: controller.signal });
  setTimeout(() => controller.abort(), 0);
  await assert.rejects(writing, (error: Error) => error.name === "AbortError");
  const names = await readdir(root);
  assert.ok(!names.includes("canceled.xlsx"));
  assert.ok(!names.some(name => name.startsWith(".canceled.xlsx.")));
});

test("stream commit failure removes the partial file and preserves the destination", async () => {
  const destination = join(root, "blocked.xlsx");
  await mkdir(destination);
  await assert.rejects(() => writeBadRowsXlsxFile(runs(3), options, destination));
  const names = await readdir(root);
  assert.ok(names.includes("blocked.xlsx"));
  assert.ok(!names.some(name => name.startsWith(".blocked.xlsx.")));
});

test("no-clobber publication preserves an existing destination", async () => {
  const destination = join(root, "owned.xlsx");
  await writeFile(destination, "created by another process", "utf8");
  await assert.rejects(
    () => writeBadRowsXlsxFile(runs(3), options, destination, { overwrite: false }),
    (error: NodeJS.ErrnoException) => error.code === "EEXIST"
  );
  assert.equal(await readFile(destination, "utf8"), "created by another process");
  assert.ok(!(await readdir(root)).some(name => name.startsWith(".owned.xlsx.")));
});

test("no-clobber publication closes the serialization race", async () => {
  const destination = join(root, "raced.xlsx");
  const writing = writeBadRowsXlsxFile(runs(4_000), { ...options, limits: undefined }, destination, { overwrite: false });
  await writeFile(destination, "race winner", "utf8");
  await assert.rejects(writing, (error: NodeJS.ErrnoException) => error.code === "EEXIST");
  assert.equal(await readFile(destination, "utf8"), "race winner");
  assert.ok(!(await readdir(root)).some(name => name.startsWith(".raced.xlsx.")));
});

test("serialization failure settles and removes its temporary file", { timeout: 5_000 }, async () => {
  const destination = join(root, "malformed.xlsx");
  const malformed = runs(1);
  malformed[0].result!.issues[0].evidence!.samples[0].primary!.values.Bad = {
    toString(): string { throw new Error("synthetic serialization failure"); }
  } as unknown as string;
  await assert.rejects(() => writeBadRowsXlsxFile(malformed, options, destination), /synthetic serialization failure/);
  const names = await readdir(root);
  assert.ok(!names.includes("malformed.xlsx"));
  assert.ok(!names.some(name => name.startsWith(".malformed.xlsx.")));
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { compareDefinition, definitionFromResult, parseDefinition, validatePortableExecution, type ComparisonDefinition } from "../src/comparison/definition";
import { compareCsvTexts } from "../src/comparison/engine";

const root = join(process.cwd(), "test", "fixtures", "comparisons");
const fixture = () => parseDefinition(readFileSync(join(root, "portable.comparison.json"), "utf8"));
test("SSMS interchange fixture preserves renamed mappings, dates, decimals, exclusions and exact keys", () => {
  const result = compareDefinition(fixture(), readFileSync(join(root, "before.csv"), "utf8"), readFileSync(join(root, "after.csv"), "utf8"));
  assert.equal(result.summary.differences.unchanged, 2); assert.equal(result.summary.semanticEqual, true);
});
test("VS Code save produces portable keyed setup and retains legacy options explicitly", () => {
  const result = compareCsvTexts("Id,A\n001,foo\n", "Id,A\n001,foo\n", { keyColumns: ["Id"] });
  const saved = definitionFromResult("a.csv", "b.csv", result);
  assert.equal(saved.vscodeOptions, undefined);
  assert.equal(compareDefinition(parseDefinition(JSON.stringify(saved)), "Id,A\n001,foo\n", "Id,A\n001,foo\n").summary.semanticEqual, true);
  const legacy = definitionFromResult("a.csv", "b.csv", compareCsvTexts("Id\na\n", "Id\nA\n", { normalization: { caseFold: true } }));
  assert.equal(legacy.vscodeOptions?.normalization?.caseFold, true);
  assert.equal(compareDefinition(legacy, "Id\na\n", "Id\nA\n").summary.semanticEqual, true);
});
test("Unsupported versions, SQL, conversions and duplicate converted keys fail explicitly", () => {
  assert.throws(() => parseDefinition("{}"), /version/);
  const sql = fixture(); sql.right.kind = "Table"; assert.throws(() => validatePortableExecution(sql), /SSMS/);
  const unsupported = fixture(); unsupported.mappings[1].conversion = "Auto (SQL type)"; assert.throws(() => validatePortableExecution(unsupported), /not supported/);
  const numeric = fixture(); numeric.mappings = [{ left: "Id", right: "Id", key: true, include: true, conversion: "Decimal" }];
  assert.throws(() => compareDefinition(numeric, "Id\n01\n1\n", "Id\n1\n"), /duplicate/);
  assert.throws(() => compareDefinition(numeric, "Id\nprivate\n", "Id\n1\n"), error => error instanceof Error && /conversion failed/.test(error.message) && !error.message.includes("private"));
});
for (const [mode, left, right] of [
  ["Date", "9/23/2026", "2026-09-23"],
  ["Date", "20260923", "2026-09-23"],
  ["Date/time", "9/23/2026 2:03:04 PM", "2026-09-23T14:03:04.0000000"],
  ["Date/time", "2026-09-23 14:03:04.1234567", "2026-09-23T14:03:04.1234567"],
  ["Decimal", "12345678901234567890123456789012345678", "12345678901234567890123456789012345678"],
  ["Boolean", "True", "1"], ["Binary", "0xab10", "0xAB10"],
  ["GUID", "{44EC78B5-75B8-4C0A-AD41-EBC2EC656FF8}", "44ec78b5-75b8-4c0a-ad41-ebc2ec656ff8"]
]) test(`Portable ${mode}: ${left}`, () => {
  const value: ComparisonDefinition = { ...fixture(), mappings: [{ left: "Value", right: "Value", key: true, include: true, conversion: mode }] };
  assert.equal(compareDefinition(value, `Value\n${left}\n`, `Value\n${right}\n`).summary.semanticEqual, true);
});
test("Date conversion never discards a non-midnight time", () => {
  const value = { ...fixture(), mappings: [{ left: "Value", right: "Value", key: true, include: true, conversion: "Date" }] };
  assert.throws(() => compareDefinition(value, "Value\n2026-09-23T01:00:00\n", "Value\n2026-09-23\n"), /conversion failed/);
});
test("Portable exact mode preserves blank rows and whitespace keys", () => {
  const value = { ...fixture(), mappings: [{ left: "Value", right: "Value", key: true, include: true, conversion: "Exact" }] };
  const result = compareDefinition(value, "Value\n\n \n", "Value\n \n\n");
  assert.equal(result.summary.differences.unchanged, 2);
  assert.throws(() => compareDefinition(value, "Value\n\n\n", "Value\n\n"), /duplicate/);
});

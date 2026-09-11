import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { stringify } from "yaml";
import Papa from "papaparse";
import { loadSuite, generateSuiteSql, runSuite } from "../src/core/suite";
import { fileSuiteIO, combineSuite, splitSuite } from "../src/node/suite-files";
import { parseContract, validateCsv } from "../src/core/contract";
import { generateSqlServerValidation } from "../src/core/sql-server-generator";
import type { CsvContract } from "../src/core/model";

const directory = process.env.CSV_CONTRACT_ACCEPTANCE_DIR;
test("23-table offline acceptance: unchanged sources, equivalent SQL and synthetic results, portable round trip", { skip: !directory }, async () => {
  const root = directory!;
  const names = (await readdir(root)).filter((name) => name.endsWith(".csvtest.yaml")).sort();
  assert.equal(names.length, 23);
  const before = await Promise.all(names.map((name) => readFile(join(root, name), "utf8")));
  const master = join(root, "mckee-hcm.csvsuite.yaml");
  const portable = join(root, "mckee-hcm.portable.csvsuite.yaml");
  await writeFile(master, stringify({ suiteVersion: 1, id: "mckee-hcm", name: "McKee HCM staging validation", metadata: { verification: "Offline only; no database connection or employee data used." }, members: names.map((name) => ({ id: name.replace(".csvtest.yaml", ""), ref: `./${name}` })) }), { flag: "wx" });
  await combineSuite(master, portable);
  const referenced = await loadSuite(master, fileSuiteIO);
  const inline = await loadSuite(portable, fileSuiteIO);
  assert.equal(referenced.members.filter((m) => m.error).length, 0);
  assert.deepEqual(referenced.members.map((m) => m.contract), before.map(parseContract));
  assert.deepEqual(inline.members.map((m) => m.contract), before.map(parseContract));
  const sql = generateSuiteSql(referenced);
  assert.deepEqual(generateSuiteSql(inline), sql);
  for (const [index, text] of before.entries()) {
    const single = generateSqlServerValidation(parseContract(text), { includeDetailQueries: false, suite: { id: "mckee-hcm", member: referenced.members[index].id } });
    assert.deepEqual(sql.batches[index].rules, single.rules);
    assert.equal(sql.batches[index].sql, single.sql);
    assert.equal(parseContract(text).targets, undefined);
  }
  const synthetic = async (contract: CsvContract) => {
    const fields = Object.keys(contract.schema.columns);
    // In-memory blank rows exercise the same finite rules as SQL client fallback; these are not employee records or input files.
    return validateCsv({ ...contract, rules: [...(contract.rules ?? []), ...(contract.sqlServer?.conditionalRules ?? [])] }, Papa.unparse({ fields, data: [fields.map(() => "")] }));
  };
  const refResult = await runSuite(referenced, synthetic);
  const inlineResult = await runSuite(inline, synthetic);
  for (const report of [refResult, inlineResult]) assert(report.runs.every(r => r.result?.evaluatedAt === report.startedAt));
  // Evaluation timestamps identify distinct executions; all validation semantics must match.
  const semanticResults = (report: typeof refResult) => report.runs.map(r => r.result ? { ...r.result, evaluatedAt: undefined } : undefined);
  assert.deepEqual(semanticResults(refResult), semanticResults(inlineResult));
  const temporary = await mkdtemp(join(tmpdir(), "mckee-suite-"));
  try {
    const split = await splitSuite(portable, temporary);
    const restored = await loadSuite(split.master, fileSuiteIO);
    assert.deepEqual(restored.members.map((m) => m.contract), before.map(parseContract));
    assert.deepEqual(generateSuiteSql(restored), sql);
  } finally { await rm(temporary, { recursive: true, force: true }); }
  assert.deepEqual(await Promise.all(names.map((name) => readFile(join(root, name), "utf8"))), before);
  await writeFile(join(root, "mckee-hcm.acceptance.json"), JSON.stringify({ verification: "OFFLINE ONLY: generated SQL equality and synthetic blank-row validation. No database verification, data export, or employee records.", members: 23, ruleCount: sql.ruleCount, warnings: sql.warnings, syntheticSummary: refResult.summary, sourcesUnchanged: true, roundTripEquivalent: true, sources: names.map((name, i) => ({ name, sha256: createHash("sha256").update(before[i]).digest("hex"), rules: sql.batches[i].ruleCount })) }, null, 2), { flag: "wx" });
});

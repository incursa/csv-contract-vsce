import { resolveBaseline, resolveTargetBaseline } from "./core/baseline";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { parseContract, parseCsv, serializeContract } from "./core/contract";
import { evaluateCsvCrossCheck } from "./core/cross-checks";
import { createContractOutlineFromFile } from "./node/contract-generator";
import { validateCsvFile } from "./node/streaming-validator";
import { createTargetPlans, resolveConfiguredTarget } from "./node/target-plan";
import { withMaterializedTarget } from "./node/target-source";
import { generateSqlServerValidation } from "./core/sql-server-generator";
import { mergeImportedSchema, parseSqlSchemaSource } from "./core/sql-schema-import";
import { resolveSqlServerTargets } from "./core/sql-server-targets";
import { loadSuite, runSuite, generateSuiteSql } from "./core/suite";
import { fileSuiteIO, combineSuite, splitSuite } from "./node/suite-files";
import { SqlServerValidationSession } from "./node/sql-server-validator";
import { createCrossConnectionSourceAdapter, runCrossConnectionCheck } from "./node/cross-connection-runner";
import { parseValidationReviewPackage } from "./core/review-package";
import { compareValidationReviewPackages } from "./core/review-diff";
import { renderReviewDiffHtml } from "./review-diff-report";
import { runValidationFixtures } from "./node/rule-fixtures";
import { redactIssueExportRuns } from "./core/evidence-redaction";
import { writeBadRowsXlsxFile } from "./node/xlsx-stream";
import type { BadRowsRun } from "./bad-rows-xlsx";

interface ParsedArgs {
  command: string;
  csvs: string[];
  specs: string[];
  out?: string;
  format: "text" | "json";
  maxIssues: number;
  progressInterval: number;
  uniquePartitions: number;
  tempDirectory?: string;
  sampleRows: number;
  inferConstraints: boolean;
  includeSampleTests: boolean;
  source?: string;
  table?: string;
  scopes: Record<string, string>;
  force: boolean;
  failFast: boolean;
  allowExternal: boolean;
  before?: string;
  after?: string;
  includeDetails: boolean;
}

export const cliUsage = `Validation Workbench

Usage:
  csv-contract combine --spec <master.validationsuite.yaml> --out <portable.validationsuite.yaml> [--force] [--allow-external]
  csv-contract split --spec <portable.validationsuite.yaml> --out <directory> [--force]
  csv-contract dbtest --spec <suite.validationsuite.yaml> [--fail-fast] [--format json]
  csv-contract test [--csv <file-or-url>] --spec <contract.validation.yaml> [--spec <spot-check.yaml>]
                    [--format text|json] [--max-issues 1000] [--progress-interval 250000]
                    [--unique-partitions 128] [--temp-directory <path>]
  csv-contract init --csv <file.csv> --out <contract.validation.yaml>
                    [--sample-rows 10000] [--infer-constraints] [--no-sample-tests]
  csv-contract sql --spec <contract.validation.yaml> --out <validation.sql> [--table <target-name-or-schema.table>]
  csv-contract dbtest --spec <contract.validation.yaml> [--spec <another.validation.yaml>]
                      [--scope <parameter=value>] [--format text|json] [--max-issues 1000]
  csv-contract schema --source <table.sql-or-json> --out <contract.validation.yaml>
                      [--spec <existing.validation.yaml>] [--table <schema.name>]
  csv-contract review --source <validation-review.json> [--format text|json]
  csv-contract export --source <validation-review.json> --out <offline-report.xlsx>
                      [--include-details] [--force]
  csv-contract diff --before <older-review.json> --after <newer-review.json>
                    [--out <offline-diff.html>] [--format text|json]
  csv-contract fixtures --source <fixtures.yaml> [--format text|json]
  csv-contract explain --spec <definition-or-suite.yaml> [--format text|json]

Repeat --csv to test multiple explicit files or URLs. When --csv is omitted, targets come from each contract.
Compatible contracts targeting the same CSV are applied in one pass.
Legacy .csvtest.yaml and .csvsuite.yaml names remain fully supported.
SQL Server connection profile 'warehouse' resolves from CSV_CONTRACT_SQLSERVER_WAREHOUSE.
Progress is written to stderr so JSON stdout remains machine-readable.
`;

export class CliUsageError extends Error {
  constructor() {
    super(cliUsage);
    this.name = "CliUsageError";
  }
}

function usage(): never {
  throw new CliUsageError();
}

function positiveInteger(value: string, name: string, allowZero = false): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new Error(`${name} must be ${allowZero ? "a non-negative" : "a positive"} integer.`);
  }
  return parsed;
}

function parseArgs(argv: string[]): ParsedArgs {
  const command = argv.shift();
  if (!command) usage();
  const result: ParsedArgs = {
    command,
    csvs: [],
    specs: [],
    format: "text",
    maxIssues: 1000,
    progressInterval: 250000,
    uniquePartitions: 128,
    sampleRows: 10000,
    inferConstraints: false,
    includeSampleTests: true,
    scopes: {}, force: false, failFast: false, allowExternal: false, includeDetails: false
  };
  while (argv.length) {
    const token = argv.shift()!;
    if (token === "--force") { result.force = true; continue; }
    if (token === "--fail-fast") { result.failFast = true; continue; }
    if (token === "--allow-external") { result.allowExternal = true; continue; }
    if (token === "--include-details") { result.includeDetails = true; continue; }
    if (token === "--infer-constraints") {
      result.inferConstraints = true;
      continue;
    }
    if (token === "--no-sample-tests") {
      result.includeSampleTests = false;
      continue;
    }
    const value = argv.shift();
    if (value === undefined) usage();
    if (token === "--csv") result.csvs.push(value);
    else if (token === "--spec") result.specs.push(value);
    else if (token === "--out") result.out = value;
    else if (token === "--format" && (value === "text" || value === "json")) result.format = value;
    else if (token === "--max-issues") result.maxIssues = positiveInteger(value, "maxIssues");
    else if (token === "--progress-interval") result.progressInterval = positiveInteger(value, "progressInterval", true);
    else if (token === "--unique-partitions") result.uniquePartitions = positiveInteger(value, "uniquePartitions");
    else if (token === "--temp-directory") result.tempDirectory = value;
    else if (token === "--sample-rows") result.sampleRows = positiveInteger(value, "sampleRows");
    else if (token === "--source") result.source = value;
    else if (token === "--before") result.before = value;
    else if (token === "--after") result.after = value;
    else if (token === "--table") result.table = value;
    else if (token === "--scope") {
      const separator = value.indexOf("=");
      if (separator < 1) throw new Error("--scope must use parameter=value.");
      result.scopes[value.slice(0, separator)] = value.slice(separator + 1);
    }
    else usage();
  }
  return result;
}

function formatBytes(value: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let scaled = value;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${scaled.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

async function initialize(args: ParsedArgs, csvPath: string): Promise<void> {
  if (!args.out) usage();
  const output = resolve(args.out);
  const generated = await createContractOutlineFromFile(csvPath, {
    sampleRows: args.sampleRows,
    inferConstraints: args.inferConstraints,
    includeSampleTests: args.includeSampleTests
  });
  const relativePath = relative(dirname(output), csvPath);
  let targetPath = (isAbsolute(relativePath) ? csvPath : relativePath).split(sep).join("/");
  if (!isAbsolute(relativePath) && !targetPath.startsWith(".")) targetPath = `./${targetPath}`;
  generated.contract.targets = [{ path: targetPath }];
  const schemaUrl = "https://raw.githubusercontent.com/incursa/csv-contract-vsce/main/schemas/csvtest.schema.json";
  const preamble = [
    `# Generated from ${basename(csvPath)} by Validation Workbench.`,
    "# Review column presence and replace or remove generated sample assertions before relying on this contract.",
    args.inferConstraints
      ? `# Constraint values were inferred from the first ${generated.sampledRows} data rows and must be reviewed.`
      : "# No data constraints were inferred; add notNull, unique, length, regex, or allowedValues rules deliberately."
  ].join("\n");
  await writeFile(output, `${preamble}\n${serializeContract(generated.contract, schemaUrl)}`, "utf8");
  console.log(`Created ${output} (${generated.contract.schema.columnCount?.exact} columns, ${generated.sampledRows} sampled rows).`);
}

async function testCsv(args: ParsedArgs): Promise<void> {
  if (args.specs.length === 0) usage();
  if (args.failFast) throw new Error("--fail-fast is supported by dbtest; CSV test retains its existing streaming behavior.");
  const inputs = [];
  for (const specInput of args.specs) {
    const spec = resolve(specInput);
    const suite = await loadSuite(spec, fileSuiteIO);
    for (const member of suite.members) {
      if (member.error || !member.contract) throw new Error(`${suite.id}/${member.id}: ${member.error}`);
      const contract = structuredClone(member.contract);
      if (contract.targets) contract.targets = contract.targets.map((target) => target.path !== undefined
        ? { path: resolveConfiguredTarget(member.source, target) } : target);
      inputs.push({ spec: suite.isSuite ? `${spec}#${suite.id}:${member.id}` : spec, contract });
    }
  }
  const plans = createTargetPlans(inputs, args.csvs);
  const files = [];
  for (const plan of plans) {
    const output = await withMaterializedTarget(plan.source, {
      tempDirectory: args.tempDirectory ? resolve(args.tempDirectory) : undefined
    }, (localPath) => validateCsvFile(localPath, plan.inputs, {
      maxIssues: args.maxIssues,
      progressInterval: args.progressInterval,
      tempDirectory: args.tempDirectory ? resolve(args.tempDirectory) : undefined,
      uniquePartitions: args.uniquePartitions,
      onProgress: ({ pass, passes, rows, bytesRead }) => {
        console.error(`Progress ${plan.source} pass ${pass}/${passes}: ${rows.toLocaleString()} rows, ${formatBytes(bytesRead)} read`);
      }
    }));
    files.push({ csv: plan.source, ...output });
  }
  const valid = files.every((file) => file.valid);
  if (args.format === "json") {
    console.log(JSON.stringify(files.length === 1 ? files[0] : { valid, files }, null, 2));
  } else {
    for (const file of files) {
      console.log(`${file.valid ? "PASS" : "FAIL"} ${file.csv}`);
      for (const run of file.runs) {
        const shown = run.result.truncated ? `; showing first ${run.result.issues.length}` : "";
        console.log(`  ${run.result.valid ? "PASS" : "FAIL"} ${run.spec} — ${run.result.rowCount.toLocaleString()} rows, ${run.result.columnCount} columns, ${run.result.errorCount.toLocaleString()} errors, ${run.result.warningCount.toLocaleString()} warnings${shown}`);
        for (const issue of run.result.issues) {
          const location = [issue.column, issue.row ? `record ${issue.row}` : undefined, issue.testId].filter(Boolean).join(" · ");
          console.log(`    ${(issue.severity ?? "error").toUpperCase()} ${issue.code}${location ? ` [${location}]` : ""}: ${issue.message}`);
        }
      }
      console.log(`  Performance: ${(file.performance.durationMs / 1000).toFixed(2)}s, ${file.performance.rowsPerSecond.toLocaleString()} rows/s, ${formatBytes(file.performance.bytesRead)} read, ${formatBytes(file.performance.maxRssBytes)} peak RSS, ${file.performance.passes} pass(es)`);
    }
    if (files.length > 1) console.log(`${valid ? "PASS" : "FAIL"} ${files.length} CSV targets.`);
  }
  process.exitCode = valid ? 0 : 1;
}

async function generateSql(args: ParsedArgs): Promise<void> {
  if (args.specs.length !== 1 || !args.out) usage();
  const spec = resolve(args.specs[0]);
  const output = resolve(args.out);
  const suite = await loadSuite(spec, fileSuiteIO);
  if (suite.isSuite) {
    if (args.table) throw new Error("Suite SQL generation includes all targets; --table is only for single contracts.");
    const generated = generateSuiteSql(suite);
    const connections = new Set(generated.batches.map((b) => JSON.stringify(b.integratedConnection ?? b.connection)));
    if (connections.size > 1 && args.format !== "json") throw new Error("Suite targets different connections. Use --format json to generate a complete batch manifest; execute each batch only on its declared connection.");
    await writeFile(output, args.format === "json" ? JSON.stringify(generated, null, 2) : generated.sql, { flag: args.force ? "w" : "wx" });
    console.log("Created " + output + " (" + generated.ruleCount + " rules, " + generated.batches.length + " isolated batches).");
    generated.warnings.forEach((warning) => console.error("WARNING: " + warning));
    return;
  }
  const contract = parseContract(await readFile(spec, "utf8"));
  if (contract.groupTests?.length || contract.orderedRules?.length) throw new Error("Standalone SQL generation cannot include grouped or ordered rules. Run dbtest to execute the complete contract.");
  const targets = resolveSqlServerTargets(contract, false);
  const target = args.table
    ? targets.find((candidate) =>
        candidate.name?.toLocaleLowerCase() === args.table!.toLocaleLowerCase() ||
        `${candidate.schema}.${candidate.table}`.toLocaleLowerCase() === args.table!.toLocaleLowerCase()
      )
    : targets.length === 1 ? targets[0] : undefined;
  if (!target) {
    const choices = targets.map((candidate) => candidate.name ?? `${candidate.schema}.${candidate.table}`).join(", ");
    throw new Error(args.table ? `SQL target '${args.table}' was not found. Available targets: ${choices}` : `The contract has multiple SQL targets; use --table. Available targets: ${choices}`);
  }
  const generated = generateSqlServerValidation(contract, { target });
  await writeFile(output, generated.sql, "utf8");
  console.log(`Created ${output} (${generated.ruleCount} SQL validation rules).`);
  for (const warning of generated.warnings) console.error(`WARNING: ${warning}`);
}

async function testSqlServer(args: ParsedArgs): Promise<void> {
  if (args.specs.length === 0) usage();
  const session = new SqlServerValidationSession((profile) => {
    const environmentName = `CSV_CONTRACT_SQLSERVER_${profile.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
    const connectionString = process.env[environmentName];
    if (!connectionString) throw new Error(`Connection profile '${profile}' requires environment variable ${environmentName}.`);
    return connectionString;
  });
  const reports = [];
  try {
    for (const specInput of args.specs) {
      try {
        const suite = await loadSuite(resolve(specInput), fileSuiteIO);
        reports.push(await runSuite(suite, async (contract, target, source) => session.validate(await resolveBaseline(contract, source, fileSuiteIO), await resolveTargetBaseline(target, source, fileSuiteIO), {
          maxIssues: args.maxIssues,
          scopeValue: target.scope ? args.scopes[target.scope.parameter] : undefined
        }), args.failFast, async (contract, source, target) => {
          const resolved = resolveConfiguredTarget(source, target);
          return withMaterializedTarget(resolved, { tempDirectory: args.tempDirectory ? resolve(args.tempDirectory) : undefined }, async localPath => {
            const output = await validateCsvFile(localPath, [{ spec: source, contract: await resolveBaseline(contract, source, fileSuiteIO) }], { maxIssues: args.maxIssues });
            return output.runs[0].result;
          });
        }, { crossExecutor: async plan => {
          if (plan.mode === "sql") return session.validateCross(plan);
          if (plan.mode === "sql-cross-connection") {
            const scopeValues = Object.fromEntries([plan.from, plan.to, ...Object.values(plan.participants)].flatMap(participant => {
              const parameter = participant.target.scope?.parameter;
              return parameter && args.scopes[parameter] !== undefined ? [[participant.member, args.scopes[parameter]]] : [];
            }));
            return runCrossConnectionCheck(plan, createCrossConnectionSourceAdapter(session.readBoundedRows.bind(session)), { scopeValues });
          }
          const read = async (participant: typeof plan.from) => withMaterializedTarget(resolveConfiguredTarget(participant.source, participant.target),
            { tempDirectory: args.tempDirectory ? resolve(args.tempDirectory) : undefined }, async localPath => parseCsv(await readFile(localPath, "utf8"), participant.contract.csv));
          const [from, to, participants] = await Promise.all([
            read(plan.from), read(plan.to),
            Promise.all(Object.entries(plan.participants).map(async ([id, participant]) => [id, await read(participant)] as const)).then(Object.fromEntries)
          ]);
          return evaluateCsvCrossCheck(plan, from, to, participants);
        } }));
      } catch (error) {
        reports.push(await runSuite({ id: specInput, source: specInput, isSuite: true,
          members: [{ id: specInput, source: specInput, error: error instanceof Error ? error.message : String(error) }] },
          async () => { throw new Error("Invalid suite"); }));
      }
    }
  } finally {
    await session.dispose();
  }
  const valid = reports.length > 0 && reports.every((report) => report.valid);
  const runs = reports.flatMap((report) => report.runs);
  if (args.format === "json") console.log(JSON.stringify({ valid, reports, runs }, null, 2));
  else {
    for (const report of reports) {
      console.log(report.status + " " + report.suite + ": " + JSON.stringify(report.summary));
      for (const run of report.runs) {
        const location = run.suite + "/" + run.member + "/" + (run.table ?? "unresolved");
        console.log("  " + run.status + " " + location + (run.error ? ": " + run.error : ""));
        for (const issue of run.result?.issues ?? []) console.log("    " + location + "/" + (issue.testId ?? issue.code) + ": " + issue.message);
      }
    }
    console.log((valid ? "PASS" : "FAIL") + " overall (" + runs.length + " runs).");
  }
  process.exitCode = Math.max(...reports.map((report) => report.exitCode), 0);
}

async function importSchema(args: ParsedArgs): Promise<void> {
  if (!args.source || !args.out || args.specs.length > 1) usage();
  const source = resolve(args.source);
  const extension = /\.[^.\\/]+$/.exec(source)?.[0] ?? "";
  const tables = parseSqlSchemaSource(await readFile(source, "utf8"), extension);
  const table = args.table
    ? tables.find((candidate) => `${candidate.schema}.${candidate.table}`.toLocaleLowerCase() === args.table!.toLocaleLowerCase())
    : tables.length === 1 ? tables[0] : undefined;
  if (!table) {
    const choices = tables.map((candidate) => `${candidate.schema}.${candidate.table}`).join(", ");
    throw new Error(args.table ? `Table '${args.table}' was not found. Available tables: ${choices}` : `The source contains multiple tables; use --table. Available tables: ${choices}`);
  }
  const contract = args.specs.length
    ? parseContract(await readFile(resolve(args.specs[0]), "utf8"))
    : { version: 1 as const, schema: { allowAdditionalColumns: true, columns: {} } };
  const merged = mergeImportedSchema(contract, table);
  const schemaUrl = "https://raw.githubusercontent.com/incursa/csv-contract-vsce/main/schemas/csvtest.schema.json";
  await writeFile(resolve(args.out), serializeContract(merged.contract, schemaUrl), "utf8");
  console.log(`Imported ${table.columns.length} columns from ${table.schema}.${table.table} into ${resolve(args.out)}.`);
  console.log(`Added ${merged.preview.addedColumns.length}; preserved ${merged.preview.existingColumns.length} existing and ${merged.preview.contractOnlyColumns.length} contract-only columns.`);
  if (merged.preview.preservedConflicts.length) console.error(`WARNING: Preserved reviewed conflicts: ${merged.preview.preservedConflicts.join(", ")}`);
}

async function reviewSavedRun(args: ParsedArgs): Promise<number> {
  if (!args.source) usage();
  const review = parseValidationReviewPackage(await readFile(resolve(args.source), "utf8"));
  if (args.format === "json") console.log(JSON.stringify(review, null, 2));
  else {
    console.log(`${review.summary.evaluationComplete ? "COMPLETE" : "INCOMPLETE"} ${review.source.reference}`);
    console.log(`${review.summary.targets} targets; ${review.summary.rowsScanned.toLocaleString()} rows scanned; ${review.summary.issues.toLocaleString()} issues (${review.summary.errors.toLocaleString()} errors, ${review.summary.warnings.toLocaleString()} warnings).`);
    console.log(`Evidence: ${review.evidence.mode}; retained details: ${review.summary.retainedIssueDetails.toLocaleString()}.`);
  }
  return review.summary.evaluationComplete && review.summary.errors === 0 ? 0 : 1;
}

async function diffSavedRuns(args: ParsedArgs): Promise<number> {
  if (!args.before || !args.after) usage();
  const [before, after] = await Promise.all([
    readFile(resolve(args.before), "utf8").then(parseValidationReviewPackage),
    readFile(resolve(args.after), "utf8").then(parseValidationReviewPackage)
  ]);
  const comparison = compareValidationReviewPackages(before, after);
  if (args.out) await writeFile(resolve(args.out), renderReviewDiffHtml(comparison), "utf8");
  if (args.format === "json") console.log(JSON.stringify(comparison, null, 2));
  else console.log(`Review diff: ${comparison.summary.newRules} new, ${comparison.summary.resolvedRules} resolved, ${comparison.summary.persistentRules} persistent, ${comparison.summary.indeterminateItems} indeterminate.${args.out ? ` HTML: ${resolve(args.out)}` : ""}`);
  return comparison.summary.newRules || comparison.summary.indeterminateItems ? 1 : 0;
}

async function samePath(left: string, right: string): Promise<boolean> {
  const a = resolve(left);
  const b = resolve(right);
  if (process.platform === "win32" ? a.toLocaleLowerCase() === b.toLocaleLowerCase() : a === b) return true;
  try {
    const [aReal, bReal, aStat, bStat] = await Promise.all([realpath(a), realpath(b), stat(a), stat(b)]);
    if (process.platform === "win32" ? aReal.toLocaleLowerCase() === bReal.toLocaleLowerCase() : aReal === bReal) return true;
    return aStat.ino !== 0 && aStat.dev === bStat.dev && aStat.ino === bStat.ino;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function exportSavedRun(args: ParsedArgs): Promise<number> {
  if (!args.source || !args.out) usage();
  const source = resolve(args.source);
  const destination = resolve(args.out);
  if (await samePath(source, destination)) throw new Error("Review source and Excel destination must be different files.");
  if (extname(destination).toLocaleLowerCase() !== ".xlsx") throw new Error("Review export output must use the .xlsx extension.");
  if (!args.force && await exists(destination)) throw new Error(`Output already exists: ${destination}. Use --force to replace it.`);

  const review = parseValidationReviewPackage(await readFile(source, "utf8"));
  const exportedRuns = review.targets.map(target => ({
    runId: target.runId,
    workId: target.workId,
    evaluatedAt: target.evaluatedAt,
    scope: target.scope,
    target: target.target,
    status: target.status,
    result: target.result,
    error: target.error
  }));
  const redacted = redactIssueExportRuns(exportedRuns, args.includeDetails ? { mode: "detail" } : { mode: "aggregate-only" });
  const runs: BadRowsRun[] = redacted.runs.map(run => ({
    target: run.target,
    status: run.status,
    evaluatedAt: run.evaluatedAt,
    result: run.result,
    error: run.error
  }));
  const written = await writeBadRowsXlsxFile(runs, {
    title: `Validation review: ${review.source.reference}`,
    testLabel: review.source.reference
  }, destination, { overwrite: args.force });
  const detail = args.includeDetails ? "retained redacted detail included" : "aggregate-only evidence";
  console.log(`Created ${written.path} (${written.sheets} sheets, ${written.rows.toLocaleString()} workbook rows, ${formatBytes(written.bytes)}; ${detail}).`);
  if (args.includeDetails && !review.summary.issueDetailsComplete) console.error("WARNING: The saved package retained incomplete issue detail; export cannot restore missing evidence.");
  return 0;
}

async function runFixtures(args: ParsedArgs): Promise<number> {
  if (!args.source) usage();
  const result = await runValidationFixtures(resolve(args.source));
  if (args.format === "json") console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`${result.failed ? "FAIL" : "PASS"} ${result.id}: ${result.passed}/${result.total} cases passed.`);
    for (const item of result.cases.filter((entry) => !entry.passed)) console.log(`  FAIL ${item.id}: ${item.failures.join("; ")}`);
  }
  return result.failed ? 1 : 0;
}

async function explainDefinition(args: ParsedArgs): Promise<number> {
  if (args.specs.length !== 1) usage();
  const suite = await loadSuite(resolve(args.specs[0]), fileSuiteIO);
  const explanation = {
    suite: suite.id,
    source: suite.source,
    members: suite.members.map((member) => ({ id: member.id, source: member.source, error: member.error, rulePacks: member.rulePackProvenance ?? [] })),
    targetPolicy: suite.targetPolicy,
    targetPolicyDiagnostics: suite.targetPolicyDiagnostics ?? []
  };
  if (args.format === "json") console.log(JSON.stringify(explanation, null, 2));
  else {
    console.log(`${suite.isSuite ? "Suite" : "Definition"} ${suite.id}`);
    for (const member of explanation.members) {
      console.log(`  ${member.error ? "ERROR" : "OK"} ${member.id}: ${member.source}`);
      for (const pack of member.rulePacks) console.log(`    ${pack.packId}/${pack.definitionId} ${pack.sha256} (${pack.source})`);
      if (member.error) console.log(`    ${member.error}`);
    }
  }
  return suite.members.some((member) => member.error) ? 1 : 0;
}

export async function runCli(argv: string[]): Promise<number> {
  const args = parseArgs([...argv]);
  if (args.command === "combine" || args.command === "split") {
    if (args.specs.length !== 1 || !args.out) usage();
    const result = args.command === "combine"
      ? await combineSuite(args.specs[0], args.out, { force: args.force, allowExternal: args.allowExternal })
      : await splitSuite(args.specs[0], args.out, args.force);
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  if (args.command === "init") {
    if (args.csvs.length !== 1) usage();
    const csvPath = resolve(args.csvs[0]);
    await initialize(args, csvPath);
    return 0;
  }
  if (args.command === "test") {
    await testCsv(args);
    return process.exitCode === 1 ? 1 : 0;
  }
  if (args.command === "sql") {
    await generateSql(args);
    return 0;
  }
  if (args.command === "dbtest") {
    await testSqlServer(args);
    return typeof process.exitCode === "number" ? process.exitCode : 0;
  }
  if (args.command === "schema") {
    await importSchema(args);
    return 0;
  }
  if (args.command === "review") return reviewSavedRun(args);
  if (args.command === "export") return exportSavedRun(args);
  if (args.command === "diff") return diffSavedRuns(args);
  if (args.command === "fixtures") return runFixtures(args);
  if (args.command === "explain") return explainDefinition(args);
  usage();
}

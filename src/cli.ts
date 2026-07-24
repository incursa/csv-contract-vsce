import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { parseContract, serializeContract } from "./core/contract";
import { createContractOutlineFromFile } from "./node/contract-generator";
import { validateCsvFile } from "./node/streaming-validator";
import { createTargetPlans } from "./node/target-plan";
import { withMaterializedTarget } from "./node/target-source";

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
}

function usage(): never {
  console.error(`CSV Contract Workbench

Usage:
  csv-contract test [--csv <file-or-url>] --spec <contract.csvtest.yaml> [--spec <spot-check.yaml>]
                    [--format text|json] [--max-issues 1000] [--progress-interval 250000]
                    [--unique-partitions 128] [--temp-directory <path>]
  csv-contract init --csv <file.csv> --out <contract.csvtest.yaml>
                    [--sample-rows 10000] [--infer-constraints] [--no-sample-tests]

Repeat --csv to test multiple explicit files or URLs. When --csv is omitted, targets come from each contract.
Compatible contracts targeting the same CSV are applied in one pass.
Progress is written to stderr so JSON stdout remains machine-readable.
`);
  process.exit(2);
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
    includeSampleTests: true
  };
  while (argv.length) {
    const token = argv.shift()!;
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
  let targetPath = relative(dirname(output), csvPath).split(sep).join("/");
  if (!targetPath.startsWith(".")) targetPath = `./${targetPath}`;
  generated.contract.targets = [{ path: targetPath }];
  const schemaUrl = "https://raw.githubusercontent.com/incursa/csv-contract-vsce/main/schemas/csvtest.schema.json";
  const preamble = [
    `# Generated from ${basename(csvPath)} by CSV Contract Workbench.`,
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
  const inputs = [];
  for (const specInput of args.specs) {
    const spec = resolve(specInput);
    inputs.push({ spec, contract: parseContract(await readFile(spec, "utf8")) });
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
        console.log(`  ${run.result.valid ? "PASS" : "FAIL"} ${run.spec} — ${run.result.rowCount.toLocaleString()} rows, ${run.result.columnCount} columns, ${run.result.issueCount.toLocaleString()} issues${shown}`);
        for (const issue of run.result.issues) {
          const location = [issue.column, issue.row ? `record ${issue.row}` : undefined, issue.testId].filter(Boolean).join(" · ");
          console.log(`    ${issue.code}${location ? ` [${location}]` : ""}: ${issue.message}`);
        }
      }
      console.log(`  Performance: ${(file.performance.durationMs / 1000).toFixed(2)}s, ${file.performance.rowsPerSecond.toLocaleString()} rows/s, ${formatBytes(file.performance.bytesRead)} read, ${formatBytes(file.performance.maxRssBytes)} peak RSS, ${file.performance.passes} pass(es)`);
    }
    if (files.length > 1) console.log(`${valid ? "PASS" : "FAIL"} ${files.length} CSV targets.`);
  }
  process.exitCode = valid ? 0 : 1;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "init") {
    if (args.csvs.length !== 1) usage();
    const csvPath = resolve(args.csvs[0]);
    await initialize(args, csvPath);
    return;
  }
  if (args.command === "test") {
    await testCsv(args);
    return;
  }
  usage();
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});

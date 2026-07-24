import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createContractFromCsv, parseContract, serializeContract, validateCsv } from "./core/contract";

interface ParsedArgs {
  command: string;
  csv?: string;
  specs: string[];
  out?: string;
  format: "text" | "json";
}

function usage(): never {
  console.error(`CSV Contract Workbench

Usage:
  csv-contract test --csv <file.csv> --spec <contract.csvtest.yaml> [--spec <spot-check.yaml>] [--format text|json]
  csv-contract init --csv <file.csv> --out <contract.csvtest.yaml>
`);
  process.exit(2);
}

function parseArgs(argv: string[]): ParsedArgs {
  const command = argv.shift();
  if (!command) usage();
  const result: ParsedArgs = { command, specs: [], format: "text" };
  while (argv.length) {
    const token = argv.shift();
    const value = argv.shift();
    if (!token || !value) usage();
    if (token === "--csv") result.csv = value;
    else if (token === "--spec") result.specs.push(value);
    else if (token === "--out") result.out = value;
    else if (token === "--format" && (value === "text" || value === "json")) result.format = value;
    else usage();
  }
  return result;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.csv) usage();
  const csvPath = resolve(args.csv);
  const csvText = await readFile(csvPath, "utf8");
  if (args.command === "init") {
    if (!args.out) usage();
    const output = resolve(args.out);
    await writeFile(output, serializeContract(createContractFromCsv(csvText)), "utf8");
    console.log(`Created ${output}`);
    return;
  }
  if (args.command !== "test" || args.specs.length === 0) usage();

  const runs = [];
  for (const specPathInput of args.specs) {
    const specPath = resolve(specPathInput);
    const contract = parseContract(await readFile(specPath, "utf8"));
    runs.push({ spec: specPath, result: validateCsv(contract, csvText) });
  }
  const valid = runs.every((run) => run.result.valid);
  if (args.format === "json") {
    console.log(JSON.stringify({ csv: csvPath, valid, runs }, null, 2));
  } else {
    for (const run of runs) {
      console.log(`${run.result.valid ? "PASS" : "FAIL"} ${run.spec} — ${run.result.rowCount} rows, ${run.result.columnCount} columns, ${run.result.issues.length} issues`);
      for (const issue of run.result.issues) {
        const location = [issue.column, issue.row ? `row ${issue.row}` : undefined, issue.testId].filter(Boolean).join(" · ");
        console.log(`  ${issue.code}${location ? ` [${location}]` : ""}: ${issue.message}`);
      }
    }
  }
  process.exitCode = valid ? 0 : 1;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});

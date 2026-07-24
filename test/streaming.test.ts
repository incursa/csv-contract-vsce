import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CsvContract } from "../src/core/model";
import { readCsvRecords } from "../src/node/csv-stream";
import { validateCsvFile } from "../src/node/streaming-validator";

async function withTempFile(content: string, action: (path: string, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "csv-contract-test-"));
  const path = join(directory, "input.csv");
  try {
    await writeFile(path, content, "utf8");
    await action(path, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function contract(): CsvContract {
  return {
    version: 1,
    schema: {
      allowAdditionalColumns: false,
      columns: {
        Id: { presence: "required", constraints: { notNull: true, unique: true, matches: "^\\d{3}$" } },
        Name: { presence: "required", constraints: { notNull: true, maxLength: 30 } },
        Status: { presence: "required", constraints: { allowedValues: ["Active", "Inactive"] } }
      }
    },
    rowTests: [{
      id: "expected-row",
      select: { Id: "001" },
      expect: { count: { exact: 1 }, cells: { Status: { equals: "Active" } } }
    }]
  };
}

test("stream parser handles BOM, escaped quotes, commas, CRLF, and multiline fields", async () => {
  await withTempFile("\uFEFFId,Name,Note\r\n001,\"Ada, Jr.\",\"Line 1\r\nLine 2\"\r\n002,\"Say \"\"Hi\"\"\",ok\r\n", async (path) => {
    const rows: string[][] = [];
    for await (const record of readCsvRecords(path, { delimiter: ",", quote: "\"", allowBlankRows: false })) rows.push(record.fields);
    assert.deepEqual(rows, [
      ["Id", "Name", "Note"],
      ["001", "Ada, Jr.", "Line 1\r\nLine 2"],
      ["002", "Say \"Hi\"", "ok"]
    ]);
  });
});

test("streaming validator applies multiple contracts in one pass", async () => {
  await withTempFile("Id,Name,Status\n001,Ada,Active\n002,Grace,Inactive\n", async (path, directory) => {
    const output = await validateCsvFile(path, [
      { spec: "general", contract: contract() },
      {
        spec: "spot",
        contract: {
          version: 1,
          schema: { columns: { Id: { presence: "required" }, Name: { presence: "required" }, Status: { presence: "required" } } },
          rowTests: [{ id: "grace", select: { Id: "002" }, expect: { cells: { Name: { equals: "Grace" } } } }]
        }
      }
    ], { progressInterval: 0, tempDirectory: directory, uniquePartitions: 8 });
    assert.equal(output.valid, true);
    assert.equal(output.performance.passes, 1);
    assert.deepEqual(output.runs.map((run) => run.result.rowCount), [2, 2]);
  });
});

test("disk-partitioned uniqueness catches duplicates without retaining all rows", async () => {
  await withTempFile("Id,Name,Status\n001,Ada,Active\n002,Grace,Inactive\n001,Ada Again,Active\n", async (path, directory) => {
    const output = await validateCsvFile(path, [{ spec: "general", contract: contract() }], {
      progressInterval: 0,
      tempDirectory: directory,
      uniquePartitions: 8
    });
    assert.equal(output.valid, false);
    assert.ok(output.runs[0].result.issues.some((issue) => issue.code === "NOT_UNIQUE"));
  });
});

test("uniqueness scan handles records larger than its read chunk", async () => {
  const largeValue = "x".repeat(1024 * 1024 + 100);
  await withTempFile(`Id\n${largeValue}\n${largeValue}\n`, async (path, directory) => {
    const output = await validateCsvFile(path, [{
      spec: "large-key",
      contract: {
        version: 1,
        schema: {
          columns: {
            Id: { presence: "required", constraints: { unique: true } }
          }
        }
      }
    }], {
      progressInterval: 0,
      tempDirectory: directory,
      uniquePartitions: 8
    });
    assert.equal(output.valid, false);
    assert.ok(output.runs[0].result.issues.some((issue) => issue.code === "NOT_UNIQUE"));
  });
});

test("issue output is bounded while the total issue count remains accurate", async () => {
  await withTempFile("Id,Name,Status\nBAD,,Pending\nBAD,,Pending\nBAD,,Pending\n", async (path, directory) => {
    const output = await validateCsvFile(path, [{ spec: "general", contract: contract() }], {
      maxIssues: 2,
      progressInterval: 0,
      tempDirectory: directory,
      uniquePartitions: 8
    });
    const result = output.runs[0].result;
    assert.equal(result.valid, false);
    assert.equal(result.issues.length, 2);
    assert.equal(result.truncated, true);
    assert.ok(result.issueCount > result.issues.length);
  });
});

test("empty and ragged CSVs produce explicit diagnostics", async () => {
  await withTempFile("", async (path) => {
    const output = await validateCsvFile(path, [{ spec: "general", contract: contract() }], { progressInterval: 0 });
    assert.ok(output.runs[0].result.issues.some((issue) => issue.code === "CSV_EMPTY"));
  });
  await withTempFile("Id,Name,Status\n001,Ada\n", async (path, directory) => {
    const output = await validateCsvFile(path, [{ spec: "general", contract: contract() }], {
      progressInterval: 0,
      tempDirectory: directory,
      uniquePartitions: 8
    });
    assert.ok(output.runs[0].result.issues.some((issue) => issue.code === "RAGGED_ROW"));
  });
});

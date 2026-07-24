import type { CsvContract, CsvOptions } from "../core/model";
import { readCsvRecords } from "./csv-stream";

export interface ContractOutlineOptions {
  sampleRows?: number;
  inferConstraints?: boolean;
  includeSampleTests?: boolean;
  delimiter?: string;
  quote?: string;
}

export interface ContractOutlineResult {
  contract: CsvContract;
  sampledRows: number;
}

interface ColumnSample {
  maxLength: number;
  nullCount: number;
  values: Set<string>;
}

export async function createContractOutlineFromFile(
  csvPath: string,
  options: ContractOutlineOptions = {}
): Promise<ContractOutlineResult> {
  const sampleRows = options.sampleRows ?? 10000;
  if (!Number.isInteger(sampleRows) || sampleRows < 1) throw new Error("sampleRows must be a positive integer.");
  const infer = options.inferConstraints ?? false;
  const includeSampleTests = options.includeSampleTests ?? true;
  const csv: CsvOptions = {
    delimiter: options.delimiter ?? ",",
    encoding: "utf-8",
    quote: options.quote ?? "\"",
    header: "required",
    nullValues: [""],
    trimValues: false,
    caseSensitive: true,
    allowBlankRows: false,
    allowRaggedRows: false
  };
  const maximumRecords = infer ? sampleRows + 1 : includeSampleTests ? 2 : 1;
  let headers: string[] | undefined;
  let firstRow: string[] | undefined;
  let sampled = 0;
  let samples: ColumnSample[] = [];
  for await (const record of readCsvRecords(csvPath, {
    delimiter: csv.delimiter!,
    quote: csv.quote!,
    allowBlankRows: false
  }, { maxRecords: maximumRecords })) {
    if (!headers) {
      headers = record.fields;
      if (headers.length === 0 || headers.some((header) => header.length === 0)) {
        throw new Error("The CSV header contains an empty column name.");
      }
      const duplicates = headers.filter((header, index) => headers!.indexOf(header) !== index);
      if (duplicates.length > 0) throw new Error(`The CSV header contains duplicate column names: ${[...new Set(duplicates)].join(", ")}.`);
      samples = headers.map(() => ({ maxLength: 0, nullCount: 0, values: new Set<string>() }));
      continue;
    }
    firstRow ??= record.fields;
    sampled += 1;
    if (infer) {
      headers.forEach((_, index) => {
        const value = record.fields[index] ?? "";
        const sample = samples[index];
        sample.maxLength = Math.max(sample.maxLength, value.length);
        if (value === "") sample.nullCount += 1;
        else sample.values.add(value);
      });
    }
  }
  if (!headers) throw new Error("Cannot create a contract from an empty CSV.");

  const columns = Object.fromEntries(headers.map((header, index) => {
    if (!infer) return [header, { presence: "required" as const }];
    const sample = samples[index];
    return [
      header,
      {
        presence: "required" as const,
        constraints: {
          notNull: sample.nullCount === 0,
          unique: sampled > 0 && sample.nullCount === 0 && sample.values.size === sampled,
          maxLength: sample.maxLength
        }
      }
    ];
  }));

  const rowTests: CsvContract["rowTests"] = [];
  if (includeSampleTests && firstRow) {
    const selectorIndexes = headers
      .map((_, index) => index)
      .filter((index) => (firstRow![index] ?? "") !== "")
      .slice(0, Math.min(2, headers.length));
    if (selectorIndexes.length > 0) {
      const select = Object.fromEntries(selectorIndexes.map((index) => [headers![index], firstRow![index] ?? ""]));
      rowTests.push({
        id: "sample-row-exists",
        name: "Sample row exists (replace or remove after review)",
        select,
        expect: { count: { min: 1 } }
      });
      // Reuse a selector cell so the generated template cannot fail its source
      // because another row shares the heuristic selector with a different value.
      const chosenCell = selectorIndexes[0];
      rowTests.push({
        id: "sample-cell-value",
        name: "Sample cell has expected value (replace or remove after review)",
        select,
        expect: {
          count: { min: 1 },
          cells: {
            [headers[chosenCell]]: { equals: firstRow[chosenCell] ?? "" }
          }
        }
      });
    }
  }

  return {
    sampledRows: sampled,
    contract: {
      version: 1,
      csv,
      schema: {
        allowAdditionalColumns: true,
        rowCount: { min: 1 },
        columnCount: { exact: headers.length },
        columns
      },
      rowTests
    }
  };
}

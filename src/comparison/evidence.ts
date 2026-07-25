import type { ComparisonResult } from "./model";

export interface EvidenceFile {
  name: string;
  content: string;
}

function csvField(value: string | number | boolean | null | undefined): string {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replaceAll("\"", "\"\"")}"`;
}

export function rowsToCsv(columns: string[], rows: Array<Array<string | null>>): string {
  const records = [columns.map(csvField).join(",")];
  rows.forEach((row) => records.push(row.map(csvField).join(",")));
  return `${records.join("\n")}\n`;
}

function recordCsv(columns: string[], rows: Array<Array<string | number | boolean | null>>): string {
  return [
    columns.map(csvField).join(","),
    ...rows.map((row) => row.map(csvField).join(","))
  ].join("\n") + "\n";
}

export function comparisonEvidenceCsv(result: ComparisonResult): string {
  const rows: Array<Array<string | number | boolean | null | undefined>> = [
    ["summary", "status", result.summary.status, result.summary.semanticEqual, result.summary.exitCode, ""],
    ["summary", "mode", result.summary.mode, "", "", ""],
    ["count", "leftRows", result.summary.left.rowCount, "", "", ""],
    ["count", "rightRows", result.summary.right.rowCount, "", "", ""],
    ["count", "added", result.summary.differences.added, "", "", ""],
    ["count", "removed", result.summary.differences.removed, "", "", ""],
    ["count", "changed", result.summary.differences.changed, "", "", ""],
    ["count", "unchanged", result.summary.differences.unchanged, "", "", ""],
    ["count", "changedCells", result.summary.differences.changedCells, "", "", ""],
    ["count", "schemaChanges", result.summary.differences.schemaChanges, "", "", ""],
    ["count", "duplicateKeysLeft", result.summary.differences.duplicateKeysLeft, "", "", ""],
    ["count", "duplicateKeysRight", result.summary.differences.duplicateKeysRight, "", "", ""]
  ];
  result.summary.diagnostics.items.forEach((diagnostic) => rows.push([
    "diagnostic",
    diagnostic.kind,
    diagnostic.count,
    diagnostic.column ?? "",
    diagnostic.keyReference ?? "",
    diagnostic.id
  ]));
  return [
    ["recordType", "name", "countOrValue", "column", "keyReference", "diagnosticId"].map(csvField).join(","),
    ...rows.map((row) => row.map(csvField).join(","))
  ].join("\n") + "\n";
}

export function comparisonMarkdown(result: ComparisonResult): string {
  const { summary } = result;
  const schemaLeft = summary.columns.columnsOnlyInLeft.join(", ") || "(none)";
  const schemaRight = summary.columns.columnsOnlyInRight.join(", ") || "(none)";
  const lines = [
    `# ${summary.name}`,
    "",
    `- Status: **${summary.status}**`,
    `- Mode: ${summary.mode}`,
    `- Semantically equal: ${summary.semanticEqual}`,
    `- Left rows: ${summary.left.rowCount}`,
    `- Right rows: ${summary.right.rowCount}`,
    `- Comparable columns: ${summary.columns.comparableColumns.length}`,
    "",
    "## Results",
    "",
    "| Added | Removed | Changed keys | Unchanged | Changed cells | Duplicate keys (left/right) |",
    "| ---: | ---: | ---: | ---: | ---: | ---: |",
    `| ${summary.differences.added} | ${summary.differences.removed} | ${summary.differences.changed} | ${summary.differences.unchanged} | ${summary.differences.changedCells} | ${summary.differences.duplicateKeysLeft}/${summary.differences.duplicateKeysRight} |`,
    "",
    "## Schema",
    "",
    `- Columns only in left: ${schemaLeft}`,
    `- Columns only in right: ${schemaRight}`,
    `- Shared columns reordered: ${summary.columns.reordered}`,
    "",
    "## Diagnostics",
    "",
    `Diagnostics are aggregate and redacted. Included ${summary.diagnostics.included} of ${summary.diagnostics.total}.`,
    result.details.detailsTruncated
      ? "Detailed review CSV rows are bounded because this comparison used desktop spill-to-disk mode; aggregate counts are complete."
      : "Detailed review CSV rows are complete."
  ];
  if (summary.diagnostics.items.length) {
    lines.push("", "| Kind | Count | Column | Reference |", "| --- | ---: | --- | --- |");
    summary.diagnostics.items.forEach((item) => lines.push(
      `| ${item.kind} | ${item.count} | ${item.column ?? ""} | ${item.keyReference ?? ""} |`
    ));
  }
  return `${lines.join("\n")}\n`;
}

export function createEvidenceFiles(result: ComparisonResult): EvidenceFile[] {
  const files = [
    { name: "ComparisonSummary.json", content: `${JSON.stringify(result.summary, null, 2)}\n` },
    { name: "ComparisonEvidence.csv", content: comparisonEvidenceCsv(result) },
    { name: "ComparisonSummary.md", content: comparisonMarkdown(result) }
  ];
  const columnRows = [
    ...result.summary.columns.leftColumns.map((column, index) => [
      result.summary.columns.rightColumns.includes(column) ? "Both" : "LeftOnly",
      column,
      index + 1,
      result.summary.columns.rightColumns.indexOf(column) >= 0 ? result.summary.columns.rightColumns.indexOf(column) + 1 : null,
      result.summary.columns.comparableColumns.includes(column),
      result.summary.options.ignoredColumns.includes(column)
    ]),
    ...result.summary.columns.rightColumns
      .filter((column) => !result.summary.columns.leftColumns.includes(column))
      .map((column) => [
        "RightOnly",
        column,
        null,
        result.summary.columns.rightColumns.indexOf(column) + 1,
        false,
        result.summary.options.ignoredColumns.includes(column)
      ])
  ] as Array<Array<string | number | boolean | null>>;
  files.push({
    name: "ColumnSummary.csv",
    content: recordCsv(["Status", "ColumnName", "LeftOrdinal", "RightOrdinal", "Comparable", "Ignored"], columnRows)
  });
  if (result.summary.mode === "full-row-multiset" && !result.details.normalizedRowsTruncated) {
    files.push(
      { name: "LeftOnly.csv", content: rowsToCsv(result.details.columns, result.details.leftOnlyRows) },
      { name: "RightOnly.csv", content: rowsToCsv(result.details.columns, result.details.rightOnlyRows) }
    );
  }
  if (result.summary.mode === "keyed") {
    const identity = [...result.summary.options.keyColumns, ...result.summary.options.contextColumns];
    files.push(
      {
        name: "KeysOnlyInLeft.csv",
        content: recordCsv([...identity, "OccurrenceCount"], result.details.keysOnlyInLeft.map((item) => [
          ...item.keyValues, ...item.contextValues, item.count
        ]))
      },
      {
        name: "KeysOnlyInRight.csv",
        content: recordCsv([...identity, "OccurrenceCount"], result.details.keysOnlyInRight.map((item) => [
          ...item.keyValues, ...item.contextValues, item.count
        ]))
      },
      {
        name: "ChangedRows.csv",
        content: recordCsv([...identity, "ChangedColumn", "LeftValue", "RightValue"], result.details.changedCells.map((item) => [
          ...item.keyValues, ...item.contextValues, item.column, item.leftValue, item.rightValue
        ]))
      },
      {
        name: "DuplicateKeysLeft.csv",
        content: recordCsv([...result.details.columns, "KeyOccurrence", "KeyCount"], result.details.duplicateKeysLeft.flatMap((group) =>
          group.rows.map((row, index) => [...row, index + 1, group.rows.length])
        ))
      },
      {
        name: "DuplicateKeysRight.csv",
        content: recordCsv([...result.details.columns, "KeyOccurrence", "KeyCount"], result.details.duplicateKeysRight.flatMap((group) =>
          group.rows.map((row, index) => [...row, index + 1, group.rows.length])
        ))
      },
      {
        name: "ColumnChangeSummary.csv",
        content: recordCsv(["ColumnName", "ChangedCellCount"], Object.entries(result.summary.differences.changedCellsByColumn).map(([column, count]) => [column, count]))
      }
    );
  }
  if (!result.details.normalizedRowsTruncated) {
    files.push(
      { name: "NormalizedLeft.csv", content: rowsToCsv(result.details.columns, result.details.normalizedLeftRows) },
      { name: "NormalizedRight.csv", content: rowsToCsv(result.details.columns, result.details.normalizedRightRows) }
    );
  }
  return files;
}

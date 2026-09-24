import { parseCsv } from "../core/contract";
import { compareCsvTexts } from "./engine";
import { rowsToCsv } from "./evidence";
import type { ComparisonOptions, ComparisonResult } from "./model";

export const definitionSchema = "incursa.data-comparison/v1";
export interface ComparisonSourceDefinition {
  kind: "CSV" | "Table" | "SELECT";
  path?: string;
  connection?: unknown;
  schema?: string;
  name?: string;
  query?: string;
}
export interface ColumnDefinition { left: string; right: string; key: boolean; include: boolean; conversion: string }
export interface ComparisonDefinition {
  schema: typeof definitionSchema;
  name: string;
  left: ComparisonSourceDefinition;
  right: ComparisonSourceDefinition;
  mappings: ColumnDefinition[];
  vscodeOptions?: ComparisonOptions | null;
}
export function parseDefinition(text: string): ComparisonDefinition {
  if (new TextEncoder().encode(text).length > 2 * 1024 * 1024) throw new Error("Comparison setup exceeds 2 MiB.");
  const value = JSON.parse(text.replace(/^\uFEFF/, "")) as ComparisonDefinition;
  if (!value || value.schema !== definitionSchema) throw new Error("Unsupported comparison setup version.");
  for (const field of Object.keys(value)) if (!["schema", "name", "left", "right", "mappings", "vscodeOptions"].includes(field)) throw new Error(`Unsupported comparison field: ${field}`);
  if (typeof value.name !== "string" || !Array.isArray(value.mappings) || value.mappings.length > 256) throw new Error("Invalid comparison setup.");
  for (const source of [value.left, value.right]) {
    if (!source || !["CSV", "Table", "SELECT"].includes(source.kind)) throw new Error("Invalid comparison source.");
    for (const field of Object.keys(source)) if (!["kind", "path", "connection", "schema", "name", "query"].includes(field)) throw new Error(`Unsupported source field: ${field}`);
    if (source.kind === "CSV" && typeof source.path !== "string") throw new Error("CSV source requires a path.");
  }
  const names = new Set<string>();
  for (const map of value.mappings) {
    if (!map || typeof map.left !== "string" || !map.left || typeof map.right !== "string" || typeof map.key !== "boolean" || typeof map.include !== "boolean" || typeof map.conversion !== "string") throw new Error("Invalid column mapping.");
    for (const field of Object.keys(map)) if (!["left", "right", "key", "include", "conversion"].includes(field)) throw new Error(`Unsupported mapping field: ${field}`);
    if (names.has(map.left)) throw new Error("Duplicate left column mapping."); names.add(map.left);
  }
  return value;
}

export function definitionFromResult(leftPath: string, rightPath: string, result: ComparisonResult): ComparisonDefinition {
  const options = result.summary.options;
  const n = options.normalization;
  const legacy = !options.keyColumns.length || options.contextColumns.length > 0 || n.caseFold || n.blankNullEquivalent || n.dateColumns.length > 0 || n.decimalColumns.length > 0
    || result.summary.columns.columnsOnlyInLeft.length > 0 || result.summary.columns.columnsOnlyInRight.length > 0;
  return {
    schema: definitionSchema, name: result.summary.name,
    left: { kind: "CSV", path: leftPath }, right: { kind: "CSV", path: rightPath },
    mappings: result.summary.columns.leftColumns.map(column => ({ left: column, right: column, key: options.keyColumns.includes(column), include: !options.ignoredColumns.includes(column), conversion: n.trim ? "Trim text" : "Exact" })),
    ...(legacy ? { vscodeOptions: options } : {})
  };
}

const portableModes = new Set(["Exact", "Text", "Trim text", "Decimal", "Date", "Date/time", "Boolean", "GUID", "Binary"]);
export function validatePortableExecution(value: ComparisonDefinition): void {
  if (value.left.kind !== "CSV" || value.right.kind !== "CSV") throw new Error("This setup contains SQL sources. Run it in SSMS; VS Code's pairwise comparer currently accepts CSV files only.");
  if (value.vscodeOptions) return;
  const included = value.mappings.filter(m => m.include || m.key);
  if (!included.some(m => m.key)) throw new Error("Choose at least one key column in SSMS before running this setup.");
  if (new Set(included.map(m => m.right)).size !== included.length) throw new Error("Map each right column at most once.");
  for (const m of included) if (!portableModes.has(m.conversion)) throw new Error(`Conversion '${m.conversion}' is not supported by the portable CSV runner. Run this setup in SSMS; no conversion was changed.`);
}

function convert(value: string, mode: string): string {
  if (mode === "Exact" || mode === "Text") return value;
  const text = value.trim();
  if (mode === "Trim text") return text;
  if (mode === "Decimal") {
    const match = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(text);
    if (!match) throw new Error("Invalid decimal.");
    const whole = match[2].replace(/^0+/, "") || "0";
    const fraction = (match[3] ?? "").replace(/0+$/, "");
    if ((whole === "0" ? 0 : whole.length) + (match[3]?.length ?? 0) > 38) throw new Error("Decimal exceeds SQL precision.");
    return `${match[1] === "-" && (whole !== "0" || fraction) ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
  }
  if (mode === "Boolean") { if (/^(true|1)$/i.test(text)) return "1"; if (/^(false|0)$/i.test(text)) return "0"; throw new Error("Invalid Boolean."); }
  if (mode === "GUID") { const guid = text.replace(/^\{(.*)\}$/, "$1").toLowerCase(); if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/.test(guid)) throw new Error("Invalid GUID."); return guid; }
  if (mode === "Binary") { if (!/^0x(?:[\da-f]{2})*$/i.test(text)) throw new Error("Invalid binary."); return "0x" + text.slice(2).toUpperCase(); }
  const match = /^(?:(\d{4})-(\d{2})-(\d{2})|(\d{1,2})\/(\d{1,2})\/(\d{4})|(?<compactYear>\d{4})(?<compactMonth>\d{2})(?<compactDay>\d{2}))(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,7}))?)?(?: (AM|PM))?)?$/i.exec(text);
  if (!match) throw new Error("Use ISO dates or M/d/yyyy.");
  const year = Number(match[1] ?? match[6] ?? match.groups?.compactYear), month = Number(match[2] ?? match[4] ?? match.groups?.compactMonth), day = Number(match[3] ?? match[5] ?? match.groups?.compactDay);
  // Named captures also occupy indices 7..9.
  let hour = Number(match[10] ?? 0); const minute = Number(match[11] ?? 0), second = Number(match[12] ?? 0), fraction = (match[13] ?? "").padEnd(7, "0");
  if (match[14]) { if (hour < 1 || hour > 12) throw new Error("Invalid hour."); hour = hour % 12 + (match[14].toUpperCase() === "PM" ? 12 : 0); }
  const date = new Date(0); date.setUTCFullYear(year, month - 1, day);
  if (year < 1 || year > 9999 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) throw new Error("Invalid date.");
  if (mode === "Date" && (hour || minute || second || Number(fraction))) throw new Error("Date conversion would discard time.");
  const pad = (number: number, size = 2) => String(number).padStart(size, "0");
  const dayText = `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
  return mode === "Date" ? dayText : `${dayText}T${pad(hour)}:${pad(minute)}:${pad(second)}.${fraction}`;
}

export function compareDefinition(value: ComparisonDefinition, leftText: string, rightText: string): ComparisonResult {
  validatePortableExecution(value);
  if (value.vscodeOptions) return compareCsvTexts(leftText, rightText, { ...value.vscodeOptions, name: value.name });
  const maps = value.mappings.filter(m => m.include || m.key);
  const project = (text: string, side: "left" | "right") => {
    const csv = parseCsv(text.replace(/(?:\r\n|\r|\n)$/, ""), { allowBlankRows: true });
    if (csv.parseErrors.length) throw new Error(`${side} CSV could not be parsed.`);
    if (csv.rows.length > 250_000 || new Set(csv.headers).size !== csv.headers.length) throw new Error("CSV exceeds 250,000 rows or contains duplicate headers.");
    const positions = maps.map(m => { const i = csv.headers.indexOf(m[side]); if (i < 0) throw new Error(`Missing ${side} column: ${m[side]}`); return i; });
    const keys = new Set<string>();
    const rows = csv.rows.map((row, number) => {
      if (row.length !== csv.headers.length) throw new Error(`${side} row ${number + 1} has an invalid width.`);
      const values = maps.map((m, i) => {
        try { return convert(row[positions[i]], m.conversion); }
        catch { throw new Error(`${side} row ${number + 1}, column '${m[side]}': ${m.conversion} conversion failed. Values have not been logged.`); }
      });
      const key = JSON.stringify(values.filter((_, i) => maps[i].key));
      if (keys.has(key)) throw new Error(`${side} has duplicate keys after conversion. Comparison is blocked.`); keys.add(key);
      return values;
    });
    return rowsToCsv(maps.map(m => m.left), rows);
  };
  return compareCsvTexts(project(leftText, "left"), project(rightText, "right"), { name: value.name, keyColumns: maps.filter(m => m.key).map(m => m.left) }, true);
}

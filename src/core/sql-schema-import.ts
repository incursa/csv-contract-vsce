import type {
  CsvContract,
  SqlServerImportedColumn,
  SqlServerImportedSchema
} from "./model";

export interface ImportedSqlTable {
  schema: string;
  table: string;
  sourceKind: SqlServerImportedSchema["sourceKind"];
  columns: SqlServerImportedColumn[];
  primaryKeyColumns: string[];
}

export interface SchemaMergePreview {
  addedColumns: string[];
  existingColumns: string[];
  contractOnlyColumns: string[];
  inferredConstraints: string[];
  preservedConflicts: string[];
  targetChanged: boolean;
  identityInitialized: boolean;
}

export interface SchemaMergeResult {
  contract: CsvContract;
  preview: SchemaMergePreview;
}

function unquoteIdentifier(value: string): string {
  const text = value.trim();
  if (text.startsWith("[") && text.endsWith("]")) return text.slice(1, -1).replace(/]]/g, "]");
  if (text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1).replace(/""/g, '"');
  return text;
}

function readIdentifier(text: string, start = 0): { value: string; end: number } {
  let index = start;
  while (/\s/.test(text[index] ?? "")) index += 1;
  if (text[index] === "[") {
    let value = "";
    index += 1;
    while (index < text.length) {
      if (text[index] === "]" && text[index + 1] === "]") { value += "]"; index += 2; continue; }
      if (text[index] === "]") return { value, end: index + 1 };
      value += text[index];
      index += 1;
    }
    throw new Error("Unterminated bracketed SQL identifier.");
  }
  if (text[index] === '"') {
    let value = "";
    index += 1;
    while (index < text.length) {
      if (text[index] === '"' && text[index + 1] === '"') { value += '"'; index += 2; continue; }
      if (text[index] === '"') return { value, end: index + 1 };
      value += text[index];
      index += 1;
    }
    throw new Error("Unterminated quoted SQL identifier.");
  }
  const match = /^[A-Za-z_@#][A-Za-z0-9_@$#]*/.exec(text.slice(index));
  if (!match) throw new Error(`Expected a SQL identifier near '${text.slice(index, index + 30)}'.`);
  return { value: match[0], end: index + match[0].length };
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let bracket = false;
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (bracket) {
      if (character === "]" && text[index + 1] === "]") index += 1;
      else if (character === "]") bracket = false;
      continue;
    }
    if (quote) {
      if (character === quote && text[index + 1] === quote) index += 1;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "[") bracket = true;
    else if (character === "'" || character === '"') quote = character;
    else if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    else if (character === "," && depth === 0) { parts.push(text.slice(start, index).trim()); start = index + 1; }
  }
  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}

function findMatchingParenthesis(text: string, opening: number): number {
  let depth = 0;
  let bracket = false;
  let quote: "'" | '"' | undefined;
  for (let index = opening; index < text.length; index += 1) {
    const character = text[index];
    if (bracket) {
      if (character === "]" && text[index + 1] === "]") index += 1;
      else if (character === "]") bracket = false;
      continue;
    }
    if (quote) {
      if (character === quote && text[index + 1] === quote) index += 1;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "[") bracket = true;
    else if (character === "'" || character === '"') quote = character;
    else if (character === "(") depth += 1;
    else if (character === ")" && --depth === 0) return index;
  }
  throw new Error("The CREATE TABLE column list is not balanced.");
}

function typeMetadata(typeText: string): Pick<SqlServerImportedColumn, "sqlType" | "maxLength" | "precision" | "scale"> {
  const normalized = typeText.replace(/\s+/g, "").toLowerCase();
  const base = normalized.replace(/^.*\./, "").replace(/\(.*/, "");
  const args = /\(([^)]+)\)/.exec(normalized)?.[1].split(",").map((value) => value.trim());
  const result: Pick<SqlServerImportedColumn, "sqlType" | "maxLength" | "precision" | "scale"> = { sqlType: normalized };
  if (["varchar", "char", "varbinary", "binary"].includes(base) && args?.[0]) result.maxLength = args[0] === "max" ? -1 : Number(args[0]);
  if (["nvarchar", "nchar"].includes(base) && args?.[0]) result.maxLength = args[0] === "max" ? -1 : Number(args[0]);
  if (["decimal", "numeric"].includes(base) && args?.length === 2) {
    result.precision = Number(args[0]);
    result.scale = Number(args[1]);
  } else if (["datetime2", "datetimeoffset", "time"].includes(base) && args?.[0]) {
    result.scale = Number(args[0]);
  }
  return result;
}

function parseQualifiedName(text: string, start: number): { schema: string; table: string; end: number } {
  const first = readIdentifier(text, start);
  let index = first.end;
  while (/\s/.test(text[index] ?? "")) index += 1;
  if (text[index] !== ".") return { schema: "dbo", table: first.value, end: index };
  const second = readIdentifier(text, index + 1);
  return { schema: first.value, table: second.value, end: second.end };
}

function parsePrimaryKeyColumns(clause: string): string[] {
  if (!/\bPRIMARY\s+KEY\b/i.test(clause)) return [];
  const open = clause.indexOf("(");
  if (open < 0) return [];
  const close = findMatchingParenthesis(clause, open);
  return splitTopLevel(clause.slice(open + 1, close)).map((part) => readIdentifier(part).value);
}

export function parseCreateTable(text: string): ImportedSqlTable[] {
  const results: ImportedSqlTable[] = [];
  const expression = /\bCREATE\s+TABLE\s+/gi;
  for (let match = expression.exec(text); match; match = expression.exec(text)) {
    const name = parseQualifiedName(text, expression.lastIndex);
    let open = name.end;
    while (/\s/.test(text[open] ?? "")) open += 1;
    if (text[open] !== "(") throw new Error(`CREATE TABLE ${name.schema}.${name.table} does not have a column list.`);
    const close = findMatchingParenthesis(text, open);
    const clauses = splitTopLevel(text.slice(open + 1, close));
    const columns: SqlServerImportedColumn[] = [];
    const primaryKeyColumns: string[] = [];
    for (const clause of clauses) {
      if (/^(?:CONSTRAINT\b|PRIMARY\s+KEY\b|UNIQUE\b|FOREIGN\s+KEY\b|CHECK\b|INDEX\b|PERIOD\b)/i.test(clause)) {
        primaryKeyColumns.push(...parsePrimaryKeyColumns(clause));
        continue;
      }
      const columnName = readIdentifier(clause);
      const remainder = clause.slice(columnName.end).trim();
      if (/^AS\b/i.test(remainder)) {
        columns.push({ ordinal: columns.length + 1, name: columnName.value, sqlType: "computed", nullable: true, computed: true });
        continue;
      }
      const typeMatch = /^(?:(?:\[[^\]]+(?:\]\][^\]]*)*\]|"(?:""|[^"])+"|[A-Za-z_][A-Za-z0-9_]*)\s*\.\s*)?(?:\[[^\]]+(?:\]\][^\]]*)*\]|"(?:""|[^"])+"|[A-Za-z_][A-Za-z0-9_]*)(?:\s*\([^)]*\))?/.exec(remainder);
      if (!typeMatch) throw new Error(`Could not infer the SQL type for column '${columnName.value}'.`);
      const type = typeMetadata(typeMatch[0].split(".").map(unquoteIdentifier).join("."));
      const options = remainder.slice(typeMatch[0].length);
      const inlinePrimaryKey = /\bPRIMARY\s+KEY\b/i.test(options);
      if (inlinePrimaryKey) primaryKeyColumns.push(columnName.value);
      columns.push({
        ordinal: columns.length + 1,
        name: columnName.value,
        ...type,
        nullable: !/\bNOT\s+NULL\b/i.test(options),
        identity: /\bIDENTITY\s*(?:\([^)]*\))?/i.test(options) || undefined
      });
    }
    if (columns.length === 0) throw new Error(`CREATE TABLE ${name.schema}.${name.table} contains no importable columns.`);
    results.push({ schema: name.schema, table: name.table, sourceKind: "create-table", columns, primaryKeyColumns: [...new Set(primaryKeyColumns)] });
    expression.lastIndex = close + 1;
  }
  if (results.length === 0) throw new Error("No CREATE TABLE statements were found.");
  return results;
}

interface TrackingColumn {
  ordinal: number; name: string; typeSchema?: string; typeName: string; maxLength?: number;
  precision?: number; scale?: number; nullable: boolean; identitySeed?: string | null; computedExpression?: string | null;
}

function fromTracking(value: any): ImportedSqlTable {
  if (!value || typeof value.schema !== "string" || typeof value.name !== "string" || !Array.isArray(value.columns)) {
    throw new Error("The Database Tracking table model is invalid.");
  }
  const columns = (value.columns as TrackingColumn[]).map((column) => {
    const base = String(column.typeName).toLowerCase();
    const byteLength = Number(column.maxLength ?? 0);
    const maxLength = ["nvarchar", "nchar"].includes(base) && byteLength > 0 ? byteLength / 2 : byteLength || undefined;
    const args = ["varchar", "nvarchar", "char", "nchar", "binary", "varbinary"].includes(base)
      ? `(${byteLength < 0 ? "max" : maxLength})`
      : ["decimal", "numeric"].includes(base) ? `(${column.precision},${column.scale})`
        : ["datetime2", "datetimeoffset", "time"].includes(base) ? `(${column.scale})` : "";
    return {
      ordinal: Number(column.ordinal), name: String(column.name),
      sqlType: `${column.typeSchema && column.typeSchema !== "sys" ? `${column.typeSchema}.` : ""}${base}${args}`,
      nullable: Boolean(column.nullable), identity: column.identitySeed != null || undefined,
      computed: column.computedExpression != null || undefined,
      maxLength, precision: column.precision, scale: column.scale
    } satisfies SqlServerImportedColumn;
  });
  const indexes = Array.isArray(value.indexes) ? value.indexes : [];
  const primary = indexes.find((index: any) => index.primaryKey === true);
  const primaryKeyColumns = primary?.columns?.filter((column: any) => !column.included).sort((left: any, right: any) => left.keyOrdinal - right.keyOrdinal).map((column: any) => String(column.name)) ?? [];
  return { schema: value.schema, table: value.name, sourceKind: "database-tracking", columns, primaryKeyColumns };
}

function fromKnowledgeObject(value: any): ImportedSqlTable {
  const columns = value.columns.map((column: any) => {
    const base = String(column.dataType).toLowerCase();
    const rawLength = Number(column.length ?? 0);
    const maxLength = ["nvarchar", "nchar"].includes(base) && rawLength > 0 ? rawLength / 2 : rawLength || undefined;
    const args = ["varchar", "nvarchar", "char", "nchar", "binary", "varbinary"].includes(base)
      ? `(${rawLength < 0 ? "max" : maxLength})`
      : ["decimal", "numeric"].includes(base) ? `(${column.precision},${column.scale})`
        : ["datetime2", "datetimeoffset", "time"].includes(base) ? `(${column.scale})` : "";
    return { ordinal: Number(column.ordinal), name: String(column.name), sqlType: `${base}${args}`, nullable: Boolean(column.nullable), identity: column.identity || undefined, computed: column.computed || undefined, maxLength, precision: column.precision, scale: column.scale } satisfies SqlServerImportedColumn;
  });
  const primaryKeyColumns = value.primaryKeys?.[0]?.columns?.map((column: any) => String(column.name)) ?? [];
  return { schema: String(value.schema), table: String(value.name), sourceKind: "database-knowledge", columns, primaryKeyColumns };
}

export function parseSqlSchemaSource(text: string, extension = ""): ImportedSqlTable[] {
  if (extension.toLowerCase() === ".sql" || /^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*CREATE\s+TABLE\b/i.test(text)) return parseCreateTable(text);
  let value: any;
  try { value = JSON.parse(text); } catch { throw new Error("Schema source must be a CREATE TABLE script or supported JSON schema artifact."); }
  if (Array.isArray(value?.objects)) {
    const tables = value.objects.filter((item: any) => String(item.type).toLowerCase() === "table" && Array.isArray(item.columns)).map(fromKnowledgeObject);
    if (!tables.length) throw new Error("The Database Knowledge snapshot contains no table objects.");
    return tables;
  }
  return [fromTracking(value)];
}

function inferredMaxLength(column: SqlServerImportedColumn): number | undefined {
  if (column.maxLength === undefined || column.maxLength < 0) return undefined;
  const base = column.sqlType.replace(/^.*\./, "").replace(/\(.*/, "").toLowerCase();
  return ["varchar", "nvarchar", "char", "nchar"].includes(base) ? column.maxLength : undefined;
}

export function mergeImportedSchema(contract: CsvContract, table: ImportedSqlTable): SchemaMergeResult {
  const output = JSON.parse(JSON.stringify(contract)) as CsvContract;
  const existingNames = Object.keys(output.schema.columns);
  const sourceNames = new Set(table.columns.map((column) => column.name));
  const preview: SchemaMergePreview = {
    addedColumns: [], existingColumns: [], contractOnlyColumns: existingNames.filter((name) => !sourceNames.has(name)),
    inferredConstraints: [], preservedConflicts: [],
    targetChanged: output.sqlServer?.schema !== table.schema || output.sqlServer?.table !== table.table,
    identityInitialized: false
  };
  for (const column of [...table.columns].sort((left, right) => left.ordinal - right.ordinal)) {
    let definition = output.schema.columns[column.name];
    if (!definition) {
      definition = { presence: column.identity || column.computed ? "optional" : "required", constraints: {} };
      output.schema.columns[column.name] = definition;
      preview.addedColumns.push(column.name);
    } else preview.existingColumns.push(column.name);
    definition.constraints ??= {};
    const expectedNotNull = !column.nullable;
    if (!column.identity && !column.computed && definition.constraints.notNull === undefined && expectedNotNull) {
      definition.constraints.notNull = true;
      preview.inferredConstraints.push(`${column.name}.notNull`);
    } else if (!column.identity && !column.computed && definition.constraints.notNull !== undefined && definition.constraints.notNull !== expectedNotNull) {
      preview.preservedConflicts.push(`${column.name}.notNull`);
    }
    const maxLength = inferredMaxLength(column);
    if (definition.constraints.maxLength === undefined && maxLength !== undefined) {
      definition.constraints.maxLength = maxLength;
      preview.inferredConstraints.push(`${column.name}.maxLength`);
    } else if (maxLength !== undefined && definition.constraints.maxLength !== undefined && definition.constraints.maxLength !== maxLength) {
      preview.preservedConflicts.push(`${column.name}.maxLength`);
    }
    if (Object.keys(definition.constraints).length === 0) delete definition.constraints;
  }
  output.schema.columns = Object.fromEntries([
    ...[...table.columns].sort((left, right) => left.ordinal - right.ordinal).map((column) => [column.name, output.schema.columns[column.name]]),
    ...preview.contractOnlyColumns.map((name) => [name, output.schema.columns[name]])
  ]);
  const previous = output.sqlServer;
  output.sqlServer = {
    ...(previous ?? {}), schema: table.schema, table: table.table,
    importedSchema: { formatVersion: 1, sourceKind: table.sourceKind, columns: [...table.columns].sort((left, right) => left.ordinal - right.ordinal) }
  };
  const keyColumns = table.primaryKeyColumns.map((name) => table.columns.find((column) => column.name === name));
  if (!output.identity && keyColumns.length && keyColumns.every((column) => column && !column.identity && !column.computed)) {
    output.identity = { columns: table.primaryKeyColumns, unique: true };
    preview.identityInitialized = true;
  }
  return { contract: output, preview };
}

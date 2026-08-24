import type { CsvContract, SqlServerScope, SqlServerTableTarget } from "./model";

export interface ResolvedSqlServerTarget {
  name?: string;
  connection: string;
  schema: string;
  table: string;
  objectType?: "table" | "view";
  columnMap?: Record<string, string>;
  scope?: SqlServerScope;
}

export function sqlServerTargetLabel(target: ResolvedSqlServerTarget): string {
  return target.name ?? `${target.connection}:${target.schema}.${target.table}`;
}

export function resolveSqlServerTargets(contract: CsvContract, requireConnection = true): ResolvedSqlServerTarget[] {
  const sqlServer = contract.sqlServer;
  if (!sqlServer) return [];
  const candidates: SqlServerTableTarget[] = sqlServer.targets?.length
    ? sqlServer.targets
    : sqlServer.schema && sqlServer.table
      ? [{
          connection: sqlServer.connection ?? "",
          schema: sqlServer.schema,
          table: sqlServer.table,
          objectType: sqlServer.objectType,
          columnMap: sqlServer.columnMap,
          scope: sqlServer.scope
        }]
      : [];
  if (candidates.length === 0) {
    throw new Error("sqlServer must declare schema and table, or at least one targets entry.");
  }
  return candidates.map((target, index) => {
    if (!target.schema?.trim() || !target.table?.trim()) {
      throw new Error(`SQL Server target ${index + 1} must declare non-empty schema and table names.`);
    }
    if (requireConnection && !target.connection?.trim()) {
      throw new Error(`SQL Server target ${target.schema}.${target.table} must declare a connection profile.`);
    }
    const columnMap = target.columnMap ?? {};
    const undeclaredMappings = Object.keys(columnMap).filter((column) => !contract.schema.columns[column]);
    if (undeclaredMappings.length) {
      throw new Error(`SQL Server target ${target.schema}.${target.table} maps undeclared contract columns: ${undeclaredMappings.join(", ")}.`);
    }
    const blankMappings = Object.entries(columnMap).filter(([, physical]) => !physical.trim()).map(([column]) => column);
    if (blankMappings.length) throw new Error(`SQL Server target ${target.schema}.${target.table} has blank mappings for: ${blankMappings.join(", ")}.`);
    const physicalNames = Object.values(columnMap).map((value) => value.trim().toLowerCase());
    const duplicatePhysical = physicalNames.filter((value, position) => physicalNames.indexOf(value) !== position);
    if (duplicatePhysical.length) throw new Error(`SQL Server target ${target.schema}.${target.table} maps more than one contract column to the same physical column.`);
    return {
      name: target.name,
      connection: target.connection?.trim() ?? "",
      schema: target.schema.trim(),
      table: target.table.trim(),
      objectType: target.objectType,
      columnMap: Object.keys(columnMap).length ? Object.fromEntries(Object.entries(columnMap).map(([column, physical]) => [column, physical.trim()])) : undefined,
      scope: target.scope ?? sqlServer.scope
    };
  });
}

export function physicalSqlServerColumn(target: ResolvedSqlServerTarget, contractColumn: string): string {
  return target.columnMap?.[contractColumn] ?? contractColumn;
}

export function canonicalSqlServerColumn(target: ResolvedSqlServerTarget, physicalColumn: string): string {
  return Object.entries(target.columnMap ?? {}).find(([, physical]) => physical === physicalColumn)?.[0] ?? physicalColumn;
}

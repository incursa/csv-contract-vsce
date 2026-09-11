import type { CsvContract, SqlServerIntegratedConnection, SqlServerScope, SqlServerTableTarget } from "./model";

export interface ResolvedSqlServerTarget {
  baseline?: import("./baseline").BaselineBinding;
  name?: string;
  connection: string;
  integratedConnection?: SqlServerIntegratedConnection;
  schema: string;
  table: string;
  objectType?: "table" | "view";
  columnMap?: Record<string, string>;
  scope?: SqlServerScope;
}

export function hasSqlServerConnection(target: ResolvedSqlServerTarget): boolean {
  return Boolean(target.connection || target.integratedConnection);
}

export function sqlServerConnectionLabel(target: ResolvedSqlServerTarget): string {
  const integrated = target.integratedConnection;
  return integrated ? `${integrated.server}/${integrated.database} (Windows)` : target.connection || "unconfigured";
}

export function sqlServerConnectionKey(target: ResolvedSqlServerTarget): string {
  return target.integratedConnection
    ? `integrated:${JSON.stringify(target.integratedConnection)}`
    : `profile:${target.connection}`;
}

export function sqlServerTargetLabel(target: ResolvedSqlServerTarget): string {
  return target.name ?? `${sqlServerConnectionLabel(target)}:${target.schema}.${target.table}`;
}

export function resolveSqlServerTargets(contract: CsvContract, requireConnection = true): ResolvedSqlServerTarget[] {
  const sqlServer = contract.sqlServer;
  if (!sqlServer) return [];
  const candidates: SqlServerTableTarget[] = sqlServer.targets?.length
    ? sqlServer.targets
    : sqlServer.schema && sqlServer.table
      ? [{
          connection: sqlServer.connection ?? "",
          integratedConnection: sqlServer.integratedConnection,
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
    const connection = target.connection?.trim() ?? "";
    const integrated = target.integratedConnection;
    if (connection && integrated) {
      throw new Error(`SQL Server target ${target.schema}.${target.table} cannot declare both connection and integratedConnection.`);
    }
    if (integrated && (!integrated.server?.trim() || !integrated.database?.trim())) {
      throw new Error(`SQL Server target ${target.schema}.${target.table} must declare non-empty integratedConnection.server and integratedConnection.database values.`);
    }
    if (requireConnection && !connection && !integrated) {
      throw new Error(`SQL Server target ${target.schema}.${target.table} must declare a connection profile or integratedConnection.`);
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
      baseline: target.baseline,
      name: target.name,
      connection,
      integratedConnection: integrated ? {
        server: integrated.server.trim(),
        database: integrated.database.trim(),
        ...(integrated.odbcDriver?.trim() ? { odbcDriver: integrated.odbcDriver.trim() } : {}),
        ...(integrated.encrypt !== undefined ? { encrypt: integrated.encrypt } : {}),
        ...(integrated.trustServerCertificate !== undefined ? { trustServerCertificate: integrated.trustServerCertificate } : {})
      } : undefined,
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

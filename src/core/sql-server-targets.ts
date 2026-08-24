import type { CsvContract, SqlServerScope, SqlServerTableTarget } from "./model";

export interface ResolvedSqlServerTarget {
  name?: string;
  connection: string;
  schema: string;
  table: string;
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
    return {
      name: target.name,
      connection: target.connection?.trim() ?? "",
      schema: target.schema.trim(),
      table: target.table.trim(),
      scope: target.scope ?? sqlServer.scope
    };
  });
}

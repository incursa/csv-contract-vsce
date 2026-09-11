import type { CsvContract } from "./model";
import type { SchemaBaseline } from "./baseline";
import { errorDetails } from "./error-details";
import { resolveSqlServerTargets, sqlServerTargetLabel, type ResolvedSqlServerTarget } from "./sql-server-targets";

/** Explicit metadata-only execution, shared by both editors. Errors never imply absence. */
export async function preflight(contract: CsvContract, capture: (target: ResolvedSqlServerTarget) => Promise<SchemaBaseline>) {
  const checks: { target: string; status: "PASS" | "FAIL" | "ERROR"; message: string }[] = [];
  for (const target of resolveSqlServerTargets(contract)) {
    try {
      const metadata = await capture(target);
      const missing = Object.entries(contract.schema.columns).filter(([name, c]) => c.presence === "required" && !metadata.columns.some(col => col.name === (target.columnMap?.[name] ?? name))).map(([name]) => name);
      checks.push({ target: sqlServerTargetLabel(target), status: missing.length ? "FAIL" : "PASS", message: missing.length ? `Missing required columns: ${missing.join(", ")}` : "Driver, authentication, database and metadata access succeeded; required columns present. Data rules have not executed." });
    } catch (error) { checks.push({ target: sqlServerTargetLabel(target), status: "ERROR", message: errorDetails(error) }); }
  }
  return checks;
}

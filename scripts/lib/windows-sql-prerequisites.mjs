/* global process */
import { spawnSync } from "node:child_process";

/** Read-only discovery. Missing optional SQL components never blocks CSV or profile-based validation. */
export function inspectWindowsSqlPrerequisites() {
  if (process.platform !== "win32") return { odbc18: false, note: "Windows ODBC discovery is unavailable on this platform." };
  const command = "@(Get-OdbcDriver -Name 'ODBC Driver 18 for SQL Server' -ErrorAction SilentlyContinue).Count";
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8", windowsHide: true, timeout: 30_000
  });
  if (result.error || result.status !== 0) return { odbc18: false, note: "ODBC Driver 18 discovery was unavailable; integrated-auth acceptance remains pending." };
  return Number(result.stdout.trim()) > 0
    ? { odbc18: true, note: "ODBC Driver 18 for SQL Server is installed." }
    : { odbc18: false, note: "ODBC Driver 18 for SQL Server was not found; CSV and JavaScript profile connections remain available." };
}

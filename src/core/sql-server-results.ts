/** Missing, duplicate or malformed result rows are execution errors, never passing assertions. */
export function assertCompleteSqlSummaries(expectedIds: string[], rows: { RuleId: string; FailureCount: number | string }[]): void {
  const expected = new Map<string, number>();
  for (const id of expectedIds) expected.set(id, (expected.get(id) ?? 0) + 1);
  for (const row of rows) {
    const count = expected.get(row.RuleId) ?? 0;
    if (!count || !["number", "string"].includes(typeof row.FailureCount) || String(row.FailureCount).trim() === "" || !Number.isSafeInteger(Number(row.FailureCount)) || Number(row.FailureCount) < 0) {
      throw new Error(`Invalid or unexpected SQL validation summary for rule '${row.RuleId}'.`);
    }
    expected.set(row.RuleId, count - 1);
  }
  const missing = [...expected].filter(([, count]) => count > 0).map(([id]) => id);
  if (missing.length) throw new Error(`SQL validation did not return expected rule summaries: ${missing.join(", ")}.`);
}

import type { BadRowsOptions, BadRowsRun, WorkbookCheck } from "./bad-rows-xlsx";
import { redactIssueExportRuns } from "./core/evidence-redaction";
import type { IssueExportRun } from "./issue-export";

export type WorkbookEvidenceMode = "aggregate-only" | "detail";

export interface PreparedWorkbookExport {
  runs: BadRowsRun[];
  options: BadRowsOptions;
}

function genericDescription(check: WorkbookCheck): string {
  const category = check.category.trim() || "Validation";
  return `${category} check configured in the validation definition. Review the definition for protected or literal criteria.`;
}

/**
 * Apply the evidence policy to both result data and presentation metadata.
 * Aggregate mode must not reintroduce literals through a contract-derived catalog.
 */
export function prepareWorkbookExport(
  runs: Array<IssueExportRun & Partial<BadRowsRun>>,
  options: BadRowsOptions,
  mode: WorkbookEvidenceMode
): PreparedWorkbookExport {
  const redacted = redactIssueExportRuns(runs, { mode }).runs;
  const safeRuns: BadRowsRun[] = redacted.map((run, index) => ({ ...run,
    ...(runs[index].suite ? { suite: runs[index].suite } : {}),
    ...(runs[index].member ? { member: runs[index].member } : {}),
    ...(runs[index].table ? { table: runs[index].table } : {}),
    ...(mode === "detail" && runs[index].source ? { source: runs[index].source } : {})
  }));
  if (mode === "detail" || !options.checkCatalog) return { runs: safeRuns, options };
  const originalCatalog = options.checkCatalog;
  return { runs: safeRuns, options: { ...options,
    checkCatalog: (run, index) => originalCatalog(run, index).map(check => ({ ...check, description: genericDescription(check) }))
  } };
}

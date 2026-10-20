import * as vscode from "vscode";
import { badRowsXlsx, type BadRowsOptions, type BadRowsRun } from "./bad-rows-xlsx";
import type { IssueExportRun } from "./issue-export";
import { prepareWorkbookExport, type WorkbookEvidenceMode } from "./workbook-export-policy";

export type { WorkbookEvidenceMode } from "./workbook-export-policy";
export type DesktopWorkbookWriter = (runs: BadRowsRun[], options: BadRowsOptions, destination: string, signal?: AbortSignal) => Promise<unknown>;

let desktopWriter: DesktopWorkbookWriter | undefined;

/** Desktop entrypoints inject the Node writer; web extension bundles never import Node APIs. */
export function setDesktopWorkbookWriter(writer: DesktopWorkbookWriter | undefined): void {
  desktopWriter = writer;
}

export function workbookRuns(runs: Array<IssueExportRun & Partial<BadRowsRun>>, mode: WorkbookEvidenceMode): BadRowsRun[] {
  return prepareWorkbookExport(runs, { title: "Validation results" }, mode).runs;
}

export async function confirmWorkbookEvidenceMode(mode: WorkbookEvidenceMode): Promise<boolean> {
  if (mode === "aggregate-only") return true;
  return await vscode.window.showWarningMessage(
    "This detailed Excel workbook can contain source-row identities, source values, joined values, and group context. Store and share it like the source data.",
    { modal: true }, "Export sensitive workbook"
  ) === "Export sensitive workbook";
}

export async function exportValidationWorkbook(
  destination: vscode.Uri,
  runs: Array<IssueExportRun & Partial<BadRowsRun>>,
  options: BadRowsOptions,
  mode: WorkbookEvidenceMode
): Promise<void> {
  const prepared = prepareWorkbookExport(runs, options, mode);
  const writer = desktopWriter;
  if (destination.scheme === "file" && writer) {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Exporting Excel validation package", cancellable: true }, async (_progress, token) => {
      const controller = new AbortController();
      if (token.isCancellationRequested) controller.abort();
      const cancellation = token.onCancellationRequested(() => controller.abort());
      try { await writer(prepared.runs, prepared.options, destination.fsPath, controller.signal); }
      finally { cancellation.dispose(); }
    });
    return;
  }
  const bytes = badRowsXlsx(prepared.runs, prepared.options);
  await vscode.workspace.fs.writeFile(destination, bytes);
}

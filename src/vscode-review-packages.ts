import * as vscode from "vscode";
import { parseValidationReviewPackage } from "./core/review-package";
import { compareValidationReviewPackages } from "./core/review-diff";
import { renderValidationReportHtml } from "./validation-report";
import { renderReviewDiffHtml } from "./review-diff-report";

async function pickPackage(title: string) {
  const selected = await vscode.window.showOpenDialog({ title, canSelectMany: false, filters: { "Validation review JSON": ["json"] } });
  if (!selected?.[0]) return undefined;
  const uri = selected[0];
  if ((await vscode.workspace.fs.stat(uri)).size > 64 * 1024 * 1024) throw new Error("Review packages larger than 64 MiB must be reduced before opening.");
  return parseValidationReviewPackage(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)));
}

function showReadOnlyReport(title: string, html: string): void {
  const panel = vscode.window.createWebviewPanel("csvContractSavedReview", title, vscode.ViewColumn.Active,
    { enableScripts: false, localResourceRoots: [] });
  panel.webview.html = html;
}

/** Saved review commands never open a source connection or run a validation. */
export function registerReviewPackageCommands(context: vscode.ExtensionContext): void {
  const guarded = (action: () => Promise<void>) => async (): Promise<void> => {
    try { await action(); }
    catch (error) { void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error)); }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand("csv-contract-vsce.openReviewPackage", guarded(async () => {
      const saved = await pickPackage("Open saved validation review package");
      if (saved) showReadOnlyReport("Saved validation review (read-only)", renderValidationReportHtml(saved));
    })),
    vscode.commands.registerCommand("csv-contract-vsce.compareReviewPackages", guarded(async () => {
      const before = await pickPackage("Choose the earlier validation review package");
      if (!before) return;
      const after = await pickPackage("Choose the later validation review package");
      if (after) showReadOnlyReport("Saved validation comparison (read-only)", renderReviewDiffHtml(compareValidationReviewPackages(before, after)));
    }))
  );
}

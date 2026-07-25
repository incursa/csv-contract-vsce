import * as vscode from "vscode";
import type { ComparisonResult } from "../../src/comparison/model";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export async function run(): Promise<void> {
  assert(vscode.env.uiKind === vscode.UIKind.Web, "The semantic comparison test must run in a real VS Code web host.");
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  assert(folder, "The web-host fixture workspace was not opened.");
  const extension = vscode.extensions.getExtension("incursa.csv-contract-vsce");
  assert(extension, "The CSV Contract Workbench extension was not installed in the web host.");
  await extension.activate();
  assert(extension.isActive, "The browser extension entry point did not activate.");

  const leftUri = vscode.Uri.joinPath(folder, "left.csv");
  const rightUri = vscode.Uri.joinPath(folder, "right.csv");
  const outputUri = vscode.Uri.joinPath(folder, "evidence");
  const result = await vscode.commands.executeCommand<ComparisonResult>("csv-contract-vsce.compareCsv", {
    leftUri,
    rightUri,
    outputUri,
    showResult: false,
    openDiff: false,
    options: {
      name: "VS Code web host parity",
      keyColumns: ["Id"],
      normalization: { decimalColumns: ["Hours"] }
    }
  });
  assert(result?.summary.mode === "keyed", "The command did not execute the keyed semantic engine.");
  assert(result.summary.differences.changed === 1, "The web-host command did not find the expected changed key.");
  assert(result.summary.differences.added === 1, "The web-host command did not find the expected added key.");
  assert(result.details.normalizedRowsTruncated === false, "The portable path unexpectedly used the desktop spill implementation.");
  assert(result.details.detailsTruncated === false, "The portable comparison unexpectedly bounded its evidence details.");

  const summaryUri = vscode.Uri.joinPath(outputUri, "ComparisonSummary.json");
  const summary = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(summaryUri))) as ComparisonResult["summary"];
  assert(summary.schema === "incursa.csv-semantic-comparison/v1", "The web host did not write canonical JSON evidence.");
  for (const name of ["ComparisonEvidence.csv", "ComparisonSummary.md", "NormalizedLeft.csv", "NormalizedRight.csv"]) {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(outputUri, name));
    assert(bytes.byteLength > 0, `${name} was not written through vscode.workspace.fs.`);
  }
}

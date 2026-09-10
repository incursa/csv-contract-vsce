import * as vscode from "vscode";
import { executeVscodeSuite } from "../../src/vscode-suites";
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
  const suiteUri = vscode.Uri.joinPath(folder, "offline.csvsuite.yaml");
  await vscode.workspace.fs.writeFile(suiteUri, new TextEncoder().encode("suiteVersion: 1\nid: web-check\nmembers:\n  - id: missing\n    ref: ./does-not-exist.csvtest.yaml\n  - id: database\n    contract:\n      version: 1\n      schema: {columns: {Id: {presence: required}}}\n      sqlServer: {connection: offline, schema: dbo, table: Synthetic}\n"));
  const suiteReport = await executeVscodeSuite(suiteUri);
  assert(!suiteReport.valid && suiteReport.runs.length === 2, "A suite with unavailable members must not pass or omit them.");
  assert(suiteReport.runs.every((entry) => entry.status === "ERROR"), "Missing references and database runs in web must report ERROR.");
  const suiteDocument = await vscode.workspace.openTextDocument(suiteUri);
  await vscode.window.showTextDocument(suiteDocument);
  // Diagnostics run asynchronously after opening; bounded wait for the actual provider output.
  for (let attempt = 0; attempt < 30 && !vscode.languages.getDiagnostics(suiteUri).length; attempt++) await new Promise((done) => setTimeout(done, 100));
  assert(vscode.languages.getDiagnostics(suiteUri).some((d) => d.message.includes("missing")), "Suite reference diagnostics were not published.");
  await vscode.workspace.fs.delete(suiteUri);

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

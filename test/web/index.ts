import * as vscode from "vscode";
import { executeVscodeSuite } from "../../src/vscode-suites";
import type { ComparisonResult } from "../../src/comparison/model";
import { readEditorContract } from "../../src/core/editor-document";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export async function run(): Promise<void> {
  assert(vscode.env.uiKind === vscode.UIKind.Web, "The semantic comparison test must run in a real VS Code web host.");
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  assert(folder, "The web-host fixture workspace was not opened.");
  const extension = vscode.extensions.getExtension("incursa.csv-contract-vsce");
  assert(extension, "The CSV Contract Workbench extension was not installed in the web host.");
  const exports = await extension.activate() as { testHooks?: {
    resolveContractEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel, memberId?: string): Promise<void>;
    testActions: Map<string, (message: unknown) => Promise<void>>;
    testStates: Map<string, { completedRuns: number; stale: boolean; live: boolean; runs: { result?: { valid: boolean } }[] }>;
  } };
  assert(extension.isActive, "The browser extension entry point did not activate.");
  const hooks = exports.testHooks;
  assert(hooks, "Real host test hooks must only be available in ExtensionMode.Test.");
  const liveCsv = vscode.Uri.joinPath(folder, "live-synthetic.csv");
  const liveSuite = vscode.Uri.joinPath(folder, "live-synthetic.csvsuite.yaml");
  await vscode.workspace.fs.writeFile(liveCsv, new TextEncoder().encode("Id\n0001\n0002\n"));
  await vscode.workspace.fs.writeFile(liveSuite, new TextEncoder().encode('suiteVersion: 1\nid: live\nmembers:\n  - id: inline\n    contract:\n      version: 1\n      targets: [{path: ./live-synthetic.csv}]\n      schema: {columns: {Id: {presence: required}}}\n      rules: [{id: constant, expect: {column: Id, operator: equals, value: "0001"}}]\n'));
  const liveDoc = await vscode.workspace.openTextDocument(liveSuite);
  const livePanel = vscode.window.createWebviewPanel("validatorHostTest", "Synthetic inline live test", vscode.ViewColumn.Active, {});
  await hooks.resolveContractEditor(liveDoc, livePanel, "inline");
  const key = `${liveSuite.toString()}#inline`;
  const send = hooks.testActions.get(key)!;
  await send({ type: "ready" });
  assert(hooks.testStates.get(key)?.completedRuns === 0, "Opening an inline editor must not execute.");
  const until = async (predicate: () => boolean, message: string) => {
    for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 50));
    assert(predicate(), message);
  };
  await send({ type: "live" });
  await until(() => hooks.testStates.get(key)?.completedRuns === 1, "Explicit live enable must run initial CSV validation.");
  assert(hooks.testStates.get(key)?.runs[0].result?.valid === false, "Synthetic initial assertion must fail.");
  const edited = readEditorContract(liveDoc.getText(), "inline");
  edited.rules![0].expect = { column: "Id", operator: "notNull" };
  await send({ type: "updateContract", contract: edited, documentVersion: liveDoc.version });
  await until(() => hooks.testStates.get(key)?.completedRuns === 2, "Undoable inline document edits must trigger live reruns.");
  assert(hooks.testStates.get(key)?.runs[0].result?.valid === true, "Edited rule must pass through the actual host execution pipeline.");
  await liveDoc.save();
  await new Promise(resolve => setTimeout(resolve, 650));
  assert(hooks.testStates.get(key)?.completedRuns === 2, "Save must coalesce with the semantic edit.");
  const validText = liveDoc.getText();
  const replace = async (text: string) => {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(liveDoc.uri, new vscode.Range(liveDoc.positionAt(0), liveDoc.positionAt(liveDoc.getText().length)), text);
    assert(await vscode.workspace.applyEdit(edit), "Host must apply the draft edit.");
  };
  await replace("suiteVersion: [invalid");
  await new Promise(resolve => setTimeout(resolve, 700));
  assert(hooks.testStates.get(key)?.completedRuns === 2, "Invalid intermediate YAML must never execute.");
  await replace(validText);
  await until(() => hooks.testStates.get(key)?.completedRuns === 3, "Repairing invalid YAML must resume live validation.");
  await liveDoc.save();
  await vscode.workspace.fs.writeFile(liveSuite, new TextEncoder().encode(validText.replace("notNull", "isNull")));
  await until(() => hooks.testStates.get(key)?.completedRuns === 4, "An external saved-file reload must invalidate the inline member.");
  assert(hooks.testStates.get(key)?.runs[0].result?.valid === false, "External reload must execute the new rule definition.");
  await send({ type: "live" });
  assert(hooks.testStates.get(key)?.live === false, "Pause control must stop live mode.");
  livePanel.dispose();
  await vscode.workspace.fs.delete(liveSuite);
  await vscode.workspace.fs.delete(liveCsv);
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
  await vscode.commands.executeCommand("csv-contract-vsce.openWorkbench", suiteUri);
  assert(vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputCustom, "Open Workbench must display the suite custom editor, not the YAML editor.");
  for (const extension of ["yaml", "yml"]) {
    const automaticUri = vscode.Uri.joinPath(folder, `automatic.csvsuite.${extension}`);
    await vscode.workspace.fs.writeFile(automaticUri, new TextEncoder().encode("suiteVersion: 1\nid: automatic\nmembers: [{id: one, ref: ./does-not-exist.csvtest.yaml}]\n"));
    await vscode.commands.executeCommand("vscode.open", automaticUri);
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert(tab?.input instanceof vscode.TabInputCustom, `${extension} suites must open in the Workbench by default.`);
    assert(tab.input.viewType === "csv-contract-vsce.contractEditor", "Suite opened in the wrong custom editor.");
    await vscode.window.tabGroups.close(tab);
    await vscode.workspace.fs.delete(automaticUri);
  }
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

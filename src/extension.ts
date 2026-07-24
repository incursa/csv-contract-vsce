import * as vscode from "vscode";
import { createContractFromCsv, parseContract, serializeContract, validateCsv } from "./core/contract";
import type { CsvContract, ValidationResult } from "./core/model";
import {
  configuredTargets,
  openTargetExternally,
  openTargetInVsCode,
  readTargetText,
  registerTargetContentProvider,
  relativeTargetPath,
  type ResolvedTarget
} from "./vscode-targets";
import { registerWorkspaceExplorer } from "./workspace-explorer";

const viewType = "csv-contract-vsce.contractEditor";

interface TargetRun {
  target: string;
  result: ValidationResult;
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("CSV Contract");
  const provider = new ContractEditorProvider(context);
  registerTargetContentProvider(context);
  context.subscriptions.push(
    output,
    vscode.window.registerCustomEditorProvider(viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false
    }),
    vscode.commands.registerCommand("csv-contract-vsce.createFromCsv", () => createFromCsv()),
    vscode.commands.registerCommand("csv-contract-vsce.runContract", () => runContract(output)),
    vscode.commands.registerCommand("csv-contract-vsce.openWorkbench", (uri?: vscode.Uri) => openWorkbench(uri))
  );
  registerWorkspaceExplorer(context, output);
}

export function deactivate(): void {}

async function pickFile(filters: Record<string, string[]>): Promise<vscode.Uri | undefined> {
  return (await pickFiles(filters, false))?.[0];
}

async function pickFiles(filters: Record<string, string[]>, canSelectMany = true): Promise<vscode.Uri[] | undefined> {
  return vscode.window.showOpenDialog({ canSelectMany, filters });
}

async function createFromCsv(): Promise<void> {
  const csvUri = await pickFile({ "CSV files": ["csv"], "All files": ["*"] });
  if (!csvUri) return;
  const csvText = new TextDecoder("utf-8").decode(await vscode.workspace.fs.readFile(csvUri));
  const contract = createContractFromCsv(csvText);
  const suggested = vscode.Uri.joinPath(csvUri, "..", `${csvUri.path.split("/").pop()}.csvtest.yaml`);
  const outputUri = await vscode.window.showSaveDialog({
    defaultUri: suggested,
    filters: { "CSV contract": ["csvtest.yaml"] }
  });
  if (!outputUri) return;
  contract.targets = [{ path: relativeTargetPath(outputUri, csvUri) }];
  const schemaUrl = "https://raw.githubusercontent.com/incursa/csv-contract-vsce/main/schemas/csvtest.schema.json";
  await vscode.workspace.fs.writeFile(outputUri, new TextEncoder().encode(serializeContract(contract, schemaUrl)));
  await vscode.commands.executeCommand("vscode.openWith", outputUri, viewType);
}

async function runContract(output: vscode.OutputChannel): Promise<void> {
  const specUri = await pickFile({ "CSV contracts": ["csvtest.yaml", "csvtest.yml", "yaml", "yml"] });
  if (!specUri) return;
  const contract = parseContract(new TextDecoder().decode(await vscode.workspace.fs.readFile(specUri)));
  let targets = configuredTargets(specUri, contract);
  if (targets.length === 0) {
    const csvUris = await pickFiles({ "CSV files": ["csv"] });
    if (!csvUris?.length) return;
    targets = csvUris.map((uri) => ({ label: vscode.workspace.asRelativePath(uri, false), source: uri }));
  }
  output.clear();
  let valid = true;
  for (const target of targets) {
    const result = validateCsv(contract, await readTargetText(target));
    valid &&= result.valid;
    output.appendLine(`${result.valid ? "PASS" : "FAIL"} ${target.label}`);
    output.appendLine(`${result.rowCount} rows · ${result.columnCount} columns · ${result.issueCount} issues`);
    result.issues.forEach((issue) => output.appendLine(`${issue.code}: ${issue.message}`));
    output.appendLine("");
  }
  output.show(true);
  void vscode.window.showInformationMessage(
    valid ? `CSV contract passed for ${targets.length} target(s).` : "CSV contract failed. See the CSV Contract output channel."
  );
}

async function openWorkbench(requestedUri?: vscode.Uri): Promise<void> {
  if (requestedUri?.path.match(/\.csvtest\.ya?ml$/i)) {
    await vscode.commands.executeCommand("vscode.openWith", requestedUri, viewType);
    return;
  }
  const active = vscode.window.activeTextEditor?.document.uri;
  const uri = active?.path.match(/\.csvtest\.ya?ml$/i)
    ? active
    : await pickFile({ "CSV contracts": ["csvtest.yaml", "csvtest.yml"] });
  if (uri) await vscode.commands.executeCommand("vscode.openWith", uri, viewType);
}

class ContractEditorProvider implements vscode.CustomTextEditorProvider {
  public constructor(private readonly context: vscode.ExtensionContext) {}

  public async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri]
    };
    panel.webview.html = this.html(panel.webview);
    let manualTargets: ResolvedTarget[] | undefined;

    const postState = async (runs: TargetRun[] = []): Promise<void> => {
      try {
        const contract = parseContract(document.getText());
        const savedTargets = configuredTargets(document.uri, contract);
        const activeTargets = manualTargets ?? savedTargets;
        await panel.webview.postMessage({
          type: "state",
          contract,
          contractName: vscode.workspace.asRelativePath(document.uri, false),
          targetNames: activeTargets.map((target) => target.label),
          configuredTargetCount: savedTargets.length,
          usingConfiguredTargets: manualTargets === undefined && savedTargets.length > 0,
          runs
        });
      } catch (error) {
        await panel.webview.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
      }
    };

    const documentSubscription = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.toString() === document.uri.toString()) void postState();
    });
    panel.onDidDispose(() => documentSubscription.dispose());
    panel.webview.onDidReceiveMessage(async (message: any) => {
      if (message.type === "ready") {
        await postState();
      } else if (message.type === "chooseCsv") {
        const uris = await pickFiles({ "CSV files": ["csv"] });
        if (!uris?.length) return;
        manualTargets = uris.map((uri) => ({ label: vscode.workspace.asRelativePath(uri, false), source: uri }));
        await postState();
      } else if (message.type === "useConfiguredTargets") {
        manualTargets = undefined;
        await postState();
      } else if (message.type === "addTargetFiles") {
        const uris = await pickFiles({ "CSV files": ["csv"] });
        if (!uris?.length) return;
        const contract = parseContract(document.getText());
        contract.targets ??= [];
        const existing = new Set(contract.targets.map((target) => target.path ?? target.url));
        for (const uri of uris) {
          const path = relativeTargetPath(document.uri, uri);
          if (!existing.has(path)) contract.targets.push({ path });
        }
        await this.replaceDocument(document, serializeContract(contract));
      } else if (message.type === "addTargetUrl") {
        const url = await vscode.window.showInputBox({
          title: "Add CSV URL",
          prompt: "Enter an HTTP or HTTPS URL that returns CSV content.",
          placeHolder: "https://example.com/export.csv",
          validateInput: (value) => /^https?:\/\/\S+$/i.test(value) ? undefined : "Enter a valid HTTP or HTTPS URL."
        });
        if (!url) return;
        const contract = parseContract(document.getText());
        contract.targets ??= [];
        if (!contract.targets.some((target) => target.url === url)) contract.targets.push({ url });
        await this.replaceDocument(document, serializeContract(contract));
      } else if (message.type === "openTargetInVsCode" || message.type === "openTargetExternally") {
        const contract = parseContract(document.getText());
        const target = configuredTargets(document.uri, contract)[Number(message.index)];
        if (!target) {
          void vscode.window.showWarningMessage("That configured CSV target is no longer available.");
          return;
        }
        try {
          if (message.type === "openTargetInVsCode") await openTargetInVsCode(target);
          else await openTargetExternally(target);
        } catch (error) {
          void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
        }
      } else if (message.type === "openActiveTargetInVsCode" || message.type === "openActiveTargetExternally") {
        const contract = parseContract(document.getText());
        const targets = manualTargets ?? configuredTargets(document.uri, contract);
        const target = await selectTargetToOpen(targets);
        if (!target) return;
        try {
          if (message.type === "openActiveTargetInVsCode") await openTargetInVsCode(target);
          else await openTargetExternally(target);
        } catch (error) {
          void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
        }
      } else if (message.type === "run") {
        const runs: TargetRun[] = [];
        try {
          const contract = parseContract(document.getText());
          const targets = manualTargets ?? configuredTargets(document.uri, contract);
          if (targets.length === 0) {
            void vscode.window.showWarningMessage("Select a test CSV or add configured file paths or URLs before running the contract.");
            return;
          }
          for (const [index, target] of targets.entries()) {
            await panel.webview.postMessage({
              type: "runState",
              running: true,
              target: target.label,
              index: index + 1,
              total: targets.length
            });
            runs.push({ target: target.label, result: validateCsv(contract, await readTargetText(target)) });
            await postState(runs);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await postState(runs);
          void vscode.window.showErrorMessage(message);
        } finally {
          await panel.webview.postMessage({ type: "runState", running: false });
        }
      } else if (message.type === "updateContract") {
        await this.replaceDocument(document, serializeContract(message.contract as CsvContract));
      } else if (message.type === "openYaml") {
        await vscode.commands.executeCommand("vscode.openWith", document.uri, "default");
      }
    });
  }

  private async replaceDocument(document: vscode.TextDocument, text: string): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    const last = document.lineAt(document.lineCount - 1);
    edit.replace(document.uri, new vscode.Range(new vscode.Position(0, 0), last.range.end), text);
    await vscode.workspace.applyEdit(edit);
  }

  private html(webview: vscode.Webview): string {
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", "web", "webview.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", "web", "webview.css"));
    const nonce = String(Date.now());
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${style}">
  <title>CSV Contract Workbench</title>
</head>
<body>
  <main id="app" aria-live="polite"></main>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

async function selectTargetToOpen(targets: ResolvedTarget[]): Promise<ResolvedTarget | undefined> {
  if (targets.length === 0) {
    void vscode.window.showWarningMessage("Select a test CSV or add a configured target first.");
    return undefined;
  }
  if (targets.length === 1) return targets[0];
  return (await vscode.window.showQuickPick(
    targets.map((target) => ({
      label: target.label,
      description: typeof target.source === "string" ? "URL" : "File",
      target
    })),
    {
      title: "Open test CSV",
      placeHolder: "Choose a test target"
    }
  ))?.target;
}

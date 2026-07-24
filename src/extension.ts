import * as vscode from "vscode";
import { createContractFromCsv, parseContract, parseCsv, serializeContract, validateCsv } from "./core/contract";
import type { CsvContract, ValidationResult } from "./core/model";

const viewType = "csv-contract-vsce.contractEditor";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("CSV Contract");
  const provider = new ContractEditorProvider(context);
  context.subscriptions.push(
    output,
    vscode.window.registerCustomEditorProvider(viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false
    }),
    vscode.commands.registerCommand("csv-contract-vsce.createFromCsv", () => createFromCsv()),
    vscode.commands.registerCommand("csv-contract-vsce.runContract", () => runContract(output)),
    vscode.commands.registerCommand("csv-contract-vsce.openWorkbench", () => openWorkbench())
  );
}

export function deactivate(): void {}

async function pickFile(filters: Record<string, string[]>): Promise<vscode.Uri | undefined> {
  return (await vscode.window.showOpenDialog({ canSelectMany: false, filters }))?.[0];
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
  const schemaUrl = "https://raw.githubusercontent.com/incursa/csv-contract-vsce/main/schemas/csvtest.schema.json";
  await vscode.workspace.fs.writeFile(outputUri, new TextEncoder().encode(serializeContract(contract, schemaUrl)));
  await vscode.commands.executeCommand("vscode.openWith", outputUri, viewType);
}

async function runContract(output: vscode.OutputChannel): Promise<void> {
  const specUri = await pickFile({ "CSV contracts": ["csvtest.yaml", "csvtest.yml", "yaml", "yml"] });
  if (!specUri) return;
  const csvUri = await pickFile({ "CSV files": ["csv"] });
  if (!csvUri) return;
  const [contractBytes, csvBytes] = await Promise.all([
    vscode.workspace.fs.readFile(specUri),
    vscode.workspace.fs.readFile(csvUri)
  ]);
  const result = validateCsv(
    parseContract(new TextDecoder().decode(contractBytes)),
    new TextDecoder().decode(csvBytes)
  );
  output.clear();
  output.appendLine(`${result.valid ? "PASS" : "FAIL"} ${specUri.fsPath}`);
  output.appendLine(`${result.rowCount} rows · ${result.columnCount} columns · ${result.issues.length} issues`);
  result.issues.forEach((issue) => output.appendLine(`${issue.code}: ${issue.message}`));
  output.show(true);
  void vscode.window.showInformationMessage(result.valid ? "CSV contract passed." : `CSV contract failed with ${result.issues.length} issue(s).`);
}

async function openWorkbench(): Promise<void> {
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
    let csvText: string | undefined;
    let csvName: string | undefined;

    const postState = async (result?: ValidationResult): Promise<void> => {
      try {
        const contract = parseContract(document.getText());
        const parsed = csvText === undefined ? undefined : parseCsv(csvText, contract.csv);
        await panel.webview.postMessage({
          type: "state",
          contract,
          contractName: vscode.workspace.asRelativePath(document.uri, false),
          csvName,
          csv: parsed && { headers: parsed.headers, rowCount: parsed.rows.length },
          result
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
        const uri = await pickFile({ "CSV files": ["csv"] });
        if (!uri) return;
        csvText = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
        csvName = vscode.workspace.asRelativePath(uri, false);
        await postState();
      } else if (message.type === "run") {
        if (csvText === undefined) {
          void vscode.window.showWarningMessage("Choose a CSV file before running the contract.");
          return;
        }
        const contract = parseContract(document.getText());
        await postState(validateCsv(contract, csvText));
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

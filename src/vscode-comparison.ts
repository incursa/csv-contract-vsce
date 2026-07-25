import * as vscode from "vscode";
import { compareCsvTexts } from "./comparison/engine";
import { createEvidenceFiles, rowsToCsv } from "./comparison/evidence";
import type { ComparisonOptions, ComparisonResult } from "./comparison/model";

const webMaxBytesPerFile = 20 * 1024 * 1024;
const webMaxRowsPerFile = 250_000;
const comparisonScheme = "csv-contract-comparison";

export interface ComparisonCommandRequest {
  leftUri: vscode.Uri;
  rightUri: vscode.Uri;
  options?: ComparisonOptions;
  outputUri?: vscode.Uri;
  showResult?: boolean;
  openDiff?: boolean;
}

export type DesktopComparisonRunner = (
  leftUri: vscode.Uri,
  rightUri: vscode.Uri,
  options: ComparisonOptions
) => Promise<ComparisonResult>;

class NormalizedComparisonProvider implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();

  public provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? "";
  }

  public set(label: string, content: string): vscode.Uri {
    const uri = vscode.Uri.parse(`${comparisonScheme}:/${encodeURIComponent(label)}-${Date.now()}-${Math.random().toString(36).slice(2)}.csv`);
    this.contents.set(uri.toString(), content);
    return uri;
  }
}

export function registerSemanticComparison(
  context: vscode.ExtensionContext,
  desktopRunner?: DesktopComparisonRunner
): void {
  const provider = new NormalizedComparisonProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(comparisonScheme, provider),
    vscode.commands.registerCommand("csv-contract-vsce.compareCsv", async (request?: ComparisonCommandRequest) =>
      compareCommand(context, provider, desktopRunner, request)
    )
  );
}

async function compareCommand(
  context: vscode.ExtensionContext,
  provider: NormalizedComparisonProvider,
  desktopRunner: DesktopComparisonRunner | undefined,
  request?: ComparisonCommandRequest
): Promise<ComparisonResult | undefined> {
  const interactive = !request;
  const selection = request ?? await promptForComparison();
  if (!selection) return undefined;
  const options = {
    ...(selection.options ?? {}),
    name: selection.options?.name ?? `${uriName(selection.leftUri)} vs ${uriName(selection.rightUri)}`
  };
  let result: ComparisonResult;
  if (desktopRunner && selection.leftUri.scheme === "file" && selection.rightUri.scheme === "file") {
    result = await desktopRunner(selection.leftUri, selection.rightUri, options);
  } else {
    const [leftText, rightText] = await Promise.all([
      readPortableCsv(selection.leftUri),
      readPortableCsv(selection.rightUri)
    ]);
    result = compareCsvTexts(leftText, rightText, options);
  }
  enforcePortableRowLimit(result, desktopRunner !== undefined);
  if (selection.outputUri) await writeEvidence(selection.outputUri, result);
  if (selection.openDiff) await openNormalizedDiff(provider, result);
  if (selection.showResult !== false) showResultPanel(context, provider, result, selection.leftUri, selection.rightUri);
  if (interactive) {
    void vscode.window.showInformationMessage(
      result.summary.semanticEqual
        ? "The CSV files are semantically equal."
        : `CSV comparison finished: ${result.summary.status}.`
    );
  }
  return result;
}

async function readPortableCsv(uri: vscode.Uri): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  if (bytes.byteLength > webMaxBytesPerFile) {
    throw new Error(`Portable comparison is limited to ${webMaxBytesPerFile / 1024 / 1024} MiB per CSV. Use VS Code desktop for larger files.`);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function enforcePortableRowLimit(result: ComparisonResult, desktop: boolean): void {
  if (!desktop && (result.summary.left.rowCount > webMaxRowsPerFile || result.summary.right.rowCount > webMaxRowsPerFile)) {
    throw new Error(`Portable comparison is limited to ${webMaxRowsPerFile.toLocaleString()} data rows per CSV. Use VS Code desktop for larger files.`);
  }
}

async function promptForComparison(): Promise<ComparisonCommandRequest | undefined> {
  const leftUri = (await vscode.window.showOpenDialog({
    title: "Choose the left (before) CSV",
    canSelectMany: false,
    filters: { "CSV files": ["csv"] }
  }))?.[0];
  if (!leftUri) return undefined;
  const rightUri = (await vscode.window.showOpenDialog({
    title: "Choose the right (after) CSV",
    canSelectMany: false,
    filters: { "CSV files": ["csv"] }
  }))?.[0];
  if (!rightUri) return undefined;
  const mode = await vscode.window.showQuickPick([
    { label: "Full-row multiset", description: "Order-independent; duplicate occurrences remain significant", value: "full" },
    { label: "Keyed comparison", description: "Compare unique records by one or more explicit key columns", value: "keyed" }
  ], { title: "Comparison mode" });
  if (!mode) return undefined;
  const keys = mode.value === "keyed"
    ? splitColumns(await vscode.window.showInputBox({
      title: "Key columns",
      prompt: "Enter one or more exact column names separated by commas. Keys are never inferred.",
      validateInput: (value) => value.trim() ? undefined : "Enter at least one key column."
    }))
    : [];
  if (mode.value === "keyed" && !keys.length) return undefined;
  const selected = await vscode.window.showQuickPick([
    { label: "Trim values", value: "trim", picked: false },
    { label: "Invariant case fold", value: "caseFold", picked: false },
    { label: "Blank/null equivalence", value: "blankNullEquivalent", picked: false }
  ], { title: "Opt-in normalizations", canPickMany: true }) ?? [];
  const ignored = splitColumns(await vscode.window.showInputBox({
    title: "Ignored columns (optional)",
    prompt: "Exact comma-separated column names. Ignored columns do not participate in comparison."
  }));
  const context = keys.length ? splitColumns(await vscode.window.showInputBox({
    title: "Context columns (optional)",
    prompt: "Exact comma-separated columns included in local evidence for keyed differences."
  })) : [];
  const dateColumns = splitColumns(await vscode.window.showInputBox({
    title: "Date columns (optional)",
    prompt: "Only these explicit columns receive invariant date normalization."
  }));
  const decimalColumns = splitColumns(await vscode.window.showInputBox({
    title: "Decimal columns (optional)",
    prompt: "Only these explicit columns receive invariant decimal normalization."
  }));
  return {
    leftUri,
    rightUri,
    options: {
      keyColumns: keys,
      contextColumns: context,
      ignoredColumns: ignored,
      normalization: {
        trim: selected.some((item) => item.value === "trim"),
        caseFold: selected.some((item) => item.value === "caseFold"),
        blankNullEquivalent: selected.some((item) => item.value === "blankNullEquivalent"),
        dateColumns,
        decimalColumns
      }
    }
  };
}

function splitColumns(value: string | undefined): string[] {
  return value?.split(",").map((column) => column.trim()).filter(Boolean) ?? [];
}

function uriName(uri: vscode.Uri): string {
  return decodeURIComponent(uri.path.split("/").pop() || uri.authority || "CSV");
}

async function writeEvidence(directory: vscode.Uri, result: ComparisonResult): Promise<void> {
  await vscode.workspace.fs.createDirectory(directory);
  const encoder = new TextEncoder();
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const temporaryUris: vscode.Uri[] = [];
  try {
    for (const file of createEvidenceFiles(result)) {
      const temporary = vscode.Uri.joinPath(directory, `.${file.name}.${nonce}.tmp`);
      temporaryUris.push(temporary);
      await vscode.workspace.fs.writeFile(temporary, encoder.encode(file.content));
      await vscode.workspace.fs.rename(temporary, vscode.Uri.joinPath(directory, file.name), { overwrite: true });
      temporaryUris.pop();
    }
  } finally {
    await Promise.all(temporaryUris.map((uri) => vscode.workspace.fs.delete(uri).then(undefined, () => undefined)));
  }
}

async function openNormalizedDiff(provider: NormalizedComparisonProvider, result: ComparisonResult): Promise<void> {
  if (result.details.normalizedRowsTruncated) {
    throw new Error("Normalized diff is unavailable for a spill-to-disk comparison. Save the aggregate evidence or compare smaller extracts.");
  }
  const left = provider.set("NormalizedLeft", rowsToCsv(result.details.columns, result.details.normalizedLeftRows));
  const right = provider.set("NormalizedRight", rowsToCsv(result.details.columns, result.details.normalizedRightRows));
  await vscode.commands.executeCommand("vscode.diff", left, right, `${result.summary.name}: normalized CSV`);
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;");
}

function showResultPanel(
  context: vscode.ExtensionContext,
  provider: NormalizedComparisonProvider,
  result: ComparisonResult,
  leftUri: vscode.Uri,
  rightUri: vscode.Uri
): void {
  const panel = vscode.window.createWebviewPanel(
    "csv-contract-vsce.comparisonResult",
    result.summary.name,
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.webview.html = resultHtml(panel.webview, result, leftUri, rightUri);
  panel.webview.onDidReceiveMessage(async (message) => {
    if (message.type === "diff") {
      await openNormalizedDiff(provider, result);
    } else if (message.type === "save") {
      const directory = (await vscode.window.showOpenDialog({
        title: "Choose an evidence output folder",
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false
      }))?.[0];
      if (directory) {
        await writeEvidence(directory, result);
        void vscode.window.showInformationMessage(`Comparison evidence saved to ${vscode.workspace.asRelativePath(directory, false)}.`);
      }
    }
  }, undefined, context.subscriptions);
}

function resultHtml(webview: vscode.Webview, result: ComparisonResult, leftUri: vscode.Uri, rightUri: vscode.Uri): string {
  const nonce = String(Date.now());
  const { summary } = result;
  const metrics = [
    ["Added", summary.differences.added],
    ["Removed", summary.differences.removed],
    ["Changed keys", summary.differences.changed],
    ["Unchanged", summary.differences.unchanged],
    ["Changed cells", summary.differences.changedCells],
    ["Schema changes", summary.differences.schemaChanges],
    ["Duplicate keys", summary.differences.duplicateKeysLeft + summary.differences.duplicateKeysRight]
  ];
  const changed = Object.entries(summary.differences.changedCellsByColumn).filter(([, count]) => count > 0);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>${escapeHtml(summary.name)}</title>
  <style nonce="${nonce}">
    body{padding:0;color:var(--vscode-foreground);background:var(--vscode-editor-background);font:var(--vscode-font-size)/1.5 var(--vscode-font-family)}
    main{max-width:72rem;margin:auto;padding:2rem}.header{display:flex;justify-content:space-between;gap:1rem;align-items:flex-start}.eyebrow{color:var(--vscode-descriptionForeground);text-transform:uppercase;letter-spacing:.08em;font-size:.72rem}
    h1{margin:.2rem 0;font-size:1.6rem}.status{padding:.35rem .65rem;border:1px solid var(--vscode-panel-border);border-radius:999px;font-weight:700}.status.equal{color:var(--vscode-testing-iconPassed)}.status.different,.status.schema-mismatch,.status.duplicate-keys{color:var(--vscode-testing-iconFailed)}
    .sources{color:var(--vscode-descriptionForeground);overflow-wrap:anywhere}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(8rem,1fr));gap:.75rem;margin:1.5rem 0}.card,section{border:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background);border-radius:6px}.card{padding:1rem}.card span{display:block;color:var(--vscode-descriptionForeground);font-size:.78rem}.card strong{font-size:1.5rem}
    section{margin:1rem 0;padding:1rem 1.2rem}h2{font-size:1rem;margin:0 0 .7rem}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:.45rem;border-bottom:1px solid var(--vscode-panel-border)}th{color:var(--vscode-descriptionForeground)}
    .actions{display:flex;gap:.6rem;flex-wrap:wrap;margin-top:1.25rem}button{padding:.5rem .8rem;border:1px solid var(--vscode-button-border,transparent);color:var(--vscode-button-foreground);background:var(--vscode-button-background);border-radius:3px;cursor:pointer}button:hover{background:var(--vscode-button-hoverBackground)}
    @media(max-width:520px){main{padding:1rem}.header{display:block}.status{display:inline-block;margin-top:.8rem}}
  </style>
</head>
<body>
<main>
  <header class="header"><div><div class="eyebrow">Semantic CSV comparison · ${escapeHtml(summary.mode)}</div><h1>${escapeHtml(summary.name)}</h1><div class="sources">${escapeHtml(leftUri.path)} ↔ ${escapeHtml(rightUri.path)}</div></div><span class="status ${summary.status}">${escapeHtml(summary.status)}</span></header>
  <div class="metrics">${metrics.map(([label, value]) => `<div class="card"><span>${label}</span><strong>${value}</strong></div>`).join("")}</div>
  <section><h2>Schema</h2><p>${summary.columns.comparableColumns.length} comparable columns. Left-only: ${escapeHtml(summary.columns.columnsOnlyInLeft.join(", ") || "none")}. Right-only: ${escapeHtml(summary.columns.columnsOnlyInRight.join(", ") || "none")}.</p></section>
  <section><h2>Changed cells by column</h2>${changed.length ? `<table><thead><tr><th>Column</th><th>Changed cells</th></tr></thead><tbody>${changed.map(([column, count]) => `<tr><td>${escapeHtml(column)}</td><td>${count}</td></tr>`).join("")}</tbody></table>` : "<p>No safely paired cell changes.</p>"}</section>
  <section><h2>Privacy-bounded diagnostics</h2><p>${summary.diagnostics.included} of ${summary.diagnostics.total} aggregate diagnostics shown. Cell values are withheld from this view.${result.details.detailsTruncated ? " Detailed spill-mode review rows are also bounded; aggregate counts remain exact." : ""}</p></section>
  <div class="actions">${result.details.normalizedRowsTruncated ? "" : `<button id="diff">Open normalized diff</button>`}<button id="save">Save JSON, CSV, and Markdown evidence</button></div>
</main>
<script nonce="${nonce}">const vscode=acquireVsCodeApi();document.getElementById("diff")?.addEventListener("click",()=>vscode.postMessage({type:"diff"}));document.getElementById("save").addEventListener("click",()=>vscode.postMessage({type:"save"}));</script>
</body>
</html>`;
}

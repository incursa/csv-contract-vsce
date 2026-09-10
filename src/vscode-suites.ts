import * as vscode from "vscode";
import { generateSuiteSql, loadSuite, parseSuite, runSuite, yamlDocument, type SuiteIO } from "./core/suite";
import type { DesktopSqlServerRunner } from "./extension";
import { renderWorkspaceReportHtml } from "./workspace-report";
import { configuredTargets, readTargetText } from "./vscode-targets";
import { validateCsv } from "./core/contract";
import { renderSuiteWorkbench } from "./suite-workbench";

export async function resolveSuiteEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel, runner?: DesktopSqlServerRunner): Promise<void> {
  panel.webview.options = { enableScripts: true, localResourceRoots: [] };
  let running = false;
  let disposed = false;
  let generation = 0;
  let renderVersion = 0;
  let notice: string | undefined;
  let report: Awaited<ReturnType<typeof executeVscodeSuite>> | undefined;
  const render = async (): Promise<void> => {
    const version = ++renderVersion;
    const nonce = globalThis.crypto.randomUUID().replaceAll("-", "");
    try {
      const parsed = parseSuite(document.getText());
      const suite = await loadSuite(document.uri.toString(), vscodeSuiteIO);
      if (disposed || version !== renderVersion) return;
      panel.webview.html = renderSuiteWorkbench({ suite, name: parsed.name, description: parsed.description,
        references: parsed.members.map((m) => m.ref), running, runs: report?.runs, notice }, nonce);
    } catch (error) {
      if (!disposed && version === renderVersion) panel.webview.html = renderSuiteWorkbench({ error: String(error), running }, nonce);
    }
  };
  const refresh = (): void => {
    generation++;
    if (report) notice = "Contracts changed. Run the suite again for current results.";
    report = undefined;
    void render();
  };
  const watcher = vscode.workspace.createFileSystemWatcher("**/*.{yaml,yml}");
  const subscriptions = [watcher, watcher.onDidChange(refresh), watcher.onDidCreate(refresh), watcher.onDidDelete(refresh),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (/\.ya?ml$/i.test(event.document.uri.path)) refresh();
    }), panel.webview.onDidReceiveMessage(async (message: { type?: string; index?: number }) => {
      try {
        if (message.type === "run" && !running) {
          running = true; notice = undefined; report = undefined;
          const startedGeneration = generation;
          await render();
          try {
            const result = await executeVscodeSuite(document.uri, runner);
            if (startedGeneration === generation) report = result;
            else notice = "Contracts changed during execution. Run again for current results.";
          } finally { running = false; await render(); }
        } else if (message.type === "sql" && !running) await showSuiteSql(document.uri);
        else if (message.type === "yaml" || message.type === "member") {
          let selection: vscode.Range | undefined;
          if (message.type === "member") {
            const parsed = parseSuite(document.getText());
            if (!Number.isInteger(message.index) || message.index! < 0 || message.index! >= parsed.members.length) return;
            const member = parsed.members[message.index!];
            if (member.ref) {
              await vscode.commands.executeCommand("vscode.openWith", vscode.Uri.parse(vscodeSuiteIO.resolve(document.uri.toString(), member.ref)), "csv-contract-vsce.contractEditor");
              return;
            }
            const node = yamlDocument(document.getText()).getIn(["members", message.index!, "contract"], true);
            if (node && typeof node === "object" && "range" in node && Array.isArray(node.range)) {
              const position = document.positionAt(node.range[0]);
              selection = new vscode.Range(position, position);
            }
          }
          await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside, selection, preview: false });
        }
      } catch (error) {
        notice = String(error);
        await render();
        void vscode.window.showErrorMessage(notice);
      }
    })];
  panel.onDidDispose(() => { disposed = true; subscriptions.forEach((s) => s.dispose()); });
  await render();
}

export const vscodeSuiteIO: SuiteIO = {
  read: async (source) => {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === source);
    return open?.getText() ?? new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.parse(source)));
  },
  resolve: (source, ref) => {
    if (/^[A-Za-z]:[\\/]/.test(ref) || ref.startsWith("\\\\")) return vscode.Uri.file(ref).toString();
    if (ref.startsWith("/")) return vscode.Uri.parse(source).with({ path: ref }).toString();
    return vscode.Uri.joinPath(vscode.Uri.parse(source), "..", ref.replaceAll("\\", "/")).toString();
  }
};
export async function executeVscodeSuite(uri: vscode.Uri, runner?: DesktopSqlServerRunner) {
  const suite = await loadSuite(uri.toString(), vscodeSuiteIO);
  return runSuite(suite, async (contract, target) => {
    if (!runner) throw new Error("Database suite execution requires the desktop extension host.");
    return runner(contract, target);
  }, false, async (contract, source, target) => {
    const resolved = configuredTargets(vscode.Uri.parse(source), { ...contract, targets: [target] })[0];
    return validateCsv(contract, await readTargetText(resolved));
  });
}
export async function showSuiteRun(context: vscode.ExtensionContext, uri: vscode.Uri, runner?: DesktopSqlServerRunner): Promise<void> {
  try {
    const started = Date.now();
    const report = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Running contract suite" }, () => executeVscodeSuite(uri, runner));
    const panel = vscode.window.createWebviewPanel("csvContractSuiteReport", `${report.status}: ${report.suite}`, vscode.ViewColumn.Active, {});
    panel.webview.html = renderWorkspaceReportHtml({ completedAt: new Date(), durationMs: Date.now() - started,
      selectedContracts: report.members.length, targets: report.runs.length, valid: report.valid,
      entries: report.runs.map((run) => ({ contractLabel: `${run.suite}/${run.member}`, target: run.table ?? run.target ?? "Unresolved member", result: run.result, error: run.error }))
    }, { cspSource: panel.webview.cspSource, styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "dist", "web", "webview.css")).toString() });
  } catch (e) { void vscode.window.showErrorMessage(String(e)); }
}
export async function showSuiteSql(uri: vscode.Uri): Promise<void> {
  const generated = generateSuiteSql(await loadSuite(uri.toString(), vscodeSuiteIO));
  const multipleConnections = new Set(generated.batches.map((b) => JSON.stringify(b.integratedConnection ?? b.connection))).size > 1;
  const document = await vscode.workspace.openTextDocument({ language: multipleConnections ? "json" : "sql", content: multipleConnections ? JSON.stringify(generated, null, 2) : generated.sql });
  await vscode.window.showTextDocument(document);
  if (generated.warnings.length) void vscode.window.showWarningMessage(generated.warnings.join("\n"));
}
export function registerSuiteDiagnostics(context: vscode.ExtensionContext): void {
  const diagnostics = vscode.languages.createDiagnosticCollection("csvContractSuites");
  const revisions = new Map<string, number>();
  const validate = async (document: vscode.TextDocument): Promise<void> => {
    if (!/\.csvsuite\.ya?ml$/i.test(document.uri.path)) return;
    const key = document.uri.toString();
    const revision = (revisions.get(key) ?? 0) + 1;
    revisions.set(key, revision);
    const problems: vscode.Diagnostic[] = [];
    try {
      const suite = await loadSuite(key, vscodeSuiteIO);
      for (const member of suite.members) {
        if (member.error) {
          const line = document.getText().split(/\r?\n/).findIndex((l) => l.includes(member.id));
          problems.push(new vscode.Diagnostic(document.lineAt(Math.max(0, line)).range, `${suite.id}/${member.id}: ${member.error}`, vscode.DiagnosticSeverity.Error));
        }
      }
    } catch (e) { problems.push(new vscode.Diagnostic(document.lineAt(0).range, String(e), vscode.DiagnosticSeverity.Error)); }
    if (revisions.get(key) === revision) diagnostics.set(document.uri, problems);
  };
  const refresh = (): void => { vscode.workspace.textDocuments.forEach((d) => { void validate(d); }); };
  const watcher = vscode.workspace.createFileSystemWatcher("**/*.{yaml,yml}");
  context.subscriptions.push(diagnostics, watcher, watcher.onDidChange(refresh), watcher.onDidCreate(refresh), watcher.onDidDelete(refresh),
    vscode.workspace.onDidOpenTextDocument((d) => { void validate(d); }),
    vscode.workspace.onDidChangeTextDocument(refresh), vscode.workspace.onDidCloseTextDocument((d) => diagnostics.delete(d.uri)));
  refresh();
}

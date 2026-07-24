import * as vscode from "vscode";
import { parseContract, validateCsv } from "./core/contract";
import type { CsvContract, ValidationIssue, ValidationResult } from "./core/model";
import {
  configuredTargets,
  openTargetExternally,
  openTargetInVsCode,
  readTargetText,
  targetKey,
  type ResolvedTarget
} from "./vscode-targets";
import { renderWorkspaceReportHtml } from "./workspace-report";

export const explorerContainerId = "csvContractExplorer";
export const explorerViewId = "csvContractExplorer.contracts";
export const openExplorerCommand = "csv-contract-vsce.openExplorer";
export const refreshExplorerCommand = "csv-contract-vsce.refreshExplorer";
export const runSelectedCommand = "csv-contract-vsce.runSelectedContracts";
export const showWorkspaceReportCommand = "csv-contract-vsce.showWorkspaceReport";
export const openTargetInVsCodeCommand = "csv-contract-vsce.openTargetInVsCode";
export const openTargetExternallyCommand = "csv-contract-vsce.openTargetExternally";

const checkedContractsKey = "csvContractExplorer.checkedContracts";
const contractPattern = "**/*.csvtest.{yaml,yml}";
const contractExclude = "**/{node_modules,.git,dist,.vscode-test,.vscode-test-web}/**";

interface ContractSnapshot {
  uri: vscode.Uri;
  folder: vscode.WorkspaceFolder;
  relativePath: string;
  targetCount: number;
  targets: ResolvedTarget[];
  parseError?: string;
}

interface PreparedContract {
  snapshot: ContractSnapshot;
  contract: CsvContract;
}

interface TargetGroup {
  target: ResolvedTarget;
  contracts: PreparedContract[];
}

interface WorkspaceReportEntry {
  contractUri: vscode.Uri;
  contractLabel: string;
  target: string;
  result?: ValidationResult;
  error?: string;
  durationMs?: number;
}

interface WorkspaceReport {
  completedAt: Date;
  durationMs: number;
  selectedContracts: number;
  targets: number;
  entries: WorkspaceReportEntry[];
  valid: boolean;
}

type ExplorerNodeData =
  | { kind: "report"; report: WorkspaceReport }
  | { kind: "workspace"; folder: vscode.WorkspaceFolder }
  | { kind: "contract"; snapshot: ContractSnapshot }
  | { kind: "target"; target: ResolvedTarget }
  | { kind: "reportEntry"; entry: WorkspaceReportEntry }
  | { kind: "issue"; issue: ValidationIssue };

class CsvContractTreeItem extends vscode.TreeItem {
  public constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly data: ExplorerNodeData
  ) {
    super(label, collapsibleState);
  }
}

export function registerWorkspaceExplorer(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel
): WorkspaceExplorerProvider {
  const provider = new WorkspaceExplorerProvider(context, output);
  const treeView = vscode.window.createTreeView<CsvContractTreeItem>(explorerViewId, {
    treeDataProvider: provider,
    showCollapseAll: true
  });

  context.subscriptions.push(
    provider,
    treeView,
    treeView.onDidChangeCheckboxState((event) => provider.updateCheckboxes(event.items)),
    vscode.commands.registerCommand(openExplorerCommand, () =>
      vscode.commands.executeCommand(`workbench.view.extension.${explorerContainerId}`)
    ),
    vscode.commands.registerCommand(refreshExplorerCommand, () => provider.refresh()),
    vscode.commands.registerCommand(runSelectedCommand, () => provider.runSelected()),
    vscode.commands.registerCommand(showWorkspaceReportCommand, (argument?: WorkspaceReportEntry | CsvContractTreeItem) =>
      provider.showReport(argument)
    ),
    vscode.commands.registerCommand(openTargetInVsCodeCommand, (argument: ResolvedTarget | CsvContractTreeItem) =>
      openExplorerTarget(argument, openTargetInVsCode)
    ),
    vscode.commands.registerCommand(openTargetExternallyCommand, (argument: ResolvedTarget | CsvContractTreeItem) =>
      openExplorerTarget(argument, openTargetExternally)
    )
  );
  return provider;
}

export class WorkspaceExplorerProvider implements vscode.TreeDataProvider<CsvContractTreeItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<CsvContractTreeItem | undefined | void>();
  private readonly watchers: vscode.Disposable[] = [];
  private contractsPromise: Promise<ContractSnapshot[]> | undefined;
  private checked: Set<string>;
  private lastReport: WorkspaceReport | undefined;
  private reportPanel: vscode.WebviewPanel | undefined;

  public readonly onDidChangeTreeData = this.changed.event;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel
  ) {
    this.checked = new Set(context.workspaceState.get<string[]>(checkedContractsKey, []));
    const watcher = vscode.workspace.createFileSystemWatcher(contractPattern);
    const refresh = (): void => this.refresh();
    watcher.onDidCreate(refresh);
    watcher.onDidChange(refresh);
    watcher.onDidDelete(refresh);
    this.watchers.push(
      watcher,
      vscode.workspace.onDidChangeWorkspaceFolders(refresh)
    );
  }

  public dispose(): void {
    this.reportPanel?.dispose();
    this.changed.dispose();
    this.watchers.forEach((watcher) => watcher.dispose());
  }

  public refresh(): void {
    this.contractsPromise = undefined;
    this.changed.fire();
  }

  public getTreeItem(element: CsvContractTreeItem): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: CsvContractTreeItem): Promise<CsvContractTreeItem[]> {
    const contracts = await this.getContracts();
    if (!element) {
      const roots: CsvContractTreeItem[] = [];
      if (this.lastReport) roots.push(this.createReportNode(this.lastReport));
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        roots.push(this.createWorkspaceNode(folder, contracts.filter((contract) => contract.folder.uri.toString() === folder.uri.toString()).length));
      }
      return roots;
    }

    if (element.data.kind === "report") {
      return element.data.report.entries.map((entry) => this.createReportEntryNode(entry));
    }
    if (element.data.kind === "workspace") {
      const folder = element.data.folder;
      return contracts
        .filter((contract) => contract.folder.uri.toString() === folder.uri.toString())
        .map((contract) => this.createContractNode(contract));
    }
    if (element.data.kind === "contract") {
      return element.data.snapshot.targets.map((target) => this.createTargetNode(target));
    }
    if (element.data.kind === "reportEntry" && element.data.entry.result) {
      return element.data.entry.result.issues.map((issue) => this.createIssueNode(issue));
    }
    return [];
  }

  public async updateCheckboxes(
    items: readonly [CsvContractTreeItem, vscode.TreeItemCheckboxState][]
  ): Promise<void> {
    for (const [item, state] of items) {
      if (item.data.kind !== "contract") continue;
      const key = item.data.snapshot.uri.toString();
      if (state === vscode.TreeItemCheckboxState.Checked) this.checked.add(key);
      else this.checked.delete(key);
    }
    await this.context.workspaceState.update(checkedContractsKey, [...this.checked]);
    this.changed.fire();
  }

  public async runSelected(): Promise<void> {
    const contracts = (await this.getContracts()).filter((contract) => this.checked.has(contract.uri.toString()));
    if (contracts.length === 0) {
      void vscode.window.showWarningMessage("Check one or more CSV contracts in the Workspace Tests view first.");
      return;
    }

    const report = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Running ${contracts.length} selected CSV contract${contracts.length === 1 ? "" : "s"}`,
      cancellable: false
    }, async (progress) => this.executeContracts(contracts, progress));
    this.lastReport = report;
    this.writeReport(report);
    this.changed.fire();
    this.showReport();

    const summary = report.valid
      ? `All ${report.selectedContracts} selected CSV contracts passed across ${report.targets} target${report.targets === 1 ? "" : "s"}.`
      : `${report.entries.filter((entry) => !entry.result?.valid).length} of ${report.entries.length} contract-target runs failed.`;
    const action = report.valid
      ? await vscode.window.showInformationMessage(summary, "View report")
      : await vscode.window.showErrorMessage(summary, "View report");
    if (action === "View report") this.showReport();
  }

  public showReport(argument?: WorkspaceReportEntry | CsvContractTreeItem): void {
    if (!this.lastReport) {
      void vscode.window.showInformationMessage("Run selected CSV contracts to create a workspace report.");
      return;
    }
    const entry = argument instanceof CsvContractTreeItem
      ? argument.data.kind === "reportEntry" ? argument.data.entry : undefined
      : argument;
    const selectedEntryIndex = entry
      ? this.lastReport.entries.findIndex((candidate) =>
        candidate.contractUri.toString() === entry.contractUri.toString() && candidate.target === entry.target
      )
      : undefined;
    if (!this.reportPanel) {
      this.reportPanel = vscode.window.createWebviewPanel(
        "csv-contract-vsce.workspaceReport",
        "CSV Contract Test Report",
        vscode.ViewColumn.Active,
        {
          enableScripts: false,
          retainContextWhenHidden: true,
          localResourceRoots: [this.context.extensionUri]
        }
      );
      this.reportPanel.onDidDispose(() => {
        this.reportPanel = undefined;
      });
    } else {
      this.reportPanel.reveal(vscode.ViewColumn.Active);
    }
    const styleUri = this.reportPanel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "web", "webview.css")
    );
    this.reportPanel.webview.html = renderWorkspaceReportHtml(this.lastReport, {
      cspSource: this.reportPanel.webview.cspSource,
      styleUri: styleUri.toString(),
      selectedEntryIndex: selectedEntryIndex === -1 ? undefined : selectedEntryIndex
    });
  }

  private async executeContracts(
    snapshots: ContractSnapshot[],
    progress: vscode.Progress<{ message?: string; increment?: number }>
  ): Promise<WorkspaceReport> {
    const reportStartedAt = Date.now();
    const entries: WorkspaceReportEntry[] = [];
    const groups = new Map<string, TargetGroup>();

    for (const snapshot of snapshots) {
      try {
        const contract = parseContract(new TextDecoder().decode(await vscode.workspace.fs.readFile(snapshot.uri)));
        const targets = configuredTargets(snapshot.uri, contract);
        if (targets.length === 0) {
          entries.push({
            contractUri: snapshot.uri,
            contractLabel: snapshot.relativePath,
            target: "No configured target",
            error: "The contract has no configured path or URL target."
          });
          continue;
        }
        for (const target of targets) {
          const key = targetKey(target);
          const group = groups.get(key) ?? { target, contracts: [] };
          if (!group.contracts.some((candidate) => candidate.snapshot.uri.toString() === snapshot.uri.toString())) {
            group.contracts.push({ snapshot, contract });
          }
          groups.set(key, group);
        }
      } catch (error) {
        entries.push({
          contractUri: snapshot.uri,
          contractLabel: snapshot.relativePath,
          target: "Contract",
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const increment = groups.size > 0 ? 100 / groups.size : 100;
    for (const group of groups.values()) {
      progress.report({ message: group.target.label });
      const groupStartedAt = Date.now();
      try {
        const csvText = await readTargetText(group.target);
        const readDurationMs = Date.now() - groupStartedAt;
        let includeReadDuration = true;
        for (const prepared of group.contracts) {
          const validationStartedAt = Date.now();
          const result = validateCsv(prepared.contract, csvText);
          entries.push({
            contractUri: prepared.snapshot.uri,
            contractLabel: prepared.snapshot.relativePath,
            target: group.target.label,
            result,
            durationMs: Date.now() - validationStartedAt + (includeReadDuration ? readDurationMs : 0)
          });
          includeReadDuration = false;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const prepared of group.contracts) {
          entries.push({
            contractUri: prepared.snapshot.uri,
            contractLabel: prepared.snapshot.relativePath,
            target: group.target.label,
            error: message,
            durationMs: Date.now() - groupStartedAt
          });
        }
      }
      progress.report({ increment });
    }

    entries.sort((left, right) =>
      left.contractLabel.localeCompare(right.contractLabel) || left.target.localeCompare(right.target)
    );
    return {
      completedAt: new Date(),
      durationMs: Date.now() - reportStartedAt,
      selectedContracts: snapshots.length,
      targets: groups.size,
      entries,
      valid: entries.length > 0 && entries.every((entry) => entry.result?.valid === true)
    };
  }

  private writeReport(report: WorkspaceReport): void {
    this.output.clear();
    this.output.appendLine("CSV Contract Workspace Report");
    this.output.appendLine(`${report.valid ? "PASS" : "FAIL"} · ${report.selectedContracts} contracts · ${report.targets} targets · ${report.entries.length} runs`);
    this.output.appendLine(`Completed ${report.completedAt.toLocaleString()}`);
    this.output.appendLine("");
    for (const entry of report.entries) {
      const valid = entry.result?.valid === true;
      this.output.appendLine(`${valid ? "PASS" : "FAIL"} ${entry.contractLabel}`);
      this.output.appendLine(`  Target: ${entry.target}`);
      if (entry.error) {
        this.output.appendLine(`  ERROR: ${entry.error}`);
      } else if (entry.result) {
        this.output.appendLine(`  ${entry.result.rowCount.toLocaleString()} rows · ${entry.result.columnCount} columns · ${entry.result.issueCount.toLocaleString()} issues`);
        for (const issue of entry.result.issues) {
          const location = [issue.column, issue.row ? `record ${issue.row}` : undefined, issue.testId].filter(Boolean).join(" · ");
          this.output.appendLine(`    ${issue.code}${location ? ` [${location}]` : ""}: ${issue.message}`);
        }
      }
      this.output.appendLine("");
    }
  }

  private async getContracts(): Promise<ContractSnapshot[]> {
    this.contractsPromise ??= this.buildContracts();
    return this.contractsPromise;
  }

  private async buildContracts(): Promise<ContractSnapshot[]> {
    const snapshots: ContractSnapshot[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, contractPattern),
        contractExclude
      );
      for (const uri of uris) {
        const relativePath = uri.path.slice(folder.uri.path.length).replace(/^\/+/, "");
        try {
          const contract = parseContract(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)));
          const targets = configuredTargets(uri, contract);
          snapshots.push({ uri, folder, relativePath, targetCount: targets.length, targets });
        } catch (error) {
          snapshots.push({
            uri,
            folder,
            relativePath,
            targetCount: 0,
            targets: [],
            parseError: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }
    const existing = new Set(snapshots.map((snapshot) => snapshot.uri.toString()));
    const selectedChanged = [...this.checked].some((key) => !existing.has(key));
    if (selectedChanged) {
      this.checked = new Set([...this.checked].filter((key) => existing.has(key)));
      await this.context.workspaceState.update(checkedContractsKey, [...this.checked]);
    }
    return snapshots.sort((left, right) =>
      left.folder.name.localeCompare(right.folder.name) || left.relativePath.localeCompare(right.relativePath)
    );
  }

  private createReportNode(report: WorkspaceReport): CsvContractTreeItem {
    const item = new CsvContractTreeItem(
      report.valid ? "Last run passed" : "Last run failed",
      vscode.TreeItemCollapsibleState.Expanded,
      { kind: "report", report }
    );
    item.description = `${report.entries.filter((entry) => entry.result?.valid).length}/${report.entries.length} runs`;
    item.iconPath = new vscode.ThemeIcon(report.valid ? "pass" : "error", new vscode.ThemeColor(report.valid ? "testing.iconPassed" : "testing.iconFailed"));
    item.contextValue = "csvContractReport";
    item.tooltip = "Open the complete workspace test report.";
    item.command = {
      command: showWorkspaceReportCommand,
      title: "Open CSV Contract Test Report",
      arguments: [item]
    };
    return item;
  }

  private createWorkspaceNode(folder: vscode.WorkspaceFolder, contractCount: number): CsvContractTreeItem {
    const item = new CsvContractTreeItem(
      folder.name,
      vscode.TreeItemCollapsibleState.Expanded,
      { kind: "workspace", folder }
    );
    item.description = `${contractCount} contract${contractCount === 1 ? "" : "s"}`;
    item.iconPath = vscode.ThemeIcon.Folder;
    return item;
  }

  private createContractNode(snapshot: ContractSnapshot): CsvContractTreeItem {
    const label = snapshot.relativePath.split("/").pop() ?? snapshot.relativePath;
    const item = new CsvContractTreeItem(
      label,
      snapshot.targets.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
      { kind: "contract", snapshot }
    );
    const reportEntries = this.lastReport?.entries.filter((entry) => entry.contractUri.toString() === snapshot.uri.toString()) ?? [];
    const failed = reportEntries.some((entry) => entry.result?.valid !== true);
    const passed = reportEntries.length > 0 && !failed;
    item.description = [
      snapshot.relativePath.includes("/") ? snapshot.relativePath.slice(0, snapshot.relativePath.lastIndexOf("/")) : undefined,
      snapshot.parseError ? "invalid" : `${snapshot.targetCount} target${snapshot.targetCount === 1 ? "" : "s"}`
    ].filter(Boolean).join(" · ");
    item.tooltip = snapshot.parseError
      ? `${snapshot.relativePath}\n${snapshot.parseError}`
      : `${snapshot.relativePath}\n${snapshot.targetCount} configured target${snapshot.targetCount === 1 ? "" : "s"}`;
    item.resourceUri = snapshot.uri;
    item.checkboxState = this.checked.has(snapshot.uri.toString())
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
    item.iconPath = new vscode.ThemeIcon(snapshot.parseError || failed ? "error" : passed ? "pass" : "beaker");
    item.contextValue = "csvContract";
    item.command = {
      command: "csv-contract-vsce.openWorkbench",
      title: "Open CSV Contract Workbench",
      arguments: [snapshot.uri]
    };
    return item;
  }

  private createTargetNode(target: ResolvedTarget): CsvContractTreeItem {
    const isUrl = typeof target.source === "string";
    const label = targetLabel(target);
    const item = new CsvContractTreeItem(label, vscode.TreeItemCollapsibleState.None, { kind: "target", target });
    item.description = isUrl ? "URL" : "File";
    item.tooltip = `${target.label}\nClick to open in VS Code.`;
    item.iconPath = new vscode.ThemeIcon(isUrl ? "link" : "file");
    item.contextValue = "csvContractTarget";
    item.command = {
      command: openTargetInVsCodeCommand,
      title: "Open Target in VS Code",
      arguments: [target]
    };
    return item;
  }

  private createReportEntryNode(entry: WorkspaceReportEntry): CsvContractTreeItem {
    const valid = entry.result?.valid === true;
    const item = new CsvContractTreeItem(
      entry.contractLabel.split("/").pop() ?? entry.contractLabel,
      entry.result?.issues.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
      { kind: "reportEntry", entry }
    );
    item.description = entry.error ?? `${entry.target} · ${entry.result?.issueCount ?? 0} issues`;
    item.tooltip = `${valid ? "PASS" : "FAIL"} ${entry.contractLabel}\nTarget: ${entry.target}${entry.error ? `\n${entry.error}` : ""}`;
    item.iconPath = new vscode.ThemeIcon(valid ? "pass" : "error", new vscode.ThemeColor(valid ? "testing.iconPassed" : "testing.iconFailed"));
    item.command = {
      command: showWorkspaceReportCommand,
      title: "Open Run Result",
      arguments: [entry]
    };
    return item;
  }

  private createIssueNode(issue: ValidationIssue): CsvContractTreeItem {
    const item = new CsvContractTreeItem(issue.code, vscode.TreeItemCollapsibleState.None, { kind: "issue", issue });
    item.description = issue.message;
    item.tooltip = issue.message;
    item.iconPath = new vscode.ThemeIcon("error", new vscode.ThemeColor("testing.iconFailed"));
    return item;
  }
}

async function openExplorerTarget(
  argument: ResolvedTarget | CsvContractTreeItem,
  opener: (target: ResolvedTarget) => Promise<void>
): Promise<void> {
  const target = argument instanceof CsvContractTreeItem && argument.data.kind === "target"
    ? argument.data.target
    : argument as ResolvedTarget;
  if (!target?.source) {
    void vscode.window.showWarningMessage("That CSV target is no longer available.");
    return;
  }
  try {
    await opener(target);
  } catch (error) {
    void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
  }
}

function targetLabel(target: ResolvedTarget): string {
  if (typeof target.source === "string") {
    const parsed = new URL(target.source);
    return parsed.pathname.split("/").filter(Boolean).pop() ?? parsed.hostname;
  }
  return target.label.split(/[\\/]/).filter(Boolean).pop() ?? target.label;
}

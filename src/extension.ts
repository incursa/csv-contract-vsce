import { LiveTests } from "./core/live-tests";
import { DependencyWatchers } from "./vscode-dependencies";
import type { CrossExecutor } from "./core/cross-checks";
import { insertTemplate, parseTemplate } from "./core/authoring";
import { manageHistory } from "./vscode-history";
import { filterResultRuns } from "./results-view";
import { errorDetails } from "./core/error-details";
import { effectiveContract, parseSuite, runSuite, type SuiteRun } from "./core/suite";
import { editBaseline, type SqlSchemaReader } from "./vscode-baselines";
import { preflight } from "./core/preflight";
import { previewContract } from "./core/preview";
import { resolveBaseline } from "./core/baseline";
import { readEditorContract, ruleOffset, updateEditorContract } from "./core/editor-document";
import { isSuiteText } from "./core/suite";
import { editSuiteConnection, vscodeSuiteIO, registerSuiteDiagnostics, resolveSuiteEditor, showSuiteRun, showSuiteSql } from "./vscode-suites";
import * as vscode from "vscode";
import { createContractFromCsv, parseContract, serializeContract, validateCsv } from "./core/contract";
import type { CsvContract, SqlServerObjectInfo, SqlServerTableTarget, ValidationResult } from "./core/model";
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
import { registerSemanticComparison } from "./vscode-comparison";
import type { DesktopComparisonRunner } from "./vscode-comparison";
import { generateSqlServerValidation } from "./core/sql-server-generator";
import { mergeImportedSchema, parseSqlSchemaSource, type ImportedSqlTable } from "./core/sql-schema-import";
import { hasSqlServerConnection, resolveSqlServerTargets, sqlServerTargetLabel, type ResolvedSqlServerTarget } from "./core/sql-server-targets";
import { suggestSqlColumnMappings } from "./core/sql-server-column-mapping";
import { issueRunsToCsv, validationRunExportJson } from "./issue-export";

const viewType = "csv-contract-vsce.contractEditor";

interface TargetRun {
  target: string;
  result?: ValidationResult;
  status?: string;
  error?: string;
}

export type DesktopSqlServerRunner = (contract: CsvContract, target: ResolvedSqlServerTarget, signal?: AbortSignal) => Promise<ValidationResult>;
export type DesktopSqlServerBrowser = (profile: string) => Promise<SqlServerObjectInfo[]>;

const sqlConnectionProfilesKey = "csvContract.sqlServer.connectionProfiles";
const sqlConnectionSecretPrefix = "csvContract.sqlServer.connection.";
export const sqlConnectionSecretKey = (profile: string): string => `${sqlConnectionSecretPrefix}${profile}`;

export function activate(
  context: vscode.ExtensionContext,
  desktopComparisonRunner?: DesktopComparisonRunner,
  sqlServerRunner?: DesktopSqlServerRunner,
  sqlServerBrowser?: DesktopSqlServerBrowser,
  sqlSchemaReader?: SqlSchemaReader,
  crossExecutor?: CrossExecutor
): { testHooks?: ContractEditorProvider } {
  const output = vscode.window.createOutputChannel("CSV Contract");
  const provider = new ContractEditorProvider(context, sqlServerRunner, sqlServerBrowser, sqlSchemaReader, crossExecutor);
  registerTargetContentProvider(context);
  registerSuiteDiagnostics(context);
  context.subscriptions.push(
    output,
    vscode.window.registerCustomEditorProvider(viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false
    }),
    vscode.commands.registerCommand("csv-contract-vsce.createFromCsv", () => createFromCsv()),
    vscode.commands.registerCommand("csv-contract-vsce.runContract", () => runContract(output, sqlServerRunner, context, crossExecutor)),
    vscode.commands.registerCommand("csv-contract-vsce.openWorkbench", (uri?: vscode.Uri) => openWorkbench(uri)),
    vscode.commands.registerCommand("csv-contract-vsce.generateSqlServerValidation", (uri?: vscode.Uri) => generateSqlServerScript(uri)),
    vscode.commands.registerCommand("csv-contract-vsce.importSqlServerSchema", (uri?: vscode.Uri) => importSqlServerSchema(uri)),
    vscode.commands.registerCommand("csv-contract-vsce.configureSqlServerConnection", () => configureSqlServerConnection(context)),
    vscode.commands.registerCommand("csv-contract-vsce.forgetSqlServerConnection", () => forgetSqlServerConnection(context)),
    vscode.commands.registerCommand("csv-contract-vsce.addSqlServerTarget", (uri?: vscode.Uri) => addSqlServerTarget(context, uri, sqlServerBrowser))
  );
  registerWorkspaceExplorer(context, output, sqlServerRunner, crossExecutor);
  registerSemanticComparison(context, desktopComparisonRunner);
  return context.extensionMode === vscode.ExtensionMode.Test ? { testHooks: provider } : {};
}

async function chooseImportedTable(tables: ImportedSqlTable[]): Promise<ImportedSqlTable | undefined> {
  if (tables.length === 1) return tables[0];
  return (await vscode.window.showQuickPick(tables.map((table) => ({
    label: `${table.schema}.${table.table}`,
    description: `${table.columns.length} columns`,
    detail: table.sourceKind,
    table
  })), { title: "Select SQL Server staging table", placeHolder: "Choose the table to import" }))?.table;
}

function safeContractFilename(table: string): string {
  const safe = [...table].map((character) => character.charCodeAt(0) < 32 ? "-" : character)
    .join("").replace(/[<>:"/\\|?*]/g, "-").replace(/[ .]+$/g, "").trim();
  return `${safe || "staging-table"}.csvtest.yaml`;
}

async function replaceTextDocument(document: vscode.TextDocument, text: string): Promise<void> {
  const last = document.lineAt(document.lineCount - 1);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, new vscode.Range(new vscode.Position(0, 0), last.range.end), text);
  if (!await vscode.workspace.applyEdit(edit)) throw new Error("VS Code could not apply the schema import to the contract.");
}

interface EditorBinding { read(): CsvContract; write(c: CsvContract): Promise<void> }
async function importSqlServerSchema(requestedUri?: vscode.Uri, binding?: EditorBinding): Promise<void> {
  const sourceUri = await pickFile({
    "SQL Server table schema": ["sql", "json"],
    "All files": ["*"]
  });
  if (!sourceUri) return;
  try {
    const sourceText = new TextDecoder("utf-8").decode(await vscode.workspace.fs.readFile(sourceUri));
    const extension = /\.[^./]+$/.exec(sourceUri.path)?.[0] ?? "";
    const table = await chooseImportedTable(parseSqlSchemaSource(sourceText, extension));
    if (!table) return;
    if (binding) {
      const original = binding.read();
      const merged = mergeImportedSchema(original, table);
      const preview = await vscode.workspace.openTextDocument({ language: "yaml", content: serializeContract(merged.contract) });
      await vscode.window.showTextDocument(preview, { viewColumn: vscode.ViewColumn.Beside });
      if (await vscode.window.showInformationMessage("Apply reviewed schema import?", { modal: true, detail: JSON.stringify(merged.preview) }, "Apply") !== "Apply") return;
      if (JSON.stringify(binding.read()) !== JSON.stringify(original)) throw new Error("Contract changed while reviewing import.");
      await binding.write(merged.contract);
      return;
    }

    const active = vscode.window.activeTextEditor?.document.uri;
    let contractUri = requestedUri?.path.match(/\.csvtest\.ya?ml$/i) ? requestedUri
      : active?.path.match(/\.csvtest\.ya?ml$/i) ? active : undefined;
    let contract: CsvContract;
    let existingDocument: vscode.TextDocument | undefined;
    if (!contractUri) {
      const action = await vscode.window.showQuickPick([
        { label: "Create a new contract", description: `Start from ${table.schema}.${table.table}`, create: true },
        { label: "Update an existing contract", description: "Merge without replacing reviewed rules", create: false }
      ], { title: "Import SQL Server table schema", placeHolder: "Choose where to apply the imported schema" });
      if (!action) return;
      if (!action.create) contractUri = await pickFile({ "CSV contracts": ["csvtest.yaml", "csvtest.yml", "yaml", "yml"] });
    }
    if (contractUri) {
      existingDocument = await vscode.workspace.openTextDocument(contractUri);
      contract = parseContract(existingDocument.getText());
    } else {
      contract = { version: 1, schema: { allowAdditionalColumns: true, columns: {} } };
    }

    const merged = mergeImportedSchema(contract, table);
    const details = [
      `Source: ${table.sourceKind}`,
      `Table: ${table.schema}.${table.table}`,
      `Columns: ${table.columns.length}`,
      `Add: ${merged.preview.addedColumns.length}; already declared: ${merged.preview.existingColumns.length}; contract-only preserved: ${merged.preview.contractOnlyColumns.length}`,
      `Technical constraints inferred: ${merged.preview.inferredConstraints.length}; reviewed conflicts preserved: ${merged.preview.preservedConflicts.length}`,
      merged.preview.targetChanged ? "The SQL target will change; existing scope, detail, and conditional-rule settings remain preserved." : "SQL target identity is unchanged.",
      merged.preview.identityInitialized ? `Composite identity initialized from primary key: ${table.primaryKeyColumns.join(", ")}` : "Existing identity preserved.",
      merged.preview.preservedConflicts.length ? `Preserved conflicts: ${merged.preview.preservedConflicts.slice(0, 10).join(", ")}` : "No reviewed constraint conflicts."
    ].join("\n");
    const confirmation = await vscode.window.showInformationMessage(
      `Import schema for ${table.schema}.${table.table}?`,
      { modal: true, detail: details },
      "Import Schema"
    );
    if (confirmation !== "Import Schema") return;

    if (!contractUri) {
      contractUri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.joinPath(sourceUri, "..", safeContractFilename(table.table)),
        filters: { "CSV contract": ["csvtest.yaml"] },
        title: "Save imported staging contract"
      });
      if (!contractUri) return;
    }
    const schemaUrl = "https://raw.githubusercontent.com/incursa/csv-contract-vsce/main/schemas/csvtest.schema.json";
    const serialized = serializeContract(merged.contract, schemaUrl);
    if (existingDocument) await replaceTextDocument(existingDocument, serialized);
    else await vscode.workspace.fs.writeFile(contractUri, new TextEncoder().encode(serialized));
    await vscode.commands.executeCommand("vscode.openWith", contractUri, viewType);
    void vscode.window.showInformationMessage(`Imported ${table.columns.length} columns from ${table.schema}.${table.table}. Reviewed rules were preserved.`);
  } catch (error) {
    void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
  }
}

async function generateSqlServerScript(requestedUri?: vscode.Uri): Promise<void> {
  const active = vscode.window.activeTextEditor?.document.uri;
  const specUri = requestedUri?.path.match(/\.(?:csvtest|csvsuite)\.ya?ml$/i)
    ? requestedUri
    : active?.path.match(/\.(?:csvtest|csvsuite)\.ya?ml$/i)
      ? active
      : await pickFile({ "CSV contracts": ["csvtest.yaml", "csvtest.yml", "yaml", "yml"] });
  if (!specUri) return;
  try {
    const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(specUri));
    if (isSuiteText(text)) { await showSuiteSql(specUri); return; }
    const contract = parseContract(text);
    const sqlTargets = resolveSqlServerTargets(contract, false);
    const target = sqlTargets.length === 1 ? sqlTargets[0] : (await vscode.window.showQuickPick(
      sqlTargets.map((candidate) => ({
        label: candidate.name ?? `${candidate.schema}.${candidate.table}`,
        description: candidate.connection || "standalone script",
        target: candidate
      })),
      { title: "Generate SQL Server validation", placeHolder: "Choose the table for this script" }
    ))?.target;
    if (!target) return;
    const generated = generateSqlServerValidation(contract, { target });
    const filename = (specUri.path.split("/").pop() ?? "staging.csvtest.yaml").replace(/\.(?:csvtest|csvsuite)\.ya?ml$/i, ".validation.sql");
    const outputUri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(specUri, "..", filename),
      filters: { "SQL Server validation script": ["sql"] },
      title: `Generate ${generated.ruleCount} SQL validation rules`
    });
    if (!outputUri) return;
    await vscode.workspace.fs.writeFile(outputUri, new TextEncoder().encode(generated.sql));
    const document = await vscode.workspace.openTextDocument(outputUri);
    await vscode.window.showTextDocument(document, { preview: false });
    const warningSuffix = generated.warnings.length ? ` ${generated.warnings.length} translation warning(s) were added as SQL comments.` : "";
    void vscode.window.showInformationMessage(`Generated ${generated.ruleCount} staging validation rules.${warningSuffix}`);
  } catch (error) {
    void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
  }
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

async function runContract(output: vscode.OutputChannel, sqlServerRunner?: DesktopSqlServerRunner, context?: vscode.ExtensionContext, crossExecutor?: CrossExecutor): Promise<void> {
  const specUri = await pickFile({ "CSV contracts": ["csvtest.yaml", "csvtest.yml", "yaml", "yml"] });
  if (!specUri) return;
  const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(specUri));
  if (isSuiteText(text) && context) { await showSuiteRun(context, specUri, sqlServerRunner, crossExecutor); return; }
  const contract = await resolveBaseline(parseContract(text), specUri.toString(), vscodeSuiteIO);
  let targets = configuredTargets(specUri, contract);
  const sqlTargets = resolveSqlServerTargets(contract, false).filter(hasSqlServerConnection);
  if (targets.length === 0 && sqlTargets.length === 0) {
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
    output.appendLine(`${result.rowCount} rows · ${result.columnCount} columns · ${result.errorCount} errors · ${result.warningCount} warnings`);
    result.issues.forEach((issue) => output.appendLine(`${(issue.severity ?? "error").toUpperCase()} ${issue.code}: ${issue.message}`));
    output.appendLine("");
  }
  for (const target of sqlTargets) {
    if (!sqlServerRunner) throw new Error("Direct SQL Server validation requires the desktop extension host.");
    const result = await sqlServerRunner(contract, target);
    valid &&= result.valid;
    output.appendLine(`${result.valid ? "PASS" : "FAIL"} ${sqlServerTargetLabel(target)}`);
    output.appendLine(`${result.rowCount} rows · ${result.columnCount} columns · ${result.errorCount} errors · ${result.warningCount} warnings`);
    result.issues.forEach((issue) => output.appendLine(`${(issue.severity ?? "error").toUpperCase()} ${issue.code}: ${issue.message}`));
    output.appendLine("");
  }
  output.show(true);
  void vscode.window.showInformationMessage(
    valid ? `CSV contract passed for ${targets.length + sqlTargets.length} target(s).` : "CSV contract failed. See the CSV Contract output channel."
  );
}

async function configureSqlServerConnection(context: vscode.ExtensionContext): Promise<string | undefined> {
  const profile = await vscode.window.showInputBox({
    title: "Configure SQL Server connection",
    prompt: "Connection profile name referenced by sqlServer.connection or sqlServer.targets[].connection.",
    placeHolder: "warehouse-readonly",
    validateInput: (value) => /^[A-Za-z0-9._-]+$/.test(value) ? undefined : "Use letters, numbers, dots, underscores, or hyphens."
  });
  if (!profile) return undefined;
  const connectionString = await vscode.window.showInputBox({
    title: `SQL Server connection: ${profile}`,
    prompt: "Stored in VS Code Secret Storage. Use a login with SELECT-only permissions.",
    password: true,
    ignoreFocusOut: true,
    placeHolder: "Server=...;Database=...;User Id=...;Password=...;Encrypt=true"
  });
  if (!connectionString) return undefined;
  await context.secrets.store(sqlConnectionSecretKey(profile), connectionString);
  const profiles = new Set(context.globalState.get<string[]>(sqlConnectionProfilesKey, []));
  profiles.add(profile);
  await context.globalState.update(sqlConnectionProfilesKey, [...profiles].sort());
  void vscode.window.showInformationMessage(`Stored SQL Server connection profile '${profile}' in Secret Storage.`);
  return profile;
}

async function forgetSqlServerConnection(context: vscode.ExtensionContext): Promise<void> {
  const profiles = context.globalState.get<string[]>(sqlConnectionProfilesKey, []);
  const profile = await vscode.window.showQuickPick(profiles, { title: "Forget SQL Server connection", placeHolder: "Choose a secret-backed profile to remove" });
  if (!profile) return;
  await context.secrets.delete(sqlConnectionSecretKey(profile));
  await context.globalState.update(sqlConnectionProfilesKey, profiles.filter((candidate) => candidate !== profile));
  void vscode.window.showInformationMessage(`Forgot SQL Server connection profile '${profile}'.`);
}

async function chooseSqlConnectionProfile(context: vscode.ExtensionContext): Promise<string | undefined> {
  const profiles = context.globalState.get<string[]>(sqlConnectionProfilesKey, []);
  const configureLabel = "$(add) Configure a new connection";
  const selected = await vscode.window.showQuickPick([...profiles, configureLabel], {
    title: "Add SQL Server table or view",
    placeHolder: profiles.length ? "Choose a read-only connection profile" : "Configure a connection profile first"
  });
  if (!selected) return undefined;
  return selected === configureLabel ? configureSqlServerConnection(context) : selected;
}

function addConfiguredSqlTarget(contract: CsvContract, target: SqlServerTableTarget): void {
  const config = contract.sqlServer ??= {};
  if (config.targets?.length) {
    const existing = config.targets.findIndex((candidate) =>
      candidate.connection === target.connection &&
      JSON.stringify(candidate.integratedConnection) === JSON.stringify(target.integratedConnection) &&
      candidate.schema === target.schema && candidate.table === target.table
    );
    if (existing >= 0) config.targets[existing] = target;
    else config.targets.push(target);
    return;
  }
  if (!config.schema || !config.table || (config.schema === target.schema && config.table === target.table)) {
    config.connection = target.connection;
    config.integratedConnection = target.integratedConnection;
    config.schema = target.schema;
    config.table = target.table;
    config.objectType = target.objectType;
    config.columnMap = target.columnMap;
    return;
  }
  const previous: SqlServerTableTarget = {
    connection: config.connection,
    integratedConnection: config.integratedConnection,
    schema: config.schema,
    table: config.table,
    objectType: config.objectType,
    columnMap: config.columnMap
  };
  config.targets = [previous, target];
  delete config.connection;
  delete config.integratedConnection;
  delete config.schema;
  delete config.table;
  delete config.objectType;
  delete config.columnMap;
}

async function addSqlServerTarget(
  context: vscode.ExtensionContext,
  requestedUri: vscode.Uri | undefined,
  sqlServerBrowser: DesktopSqlServerBrowser | undefined,
  binding?: EditorBinding
): Promise<void> {
  if (!sqlServerBrowser) {
    void vscode.window.showErrorMessage("Browsing SQL Server tables and views requires the desktop extension host.");
    return;
  }
  const active = vscode.window.activeTextEditor?.document.uri;
  const specUri = binding ? requestedUri : requestedUri?.path.match(/\.csvtest\.ya?ml$/i) ? requestedUri
    : active?.path.match(/\.csvtest\.ya?ml$/i) ? active
      : await pickFile({ "CSV contracts": ["csvtest.yaml", "csvtest.yml", "yaml", "yml"] });
  if (!specUri) return;
  try {
    const document = await vscode.workspace.openTextDocument(specUri);
    const contract = binding?.read() ?? parseContract(document.getText());
    const original = JSON.stringify(contract);
    const profile = await chooseSqlConnectionProfile(context);
    if (!profile) return;
    const objects = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Reading tables and views from ${profile}`,
      cancellable: false
    }, () => sqlServerBrowser(profile));
    if (objects.length === 0) throw new Error(`Connection profile '${profile}' did not expose any tables or views.`);
    const selected = (await vscode.window.showQuickPick(objects.map((object) => ({
      label: `${object.schema}.${object.name}`,
      description: object.objectType === "view" ? "View" : "Table",
      detail: `${object.columns.length} columns`,
      object
    })), {
      title: `Add SQL Server table or view · ${profile}`,
      placeHolder: "Choose a table or view"
    }))?.object;
    if (!selected) return;
    const suggestion = suggestSqlColumnMappings(Object.keys(contract.schema.columns), selected.columns);
    const nonExact = suggestion.matches.filter((match) => match.method !== "exact");
    const detail = [
      `Connection: ${profile}`,
      `Object: ${selected.schema}.${selected.name} (${selected.objectType})`,
      `Columns: ${selected.columns.length}; exact matches: ${suggestion.matches.length - nonExact.length}`,
      nonExact.length ? `Suggested mappings:\n${nonExact.slice(0, 20).map((match) => `  ${match.contractColumn} → ${match.physicalColumn}`).join("\n")}` : "No non-exact mappings are needed.",
      suggestion.unmatched.length ? `Unmatched contract columns: ${suggestion.unmatched.join(", ")}` : "All contract columns matched.",
      suggestion.ambiguous.length ? `Ambiguous contract columns (not mapped): ${suggestion.ambiguous.join(", ")}` : undefined
    ].filter((line): line is string => line !== undefined).join("\n\n");
    const confirmation = await vscode.window.showInformationMessage(
      `Add ${selected.schema}.${selected.name} as a contract target?`,
      { modal: true, detail },
      "Add Target"
    );
    if (confirmation !== "Add Target") return;
    addConfiguredSqlTarget(contract, {
      connection: profile,
      schema: selected.schema,
      table: selected.name,
      objectType: selected.objectType,
      columnMap: Object.keys(suggestion.columnMap).length ? suggestion.columnMap : undefined
    });
    if (binding) {
      if (JSON.stringify(binding.read()) !== original) throw new Error("Contract changed while browsing SQL targets.");
      await binding.write(contract);
    } else await replaceTextDocument(document, updateEditorContract(document.getText(), contract));
    void vscode.window.showInformationMessage(`Added ${selected.objectType} ${selected.schema}.${selected.name} using '${profile}'.`);
  } catch (error) {
    void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
  }
}

async function openWorkbench(requestedUri?: vscode.Uri): Promise<void> {
  if (/\.csvsuite\.ya?ml$/i.test((requestedUri ?? vscode.window.activeTextEditor?.document.uri)?.path ?? "")) {
    await vscode.commands.executeCommand("vscode.openWith", requestedUri ?? vscode.window.activeTextEditor!.document.uri, viewType);
    return;
  }
  if (requestedUri?.path.match(/\.csvtest\.ya?ml$/i)) {
    await vscode.commands.executeCommand("vscode.openWith", requestedUri, viewType);
    return;
  }
  const active = vscode.window.activeTextEditor?.document.uri;
  const uri = active?.path.match(/\.csvtest\.ya?ml$/i)
    ? active
    : await pickFile({ "CSV contracts and suites": ["csvtest.yaml", "csvtest.yml", "csvsuite.yaml", "csvsuite.yml"] });
  if (uri) await vscode.commands.executeCommand("vscode.openWith", uri, viewType);
}

class ContractEditorProvider implements vscode.CustomTextEditorProvider {
  public readonly testActions = new Map<string, (message: any) => Promise<void>>();
  public readonly testStates = new Map<string, { runs: TargetRun[]; stale: boolean; live: boolean; completedRuns: number }>();
  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly sqlServerRunner?: DesktopSqlServerRunner,
    private readonly sqlServerBrowser?: DesktopSqlServerBrowser,
    private readonly sqlSchemaReader?: SqlSchemaReader,
    private readonly crossExecutor?: CrossExecutor
  ) {}

  public async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    if (/\.csvsuite\.ya?ml$/i.test(document.uri.path) || isSuiteText(document.getText())) {
      await resolveSuiteEditor(document, panel, this.sqlServerRunner, async (memberId) => {
        const child = vscode.window.createWebviewPanel(viewType, memberId, vscode.ViewColumn.Beside, {});
        const member = parseSuite(document.getText()).members.find(m => m.id === memberId)!;
        if (member.ref) await this.resolveContractEditor(await vscode.workspace.openTextDocument(vscode.Uri.parse(vscodeSuiteIO.resolve(document.uri.toString(), member.ref))), child, undefined, document);
        else await this.resolveContractEditor(document, child, memberId);
      }, this.context, this.crossExecutor, this.sqlSchemaReader);
      return;
    }
    await this.resolveContractEditor(document, panel);
  }

  public async resolveContractEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel, memberId?: string, suiteContext?: vscode.TextDocument): Promise<void> {
    const read = () => readEditorContract(document.getText(), memberId);
    const effective = (contract: CsvContract) => effectiveContract(contract, suiteContext ? parseSuite(suiteContext.getText()).defaults : memberId ? parseSuite(document.getText()).defaults : undefined);
    const write = (contract: CsvContract) => this.replaceDocument(document, updateEditorContract(document.getText(), contract, memberId));
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri]
    };
    panel.webview.html = this.html(panel.webview);
    let manualTargets: ResolvedTarget[] | undefined;
    let latestRuns: TargetRun[] = [];
    let stale = false;
    let runNotice = "";
    let previewRule: string | undefined;
    let completedRuns = 0;
    let watchInputs = false;
    let consecutiveErrors = 0;
    const scheduler = new LiveTests<{ contract: CsvContract; preview?: string; targets?: ResolvedTarget[] }, SuiteRun[]>(async (draft, signal) => {
      let contract = await resolveBaseline(draft.contract, document.uri.toString(), vscodeSuiteIO);
      let files = draft.targets ?? configuredTargets(document.uri, contract);
      let sqlTargets = resolveSqlServerTargets(contract, false);
      if (draft.preview) {
        contract = previewContract(contract, draft.preview);
        const target = await vscode.window.showQuickPick([
          ...files.map((t, index) => ({ label: t.label, sourceKind: "csv", index })),
          ...sqlTargets.map((t, index) => ({ label: sqlServerTargetLabel(t), sourceKind: "sql", index }))
        ], { title: `Run full-scope preview: ${draft.preview}`, placeHolder: "Executes the current draft against one selected source. Regex/date SQL predicates may read the full scope into the client." });
        if (!target) {
          runNotice = "Preview canceled before execution.";
          return [{ suite: document.uri.toString(), spec: document.uri.toString(), member: memberId ?? "contract", status: "CANCELED", error: runNotice }];
        }
        files = target.sourceKind === "csv" ? [files[target.index]] : [];
        sqlTargets = target.sourceKind === "sql" ? [sqlTargets[target.index]] : [];
      }
      if (!files.length && !sqlTargets.length) throw new Error("No targets configured. Choose a CSV or configure a SQL target.");
      contract = { ...contract, targets: files.map((_, index) => ({ path: String(index) })),
        sqlServer: sqlTargets.length ? { ...contract.sqlServer, table: undefined, targets: sqlTargets } : undefined };
      let completed = 0;
      runNotice = `${draft.preview ? `Full-scope preview: ${draft.preview}` : "Full validation"} · ${new Date().toISOString()}`;
      await panel.webview.postMessage({ type: "runState", running: true, total: files.length + sqlTargets.length });
      try {
        const report = await runSuite({ id: document.uri.toString(), source: document.uri.toString(), isSuite: false,
          members: [{ id: memberId ?? "contract", source: document.uri.toString(), contract }] }, async (c, target) => {
          if (!this.sqlServerRunner) throw new Error("SQL execution requires the desktop extension host.");
          return this.sqlServerRunner(c, target, signal);
        }, false, async (c, _source, target) => validateCsv(c, await readTargetText(files[Number(target.path)])), {
          signal, onProgress: run => { completed++; void panel.webview.postMessage({ type: "runState", running: true, target: run.table ?? files[Number(run.target)]?.label, index: completed, total: files.length + sqlTargets.length }); }
        });
        return report.runs.map(run => ({ ...run, target: run.table ?? files[Number(run.target)]?.label ?? run.target }));
      } finally { await panel.webview.postMessage({ type: "runState", running: false }); }
    }, (runs) => { completedRuns++; stale = false; latestRuns = runs.map(r => ({ ...r, target: r.target ?? r.member }));
      consecutiveErrors = runs.some(r => r.status === "ERROR") ? consecutiveErrors + 1 : 0;
      if (consecutiveErrors >= 3) { scheduler.pause(); runNotice += " · Live tests paused after three consecutive execution errors."; }
      void postState(); },
    error => { runNotice = `Execution error: ${errorDetails(error)}`; stale = true; void postState(); });
    const refreshRevision = (): void => {
      stale = latestRuns.length > 0;
      try { const contract = effective(read()); scheduler.change({ key: JSON.stringify([contract, manualTargets?.map(t => t.label), previewRule]), value: { contract, preview: previewRule, targets: manualTargets } }); }
      catch { scheduler.change(); }
    };

    const postState = async (runs?: TargetRun[]): Promise<void> => {
      if (runs) latestRuns = runs;
      if (this.context.extensionMode === vscode.ExtensionMode.Test) this.testStates.set(`${document.uri.toString()}#${memberId ?? ""}`, { runs: latestRuns, stale, live: scheduler.enabled, completedRuns });
      try {
        const contract = read();
        const savedTargets = configuredTargets(document.uri, contract);
        const activeTargets = manualTargets ?? savedTargets;
        const dependencies = [document.uri.toString(), ...(suiteContext ? [suiteContext.uri.toString()] : [])];
        if (contract.baseline && "ref" in contract.baseline) dependencies.push(vscodeSuiteIO.resolve(document.uri.toString(), contract.baseline.ref));
        if (watchInputs) dependencies.push(...activeTargets.filter(t => typeof t.source !== "string").map(t => t.source.toString()));
        dependencyWatchers.set(dependencies);
        const sqlTargets = resolveSqlServerTargets(effective(contract), false);
        await panel.webview.postMessage({
          type: "state",
          stale, live: scheduler.enabled, watchInputs, runNotice, documentVersion: document.version, dirty: document.isDirty,
          contract,
          contractName: vscode.workspace.asRelativePath(document.uri, false) + (memberId ? ` / ${memberId} (inline; saved in suite)` : ""),
          targetNames: [...activeTargets.map((target) => target.label), ...sqlTargets.map(sqlServerTargetLabel)],
          connectionOverview: sqlTargets.map((target, index) => {
            const own = (value: { connection?: string; integratedConnection?: unknown } | undefined) => value?.connection !== undefined || value?.integratedConnection !== undefined;
            const origin = own(contract.sqlServer?.targets?.[index]) ? "table override" : own(contract.sqlServer) ? "contract" : memberId || suiteContext ? "suite default" : "unconfigured";
            return `${sqlServerTargetLabel(target)} · ${origin}`;
          }),
          fileTargetCount: activeTargets.length,
          configuredTargetCount: savedTargets.length + sqlTargets.length,
          usingConfiguredTargets: manualTargets === undefined && (savedTargets.length > 0 || sqlTargets.length > 0),
          runs: latestRuns
        });
      } catch (error) {
        await panel.webview.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
      }
    };

    const documentSubscription = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.toString() === document.uri.toString() || event.document.uri.toString() === suiteContext?.uri.toString()) { refreshRevision(); void postState(); }
    });
    const watcher = vscode.workspace.createFileSystemWatcher("**/*");
    const dependencyChange = (uri: vscode.Uri): void => {
      try {
        const contract = read(), baseline = contract.baseline;
        const inputChanged = watchInputs && (manualTargets ?? configuredTargets(document.uri, contract)).some(t => typeof t.source !== "string" && t.source.toString() === uri.toString());
        if (inputChanged || baseline && "ref" in baseline && vscodeSuiteIO.resolve(document.uri.toString(), baseline.ref) === uri.toString()) { scheduler.change(); refreshRevision(); void postState(); }
      } catch { scheduler.change(); }
    };
    const dependencyWatchers = new DependencyWatchers(dependencyChange);
    const baselineEdit = vscode.workspace.onDidChangeTextDocument(e => dependencyChange(e.document.uri));
    const changed = watcher.onDidChange(dependencyChange), deleted = watcher.onDidDelete(dependencyChange), created = watcher.onDidCreate(dependencyChange);
    panel.onDidDispose(() => { documentSubscription.dispose(); baselineEdit.dispose(); changed.dispose(); deleted.dispose(); created.dispose(); watcher.dispose(); dependencyWatchers.dispose(); scheduler.dispose(); });
    const receive = async (message: any): Promise<void> => {
      try {
      if (message.type === "ready") {
        refreshRevision();
        await postState();
      } else if (message.type === "chooseCsv") {
        const uris = await pickFiles({ "CSV files": ["csv"] });
        if (!uris?.length) return;
        manualTargets = uris.map((uri) => ({ label: vscode.workspace.asRelativePath(uri, false), source: uri }));
        refreshRevision();
        await postState();
      } else if (message.type === "useConfiguredTargets") {
        manualTargets = undefined;
        refreshRevision();
        await postState();
      } else if (message.type === "addTargetFiles") {
        const uris = await pickFiles({ "CSV files": ["csv"] });
        if (!uris?.length) return;
        const contract = read();
        contract.targets ??= [];
        const existing = new Set(contract.targets.map((target) => target.path ?? target.url));
        for (const uri of uris) {
          const path = relativeTargetPath(document.uri, uri);
          if (!existing.has(path)) contract.targets.push({ path });
        }
        await write(contract);
      } else if (message.type === "addTargetUrl") {
        const url = await vscode.window.showInputBox({
          title: "Add CSV URL",
          prompt: "Enter an HTTP or HTTPS URL that returns CSV content.",
          placeHolder: "https://example.com/export.csv",
          validateInput: (value) => /^https?:\/\/\S+$/i.test(value) ? undefined : "Enter a valid HTTP or HTTPS URL."
        });
        if (!url) return;
        const contract = read();
        contract.targets ??= [];
        if (!contract.targets.some((target) => target.url === url)) contract.targets.push({ url });
        await write(contract);
      } else if (message.type === "openTargetInVsCode" || message.type === "openTargetExternally") {
        const contract = read();
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
        const contract = read();
        const targets = manualTargets ?? configuredTargets(document.uri, contract);
        const target = await selectTargetToOpen(targets);
        if (!target) return;
        try {
          if (message.type === "openActiveTargetInVsCode") await openTargetInVsCode(target);
          else await openTargetExternally(target);
        } catch (error) {
          void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
        }
      } else if (message.type === "exportIssues") {
        const retainedIssueCount = latestRuns.reduce((total, run) => total + (run.result?.issues.length ?? 0), 0);
        if (latestRuns.length === 0) {
          void vscode.window.showWarningMessage("Run the contract before exporting results.");
          return;
        }
        const format = await vscode.window.showQuickPick([
          { label: "JSON", description: "Complete target summaries and retained issue details", extension: "results.json" },
          { label: "CSV", description: "One row per retained validation issue", extension: "issues.csv" }
        ], { title: "Export validation results", placeHolder: "Choose a machine-readable format" });
        if (!format) return;
        const contractFilename = document.uri.path.split("/").at(-1) ?? "contract.csvtest.yaml";
        const exportFilename = contractFilename.replace(/\.csvtest\.ya?ml$/i, "") + `.${format.extension}`;
        const outputUri = await vscode.window.showSaveDialog({
          title: "Export validation results",
          defaultUri: document.uri.with({ path: document.uri.path.replace(/[^/]+$/, exportFilename) }),
          filters: format.label === "JSON" ? { "JSON files": ["json"] } : { "CSV files": ["csv"] }
        });
        if (!outputUri) return;
        const exportRuns = filterResultRuns(latestRuns, String(message.filter ?? ""));
        const content = format.label === "JSON"
          ? JSON.stringify({ ...JSON.parse(validationRunExportJson(vscode.workspace.asRelativePath(document.uri, false), exportRuns)), exportScope: { filter: message.filter ?? "", stale, runNotice, totals: "original scope; details filtered over retained issues" } }, null, 2)
          : issueRunsToCsv(exportRuns);
        await vscode.workspace.fs.writeFile(outputUri, new TextEncoder().encode(content));
        const totalIssueCount = latestRuns.reduce((total, run) => total + (run.result?.issueCount ?? 0), 0);
        if (totalIssueCount > retainedIssueCount) {
          void vscode.window.showWarningMessage(
            `Exported the run results with ${retainedIssueCount.toLocaleString()} of ${totalIssueCount.toLocaleString()} issue details because the validation issue limit was reached.`
          );
        } else {
          void vscode.window.showInformationMessage(`Exported results for ${latestRuns.length.toLocaleString()} validation target${latestRuns.length === 1 ? "" : "s"}.`);
        }
      } else if (message.type === "run" || message.type === "preview") {
        previewRule = message.type === "preview" ? String(message.ruleId) : undefined;
        refreshRevision();
        scheduler.request();
      } else if (message.type === "live") {
        if (scheduler.enabled) scheduler.pause();
        else { previewRule = undefined; refreshRevision(); scheduler.enable(); }
        await postState();
      } else if (message.type === "cancel") {
        scheduler.cancel(); stale = true; await postState();
      } else if (message.type === "watchInputs") {
        watchInputs = !watchInputs; await postState();
      } else if (message.type === "createBaseline" || message.type === "reviewBaseline") {
        try { await editBaseline(document.uri, read, write, this.sqlSchemaReader, message.type === "reviewBaseline", effective); }
        catch (error) { void vscode.window.showErrorMessage(String(error)); }
      } else if (message.type === "updateContract") {
        if (message.documentVersion !== undefined && message.documentVersion !== document.version) { runNotice = "The document changed before this edit arrived. Review the current values and retry."; await postState(); return; }
        await write(message.contract as CsvContract);
      } else if (message.type === "jumpRule") {
        const offset = ruleOffset(document.getText(), String(message.ruleId), memberId);
        const position = offset === undefined ? undefined : document.positionAt(offset);
        await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside, selection: position ? new vscode.Range(position, position) : undefined });
      } else if (message.type === "openYaml") {
        await vscode.commands.executeCommand("vscode.openWith", document.uri, "default");
      } else if (message.type === "generateSqlServerValidation") {
        const contract = effective(read());
        const targets = resolveSqlServerTargets(contract, false);
        const chosen = await vscode.window.showQuickPick(targets.map(target => ({ label: sqlServerTargetLabel(target), target })), { title: "Generate SQL from current draft" });
        if (chosen) {
          const generated = generateSqlServerValidation(contract, { target: chosen.target });
          await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: "sql", content: generated.sql }), { viewColumn: vscode.ViewColumn.Beside });
        }
      } else if (message.type === "editConnection") {
        await editSuiteConnection(document, undefined, true, memberId);
      } else if (message.type === "history") {
        if (stale) throw new Error("Run current definitions before saving or comparing history.");
        await manageHistory(this.context, `${document.uri.toString()}#${memberId ?? ""}`, latestRuns, JSON.stringify(read()));
      } else if (message.type === "insertTemplate") {
        const source = await pickFile({ "Rule template": ["yaml", "yml", "json"] });
        if (!source) return;
        const template = parseTemplate(new TextDecoder().decode(await vscode.workspace.fs.readFile(source)));
        const parameters: Record<string, string> = {};
        for (const key of template.parameters ?? []) {
          const value = await vscode.window.showInputBox({ title: `${template.name}: ${key}`, prompt: "Literal substitution; leading zeros are preserved." });
          if (value === undefined) return;
          parameters[key] = value;
        }
        const original = read();
        const next = insertTemplate(original, template, parameters);
        const preview = await vscode.workspace.openTextDocument({ language: "yaml", content: serializeContract(next) });
        await vscode.window.showTextDocument(preview, { viewColumn: vscode.ViewColumn.Beside });
        if (await vscode.window.showInformationMessage("Insert these reviewed template rules?", { modal: true }, "Insert") !== "Insert") return;
        if (JSON.stringify(read()) !== JSON.stringify(original)) throw new Error("Contract changed while reviewing template.");
        await write(next);
      } else if (message.type === "preflight") {
        if (!this.sqlSchemaReader) throw new Error("SQL preflight requires the desktop extension host.");
        const contract = effective(read());
        const checks = await preflight(contract, this.sqlSchemaReader);
        runNotice = checks.map(c => `${c.status} · ${c.target}: ${c.message}`).join("\n") || "No SQL targets configured."; await postState();
      } else if (message.type === "configureSqlServerConnection") {
        await configureSqlServerConnection(this.context);
      } else if (message.type === "addSqlServerTarget") {
        await addSqlServerTarget(this.context, document.uri, this.sqlServerBrowser, { read, write });
      } else if (message.type === "importSqlServerSchema") {
        await importSqlServerSchema(document.uri, { read, write });
      }
      } catch (error) { runNotice = errorDetails(error); await postState(); void vscode.window.showErrorMessage(runNotice); }
    };
    panel.webview.onDidReceiveMessage(receive);
    if (this.context.extensionMode === vscode.ExtensionMode.Test) {
      const key = `${document.uri.toString()}#${memberId ?? ""}`;
      this.testActions.set(key, receive);
      panel.onDidDispose(() => { this.testActions.delete(key); this.testStates.delete(key); });
    }
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

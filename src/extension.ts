import { isSuiteText } from "./core/suite";
import { registerSuiteDiagnostics, resolveSuiteEditor, showSuiteRun, showSuiteSql } from "./vscode-suites";
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
  result: ValidationResult;
}

export type DesktopSqlServerRunner = (contract: CsvContract, target: ResolvedSqlServerTarget) => Promise<ValidationResult>;
export type DesktopSqlServerBrowser = (profile: string) => Promise<SqlServerObjectInfo[]>;

const sqlConnectionProfilesKey = "csvContract.sqlServer.connectionProfiles";
const sqlConnectionSecretPrefix = "csvContract.sqlServer.connection.";
export const sqlConnectionSecretKey = (profile: string): string => `${sqlConnectionSecretPrefix}${profile}`;

export function activate(
  context: vscode.ExtensionContext,
  desktopComparisonRunner?: DesktopComparisonRunner,
  sqlServerRunner?: DesktopSqlServerRunner,
  sqlServerBrowser?: DesktopSqlServerBrowser
): void {
  const output = vscode.window.createOutputChannel("CSV Contract");
  const provider = new ContractEditorProvider(context, sqlServerRunner, sqlServerBrowser);
  registerTargetContentProvider(context);
  registerSuiteDiagnostics(context);
  context.subscriptions.push(
    output,
    vscode.window.registerCustomEditorProvider(viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false
    }),
    vscode.commands.registerCommand("csv-contract-vsce.createFromCsv", () => createFromCsv()),
    vscode.commands.registerCommand("csv-contract-vsce.runContract", () => runContract(output, sqlServerRunner, context)),
    vscode.commands.registerCommand("csv-contract-vsce.openWorkbench", (uri?: vscode.Uri) => openWorkbench(uri)),
    vscode.commands.registerCommand("csv-contract-vsce.generateSqlServerValidation", (uri?: vscode.Uri) => generateSqlServerScript(uri)),
    vscode.commands.registerCommand("csv-contract-vsce.importSqlServerSchema", (uri?: vscode.Uri) => importSqlServerSchema(uri)),
    vscode.commands.registerCommand("csv-contract-vsce.configureSqlServerConnection", () => configureSqlServerConnection(context)),
    vscode.commands.registerCommand("csv-contract-vsce.forgetSqlServerConnection", () => forgetSqlServerConnection(context)),
    vscode.commands.registerCommand("csv-contract-vsce.addSqlServerTarget", (uri?: vscode.Uri) => addSqlServerTarget(context, uri, sqlServerBrowser))
  );
  registerWorkspaceExplorer(context, output, sqlServerRunner);
  registerSemanticComparison(context, desktopComparisonRunner);
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

async function importSqlServerSchema(requestedUri?: vscode.Uri): Promise<void> {
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

async function runContract(output: vscode.OutputChannel, sqlServerRunner?: DesktopSqlServerRunner, context?: vscode.ExtensionContext): Promise<void> {
  const specUri = await pickFile({ "CSV contracts": ["csvtest.yaml", "csvtest.yml", "yaml", "yml"] });
  if (!specUri) return;
  const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(specUri));
  if (isSuiteText(text) && context) { await showSuiteRun(context, specUri, sqlServerRunner); return; }
  const contract = parseContract(text);
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
  sqlServerBrowser: DesktopSqlServerBrowser | undefined
): Promise<void> {
  if (!sqlServerBrowser) {
    void vscode.window.showErrorMessage("Browsing SQL Server tables and views requires the desktop extension host.");
    return;
  }
  const active = vscode.window.activeTextEditor?.document.uri;
  const specUri = requestedUri?.path.match(/\.csvtest\.ya?ml$/i) ? requestedUri
    : active?.path.match(/\.csvtest\.ya?ml$/i) ? active
      : await pickFile({ "CSV contracts": ["csvtest.yaml", "csvtest.yml", "yaml", "yml"] });
  if (!specUri) return;
  try {
    const document = await vscode.workspace.openTextDocument(specUri);
    const contract = parseContract(document.getText());
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
    await replaceTextDocument(document, serializeContract(contract));
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
  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly sqlServerRunner?: DesktopSqlServerRunner,
    private readonly sqlServerBrowser?: DesktopSqlServerBrowser
  ) {}

  public async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    if (/\.csvsuite\.ya?ml$/i.test(document.uri.path) || isSuiteText(document.getText())) {
      await resolveSuiteEditor(document, panel, this.sqlServerRunner);
      return;
    }
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri]
    };
    panel.webview.html = this.html(panel.webview);
    let manualTargets: ResolvedTarget[] | undefined;
    let latestRuns: TargetRun[] = [];

    const postState = async (runs?: TargetRun[]): Promise<void> => {
      if (runs) latestRuns = runs;
      try {
        const contract = parseContract(document.getText());
        const savedTargets = configuredTargets(document.uri, contract);
        const activeTargets = manualTargets ?? savedTargets;
        const sqlTargets = resolveSqlServerTargets(contract, false).filter(hasSqlServerConnection);
        await panel.webview.postMessage({
          type: "state",
          contract,
          contractName: vscode.workspace.asRelativePath(document.uri, false),
          targetNames: [...activeTargets.map((target) => target.label), ...sqlTargets.map(sqlServerTargetLabel)],
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
      } else if (message.type === "exportIssues") {
        const retainedIssueCount = latestRuns.reduce((total, run) => total + run.result.issues.length, 0);
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
        const content = format.label === "JSON"
          ? validationRunExportJson(vscode.workspace.asRelativePath(document.uri, false), latestRuns)
          : issueRunsToCsv(latestRuns);
        await vscode.workspace.fs.writeFile(outputUri, new TextEncoder().encode(content));
        const totalIssueCount = latestRuns.reduce((total, run) => total + run.result.issueCount, 0);
        if (totalIssueCount > retainedIssueCount) {
          void vscode.window.showWarningMessage(
            `Exported the run results with ${retainedIssueCount.toLocaleString()} of ${totalIssueCount.toLocaleString()} issue details because the validation issue limit was reached.`
          );
        } else {
          void vscode.window.showInformationMessage(`Exported results for ${latestRuns.length.toLocaleString()} validation target${latestRuns.length === 1 ? "" : "s"}.`);
        }
      } else if (message.type === "run") {
        const runs: TargetRun[] = [];
        try {
          latestRuns = [];
          await postState(runs);
          const contract = parseContract(document.getText());
          const targets = manualTargets ?? configuredTargets(document.uri, contract);
          const sqlTargets = resolveSqlServerTargets(contract, false).filter(hasSqlServerConnection);
          if (targets.length === 0 && sqlTargets.length === 0) {
            void vscode.window.showWarningMessage("Select a CSV or add a configured CSV or SQL Server target before running the contract.");
            return;
          }
          const total = targets.length + sqlTargets.length;
          let index = 0;
          for (const target of targets) {
            index += 1;
            await panel.webview.postMessage({
              type: "runState",
              running: true,
              target: target.label,
              index,
              total
            });
            runs.push({ target: target.label, result: validateCsv(contract, await readTargetText(target)) });
            await postState(runs);
          }
          for (const target of sqlTargets) {
            index += 1;
            if (!this.sqlServerRunner) throw new Error("Direct SQL Server validation requires the desktop extension host.");
            const label = sqlServerTargetLabel(target);
            await panel.webview.postMessage({ type: "runState", running: true, target: label, index, total });
            runs.push({ target: label, result: await this.sqlServerRunner(contract, target) });
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
      } else if (message.type === "generateSqlServerValidation") {
        await generateSqlServerScript(document.uri);
      } else if (message.type === "configureSqlServerConnection") {
        await configureSqlServerConnection(this.context);
      } else if (message.type === "addSqlServerTarget") {
        await addSqlServerTarget(this.context, document.uri, this.sqlServerBrowser);
      } else if (message.type === "importSqlServerSchema") {
        await importSqlServerSchema(document.uri);
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

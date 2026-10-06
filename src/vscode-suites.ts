import { LiveTests } from "./core/live-tests";
import { DependencyWatchers } from "./vscode-dependencies";
import { evaluateCsvCrossCheck, type CrossExecutor } from "./core/cross-checks";
import { manageHistory } from "./vscode-history";
import { contractPath, readEditorContract, ruleOffset } from "./core/editor-document";
import type { LoadedSuite } from "./core/suite";
import { resolveBaseline, resolveTargetBaseline, baselineReferences } from "./core/baseline";
import { isMap } from "yaml";
import * as vscode from "vscode";
import { generateSuiteSql, loadSuite, parseSuite, runSuite, yamlDocument, type SuiteIO } from "./core/suite";
import type { DesktopSqlServerRunner } from "./extension";
import { renderWorkspaceReportHtml } from "./workspace-report";
import { configuredTargets, readTargetText } from "./vscode-targets";
import { resolveSqlServerTargets } from "./core/sql-server-targets";
import { parseCsv, validateCsv } from "./core/contract";
import { renderSuiteWorkbench, type SuiteMemberProgress, type SuiteRunProgress, type SuiteTargetProgress } from "./suite-workbench";
import { suiteErrorsCsv, updateSuiteConnection } from "./suite-actions";
import { badRowsXlsx, contractCheckCatalog } from "./bad-rows-xlsx";
import { filterResultRuns } from "./results-view";
import { errorDetails } from "./core/error-details";
import type { SuiteConnection } from "./core/suite";
import type { ResultColorMode } from "./core/result-health";

export async function editSuiteConnection(document: vscode.TextDocument, index?: number, standalone = false, memberId?: string, targetIndex?: number): Promise<void> {
  const suite = standalone ? { members: [] } : parseSuite(document.getText());
  let targetDocument = document;
  let path: (string | number)[] = ["defaults"];
  if (standalone) {
    path = [...contractPath(document.getText(), memberId), "sqlServer"];
    const contract = readEditorContract(document.getText(), memberId);
    if (targetIndex !== undefined && contract.sqlServer?.targets?.length) path.push("targets", targetIndex);
  }
  else if (index !== undefined) {
    if (!Number.isInteger(index) || index < 0 || index >= suite.members.length) return;
    const member = suite.members[index];
    if (member.ref) targetDocument = await vscode.workspace.openTextDocument(vscode.Uri.parse(vscodeSuiteIO.resolve(document.uri.toString(), member.ref)));
    const prefix: (string | number)[] = member.ref ? [] : ["members", index, "contract"];
    path = [...prefix, "sqlServer"];
    const sqlNode = yamlDocument(targetDocument.getText()).getIn(path, true);
    const sql = isMap(sqlNode) ? sqlNode.toJSON() : undefined;
    if (sql?.targets?.length) {
      const selected = await vscode.window.showQuickPick([{ label: "Contract default", index: -1 },
        ...sql.targets.map((target: { schema?: string; table: string }, i: number) => ({ label: `${target.schema ?? sql.schema ?? "dbo"}.${target.table}`, index: i }))],
      { title: "Edit connection for", placeHolder: "Explicit table connections override the contract default." });
      if (!selected) return;
      if (selected.index >= 0) path.push("targets", selected.index);
    }
  }
  const version = targetDocument.version;
  const currentNode = yamlDocument(targetDocument.getText()).getIn(path, true);
  const current = (isMap(currentNode) ? currentNode.toJSON() : undefined) as SuiteConnection | undefined;
  const mode = await vscode.window.showQuickPick(["Windows integrated", "Stored connection profile", "Inherit / remove override"], {
    title: standalone ? "Contract connection" : index === undefined ? "Suite default connection" : `Connection: ${suite.members[index].id}`,
    placeHolder: "Table overrides take precedence over contract settings, then suite defaults."
  });
  if (!mode) return;
  let settings: SuiteConnection = {};
  if (mode === "Stored connection profile") {
    const profile = await vscode.window.showInputBox({ title: "Connection profile name", value: current?.connection,
      prompt: "Credentials remain in VS Code Secret Storage. Use Configure profile credentials to create or update the profile.",
      validateInput: (value) => /^[A-Za-z0-9._-]+$/.test(value) ? undefined : "Enter a profile name (letters, numbers, dots, underscores, hyphens)." });
    if (!profile) return;
    settings = { connection: profile };
  } else if (mode === "Windows integrated") {
    const ask = (title: string, value?: string) => vscode.window.showInputBox({ title, value, ignoreFocusOut: true, validateInput: (s) => s.trim() ? undefined : "Required" });
    const server = await ask("SQL Server", current?.integratedConnection?.server);
    if (!server) return;
    const database = await ask("Database", current?.integratedConnection?.database);
    if (!database) return;
    const encrypt = await vscode.window.showQuickPick(["Yes", "No"], { title: "Encrypt connection", placeHolder: `Current: ${current?.integratedConnection?.encrypt ?? "driver default"}` });
    if (!encrypt) return;
    const trust = await vscode.window.showQuickPick(["No", "Yes"], { title: "Trust server certificate", placeHolder: `Current: ${current?.integratedConnection?.trustServerCertificate ?? false}` });
    if (!trust) return;
    const driver = await vscode.window.showInputBox({ title: "ODBC driver (blank for default)", value: current?.integratedConnection?.odbcDriver });
    if (driver === undefined) return;
    settings = { integratedConnection: { server: server.trim(), database: database.trim(), encrypt: encrypt === "Yes", trustServerCertificate: trust === "Yes", ...(driver.trim() ? { odbcDriver: driver.trim() } : {}) } };
  }
  if (targetDocument.version !== version) throw new Error("The contract changed while editing its connection. Please try again.");
  const edit = new vscode.WorkspaceEdit();
  edit.replace(targetDocument.uri, new vscode.Range(targetDocument.positionAt(0), targetDocument.positionAt(targetDocument.getText().length)), updateSuiteConnection(targetDocument.getText(), path, settings));
  if (!await vscode.workspace.applyEdit(edit)) throw new Error("Could not update the connection.");
}

async function bulkConnections(document: vscode.TextDocument): Promise<void> {
  const suite = parseSuite(document.getText());
  const selected = await vscode.window.showQuickPick(suite.members.map((member, index) => ({ label: member.id, index, member })), { canPickMany: true, title: "Apply a connection to selected members" });
  if (!selected?.length) return;
  const mode = await vscode.window.showQuickPick(["Stored profile", "Windows integrated", "Inherit suite default"], { title: "Bulk connection settings" });
  if (!mode) return;
  let settings: SuiteConnection = {};
  if (mode === "Stored profile") {
    const connection = await vscode.window.showInputBox({ title: "Profile name", validateInput: value => /^[A-Za-z0-9._-]+$/.test(value) ? undefined : "Use a profile name, never credentials." });
    if (!connection) return;
    settings = { connection };
  } else if (mode === "Windows integrated") {
    const server = await vscode.window.showInputBox({ title: "SQL Server", validateInput: s => s.trim() ? undefined : "Required" });
    if (!server) return;
    const database = await vscode.window.showInputBox({ title: "Database", validateInput: s => s.trim() ? undefined : "Required" });
    if (!database) return;
    settings = { integratedConnection: { server, database, encrypt: true, trustServerCertificate: false } };
  }
  const overrides = await vscode.window.showQuickPick(["Preserve explicit table overrides", "Remove explicit table overrides"], { title: "Bulk connection override policy" });
  if (!overrides) return;
  const edits = new Map<string, { document: vscode.TextDocument; version: number; before: string; after: string }>();
  for (const { member, index } of selected) {
    const target = member.ref ? await vscode.workspace.openTextDocument(vscode.Uri.parse(vscodeSuiteIO.resolve(document.uri.toString(), member.ref))) : document;
    const key = target.uri.toString();
    const entry = edits.get(key) ?? { document: target, version: target.version, before: target.getText(), after: target.getText() };
    const prefix = member.ref ? [] : ["members", index, "contract"];
    entry.after = updateSuiteConnection(entry.after, [...prefix, "sqlServer"], settings);
    if (overrides === "Remove explicit table overrides") {
      const targets = yamlDocument(entry.after).getIn([...prefix, "sqlServer", "targets"]);
      if (targets && typeof targets === "object" && "items" in targets && Array.isArray(targets.items)) for (let i = 0; i < targets.items.length; i++) entry.after = updateSuiteConnection(entry.after, [...prefix, "sqlServer", "targets", i], {});
    }
    edits.set(key, entry);
  }
  const before = await vscode.workspace.openTextDocument({ language: "yaml", content: [...edits].map(([path, e]) => `# ${path}\n${e.before}`).join("\n---\n") });
  const after = await vscode.workspace.openTextDocument({ language: "yaml", content: [...edits].map(([path, e]) => `# ${path}\n${e.after}`).join("\n---\n") });
  await vscode.commands.executeCommand("vscode.diff", before.uri, after.uri, "Review bulk connection changes");
  if (await vscode.window.showInformationMessage(`Apply reviewed connection changes to ${selected.length} members?`, { modal: true, detail: overrides }, "Apply") !== "Apply") return;
  const edit = new vscode.WorkspaceEdit();
  for (const e of edits.values()) {
    if (e.document.version !== e.version) throw new Error("A document changed during bulk review; review again.");
    edit.replace(e.document.uri, new vscode.Range(e.document.positionAt(0), e.document.positionAt(e.before.length)), e.after);
  }
  if (!await vscode.workspace.applyEdit(edit)) throw new Error("Could not apply bulk connection changes.");
}

function suiteProgressPlan(suite: LoadedSuite, selected?: string[]): SuiteRunProgress {
  const included = selected ? new Set(selected) : undefined;
  return {
    running: true,
    members: suite.members.map(member => {
      const targets: SuiteTargetProgress[] = [];
      if (member.contract) {
        try {
          targets.push(...resolveSqlServerTargets(member.contract, false).map(target => ({ label: target.name ?? `${target.schema}.${target.table}`, status: "queued" as const })));
          targets.push(...configuredTargets(vscode.Uri.parse(member.source), member.contract).map(target => ({ label: target.label, status: "queued" as const })));
        } catch { /* The member-level execution result carries the configuration error. */ }
      }
      const skipped = included && !included.has(member.id);
      if (skipped) targets.forEach(target => target.status = "SKIPPED");
      return { id: member.id, source: member.source, status: skipped ? "SKIPPED" : "queued", targets };
    })
  };
}

function updateMemberProgress(member: SuiteMemberProgress): void {
  if (member.targets.some(target => target.status === "running")) member.status = "running";
  else if (member.targets.some(target => target.status === "queued")) member.status = "queued";
  else if (member.targets.some(target => target.status === "ERROR")) member.status = "ERROR";
  else if (member.targets.some(target => target.status === "FAIL")) member.status = "FAIL";
  else if (member.targets.some(target => target.status === "CANCELED")) member.status = "CANCELED";
  else if (member.targets.some(target => target.status === "SAMPLED")) member.status = "SAMPLED";
  else if (member.targets.length && member.targets.every(target => target.status === "SKIPPED")) member.status = "SKIPPED";
  else if (member.targets.length) member.status = "PASS";
}

export async function resolveSuiteEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel, runner?: DesktopSqlServerRunner, openInline?: (memberId: string) => Promise<void>, context?: vscode.ExtensionContext, crossExecutor?: CrossExecutor, schemaReader?: import("./vscode-baselines").SqlSchemaReader): Promise<void> {
  panel.webview.options = { enableScripts: true, localResourceRoots: [] };
  let running = false;
  let disposed = false;
  let stale = false;
  let watchInputs = false;
  let consecutiveErrors = 0;
  let refreshGeneration = 0;
  let dependencies = new Set([document.uri.toString()]);
  let previous = new Map<string, string>();
  let previousCrossChecks = "";
  const affected = new Set<string>();
  let renderVersion = 0;
  let notice: string | undefined;
  let report: Awaited<ReturnType<typeof executeVscodeSuite>> | undefined;
  let mergeMembers: string[] | undefined;
  let runView = false;
  let runProgress: SuiteRunProgress | undefined;
  let currentSuite: LoadedSuite | undefined;
  let progressTimer: ReturnType<typeof setTimeout> | undefined;
  const publishRunProgress = (immediate = false): void => {
    if (!runProgress || disposed) return;
    if (immediate) {
      clearTimeout(progressTimer); progressTimer = undefined;
      void panel.webview.postMessage({ type: "suiteRunProgress", run: runProgress });
    } else if (!progressTimer) progressTimer = setTimeout(() => {
      progressTimer = undefined;
      if (runProgress && !disposed) void panel.webview.postMessage({ type: "suiteRunProgress", run: runProgress });
    }, 100);
  };
  const render = async (): Promise<void> => {
    const version = ++renderVersion;
    const nonce = globalThis.crypto.randomUUID().replaceAll("-", "");
    try {
      const parsed = parseSuite(document.getText());
      const suite = currentSuite ?? await loadSuite(document.uri.toString(), vscodeSuiteIO);
      if (disposed || version !== renderVersion) return;
      panel.webview.html = renderSuiteWorkbench({ suite, name: parsed.name, description: parsed.description,
        references: parsed.members.map((m) => m.ref), running, runs: report?.runs, notice, stale, live: scheduler.enabled, watchInputs,
        runView, runProgress, resultColorMode: vscode.workspace.getConfiguration("csvContract").get<ResultColorMode>("resultColorMode", "binary") }, nonce);
    } catch (error) {
      if (!disposed && version === renderVersion) panel.webview.html = renderSuiteWorkbench({ error: String(error), running }, nonce);
    }
  };
  const scheduler = new LiveTests<{ suite: LoadedSuite; members?: string[] }, Awaited<ReturnType<typeof executeVscodeSuite>>>(async (snapshot, signal) => {
    running = true; runView = true; runProgress = suiteProgressPlan(snapshot.suite, snapshot.members); notice = "Executing selected scope…"; await render();
    const lastProgress = new Map<string, number>();
    const memberTarget = (target: Pick<import("./core/suite").SuiteRun, "member">, index: number): SuiteTargetProgress | undefined =>
      runProgress?.members.find(member => member.id === target.member)?.targets[index];
    try {
      return await executeLoadedSuite(snapshot.suite, runner, {
        signal, members: snapshot.members, crossExecutor,
        onTargetStart: (identity, index) => {
          const target = memberTarget(identity, index); if (target) target.status = "running";
          const member = runProgress?.members.find(item => item.id === identity.member); if (member) updateMemberProgress(member);
          publishRunProgress();
        },
        onTargetProgress: (identity, progress, index) => {
          const key = `${identity.member}:${index}`;
          const now = Date.now();
          if (progress.phase === "reading" && now - (lastProgress.get(key) ?? 0) < 100) return;
          lastProgress.set(key, now);
          const target = memberTarget(identity, index); if (target) target.progress = { ...target.progress, ...progress };
          publishRunProgress();
        },
        onProgress: (completed, index) => {
          if (index === undefined) return;
          const target = memberTarget(completed, index);
          if (target) { target.status = completed.status; target.rows = completed.result?.rowCount; target.error = completed.error; }
          const member = runProgress?.members.find(item => item.id === completed.member); if (member) updateMemberProgress(member);
          publishRunProgress();
        }
      });
    } finally { running = false; if (runProgress) runProgress.running = false; }
  }, result => {
    if (mergeMembers?.length && report) {
      const selected = new Set(mergeMembers);
      const rerun = result.runs.filter(run => selected.has(run.member) || run.member.startsWith("cross:") && run.status !== "SKIPPED");
      const replaced = new Set(rerun.map(run => run.member));
      const retained = report.runs.filter(run => !selected.has(run.member) && !replaced.has(run.member));
      const memberOrder = new Map(parseSuite(document.getText()).members.map((member, index) => [member.id, index]));
      const combined = [...retained, ...rerun].map((run, index) => ({ run, index })).sort((a, b) =>
        (memberOrder.get(a.run.member) ?? Number.MAX_SAFE_INTEGER) - (memberOrder.get(b.run.member) ?? Number.MAX_SAFE_INTEGER) || a.index - b.index).map(item => item.run);
      const status = combined.some(run => run.status === "ERROR") || !combined.length ? "ERROR" : combined.some(run => run.status === "CANCELED") ? "CANCELED" :
        combined.some(run => run.status === "FAIL") ? "FAIL" : combined.some(run => run.status === "SKIPPED") ? "SKIPPED" : combined.some(run => run.status === "SAMPLED") ? "SAMPLED" : "PASS";
      const summary = { ...result.summary, PASS: combined.filter(run => run.status === "PASS").length, FAIL: combined.filter(run => run.status === "FAIL").length,
        ERROR: combined.filter(run => run.status === "ERROR").length, SKIPPED: combined.filter(run => run.status === "SKIPPED").length,
        CANCELED: combined.filter(run => run.status === "CANCELED").length, ...(combined.some(run => run.status === "SAMPLED") ? { SAMPLED: combined.filter(run => run.status === "SAMPLED").length } : {}) };
      result = { ...result, runs: combined, status, valid: status === "PASS", exitCode: status === "PASS" ? 0 : status === "FAIL" ? 1 : 2,
        summary,
        members: result.members.map(member => ({ id: member.id, runs: combined.filter(run => run.member === member.id) })) };
    }
    mergeMembers = undefined;
    report = result; stale = false; affected.clear(); notice = `${result.status}: ${result.runs.length} work items; ${new Date().toISOString()}`;
    if (runProgress) {
      runProgress.running = false; runProgress.status = result.status;
      for (const member of runProgress.members) {
        const memberRuns = result.runs.filter(run => run.member === member.id);
        if (!member.targets.length || memberRuns.some(run => run.status === "ERROR") && member.targets.every(target => target.status === "queued")) {
          member.status = memberRuns.some(run => run.status === "ERROR") ? "ERROR" : memberRuns.some(run => run.status === "FAIL") ? "FAIL" : memberRuns.some(run => run.status === "SKIPPED") ? "SKIPPED" : memberRuns.length ? "PASS" : member.status;
        } else updateMemberProgress(member);
      }
    }
    clearTimeout(progressTimer); progressTimer = undefined;
    consecutiveErrors = result.runs.some(r => r.status === "ERROR") ? consecutiveErrors + 1 : 0;
    if (consecutiveErrors >= 3) { scheduler.pause(); notice += " · Live tests paused after three consecutive execution errors."; }
    void render(); },
  error => { mergeMembers = undefined; notice = errorDetails(error); stale = true; running = false; clearTimeout(progressTimer); progressTimer = undefined; if (runProgress) { runProgress.running = false; runProgress.status = "ERROR"; } void render(); });
  const refresh = async (uri?: vscode.Uri, selection?: string[]): Promise<void> => {
    if (uri && !dependencies.has(uri.toString())) return;
    // Invalidate before asynchronous dependency reads; an old query may finish during those reads.
    if (uri) { stale = !!report; if (running) scheduler.change(); }
    const revision = ++refreshGeneration;
    const nextDependencies = new Set([document.uri.toString()]);
    try {
      const suite = await loadSuite(document.uri.toString(), vscodeSuiteIO);
      const fingerprints = new Map<string, string>();
      for (const member of suite.members) {
        nextDependencies.add(member.source);
        if (member.contract) for (const ref of baselineReferences(member.contract)) nextDependencies.add(vscodeSuiteIO.resolve(member.source, ref));
        if (member.contract) member.contract = await resolveBaseline(member.contract, member.source, vscodeSuiteIO);
        const inputRevisions: unknown[] = [];
        if (watchInputs && member.contract) for (const target of configuredTargets(vscode.Uri.parse(member.source), member.contract)) {
          if (typeof target.source === "string") continue;
          nextDependencies.add(target.source.toString());
          try { const stat = await vscode.workspace.fs.stat(target.source); inputRevisions.push([target.source.toString(), stat.mtime, stat.size]); }
          catch { inputRevisions.push([target.source.toString(), "missing"]); }
        }
        fingerprints.set(member.id, JSON.stringify([member, inputRevisions]));
      }
      if (revision !== refreshGeneration) return;
      currentSuite = suite;
      dependencies = nextDependencies;
      dependencyWatchers.set(dependencies);
      for (const [id, value] of fingerprints) if (previous.get(id) !== value) affected.add(id);
      const crossFingerprint = JSON.stringify([suite.crossChecks ?? [], suite.targetMatrix ?? []]);
      if (crossFingerprint !== previousCrossChecks) for (const check of suite.crossChecks ?? []) { affected.add(check.from); affected.add(check.to); }
      previousCrossChecks = crossFingerprint;
      let expanded = true;
      while (expanded) {
        const count = affected.size;
        for (const check of suite.crossChecks ?? []) if (affected.has(check.from) || affected.has(check.to)) { affected.add(check.from); affected.add(check.to); }
        expanded = affected.size !== count;
      }
      previous = fingerprints;
      if (affected.size) stale = !!report;
      if (suite.members.some(m => m.error)) { scheduler.change(); notice = "Invalid member definitions; live execution waits for valid edits."; }
      else scheduler.change({ key: JSON.stringify([suite, selection, [...fingerprints]]), value: { suite, members: selection ?? (scheduler.enabled && report ? [...affected] : undefined) } });
    } catch (error) { if (revision === refreshGeneration) { currentSuite = undefined; dependencies = nextDependencies; dependencyWatchers.set(dependencies); scheduler.change(); stale = !!report; notice = errorDetails(error); } }
    await render();
  };
  const dependencyWatchers = new DependencyWatchers(uri => { void refresh(uri); });
  const watcher = vscode.workspace.createFileSystemWatcher("**/*.{yaml,yml}");
  const subscriptions = [watcher, watcher.onDidChange(uri => { void refresh(uri); }), watcher.onDidCreate(uri => { void refresh(uri); }), watcher.onDidDelete(uri => { void refresh(uri); }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (/\.ya?ml$/i.test(event.document.uri.path)) void refresh(event.document.uri);
    }), panel.webview.onDidReceiveMessage(async (message: { type?: string; index?: number; ruleId?: string; memberId?: string; memberIds?: string[]; resultFilter?: string; selectedIssues?: string[] }) => {
      try {
        if (["run", "selected", "failed"].includes(message.type ?? "") && !running) {
          mergeMembers = undefined;
          let members: string[] | undefined;
          if (message.type === "failed") {
            const checks = parseSuite(document.getText()).crossChecks ?? [];
            members = report?.runs.filter(r => r.status === "FAIL" || r.status === "ERROR").flatMap(r => {
              const check = checks.find(c => r.member === `cross:${c.id}` || r.member.startsWith(`cross:${c.id}@`));
              return check ? [check.from, check.to] : [r.member];
            }) ?? [];
            members = [...new Set(members)];
            if (!members.length) { notice = "There are no failed test files to rerun."; await render(); return; }
            mergeMembers = members;
          }
          if (message.type === "selected") {
            const selected = await vscode.window.showQuickPick(parseSuite(document.getText()).members.map(m => m.id), { canPickMany: true, title: "Run selected members" });
            if (!selected?.length) return;
            members = selected;
          }
          if (!currentSuite) await refresh(undefined, members);
          if (!currentSuite) throw new Error("The suite has not finished loading.");
          scheduler.change({ key: JSON.stringify([currentSuite, members, [...previous]]), value: { suite: currentSuite, members } });
          running = true; runView = true; runProgress = suiteProgressPlan(currentSuite, members); notice = "Starting suite run…";
          await render();
          scheduler.request();
        } else if (message.type === "suiteRunReady") { publishRunProgress(true);
        } else if (message.type === "show-results") { runView = false; await render();
        } else if (message.type === "color-mode") {
          const current = vscode.workspace.getConfiguration("csvContract").get<ResultColorMode>("resultColorMode", "binary");
          await vscode.workspace.getConfiguration("csvContract").update("resultColorMode", current === "graded" ? "binary" : "graded", vscode.ConfigurationTarget.Global);
          await render();
        } else if (message.type === "live") {
          if (scheduler.enabled) scheduler.pause();
          else { await refresh(); scheduler.enable(); }
          await render();
        } else if (message.type === "watch-inputs") {
          watchInputs = !watchInputs; await refresh();
        } else if (message.type === "cancel") { scheduler.cancel(); stale = true; notice = "Canceled; waiting for in-flight executor to return. Results will not overwrite newer definitions."; await render();        } else if (message.type === "sql" && !running) await showSuiteSql(document.uri);
        else if (message.type === "connection" && !running) await editSuiteConnection(document, message.index);
        else if (message.type === "bulk-connection" && !running) await bulkConnections(document);
        else if (message.type === "preflight" && !running) {
          if (!schemaReader) throw new Error("SQL preflight requires the desktop extension host.");
          const { preflight } = await import("./core/preflight");
          const suite = await loadSuite(document.uri.toString(), vscodeSuiteIO);
          const checks = [];
          for (const member of suite.members) {
            if (!member.contract || member.error) checks.push({ member: member.id, status: "ERROR", message: member.error });
            else checks.push(...(await preflight(member.contract, schemaReader)).map(check => ({ member: member.id, ...check })));
          }
          notice = checks.map(c => `${c.member}: ${c.status} · ${c.message}`).join("\n") || "No SQL targets configured.";
          await render();
        }
        else if (message.type === "credentials" && !running) await vscode.commands.executeCommand("csv-contract-vsce.configureSqlServerConnection");
        else if (message.type === "history" && context) {
          if (stale) throw new Error("Run current definitions before saving or comparing history.");
          await manageHistory(context, document.uri.toString(), report?.runs ?? [], JSON.stringify([...previous]), stale);
        }
        else if (message.type === "export" && report && !running) {
          const scoped = message.memberIds ? report.runs.filter(r => message.memberIds!.includes(r.member)) : report.runs;
          const exportScope = { members: message.memberIds ?? "all", filter: message.resultFilter ?? "", selectedIssues: message.selectedIssues ?? [], stale, totals: "original scope; retained details may be filtered or selected" };
          const filtered = filterResultRuns(scoped, message.resultFilter ?? "", message.selectedIssues);
          const snapshot = { ...report, runs: filtered, members: report.members.map(member => ({ id: member.id, runs: filtered.filter(run => run.member === member.id) })).filter(member => member.runs.length), exportScope, stale };
          const format = await vscode.window.showQuickPick(["CSV", "JSON", "Excel validation package"], { title: "Export suite errors and results" });
          if (!format) return;
          const extension = format === "CSV" ? "csv" : format === "JSON" ? "json" : "validation-package.xlsx";
          const destination = await vscode.window.showSaveDialog({ title: "Export suite results", defaultUri: vscode.Uri.joinPath(document.uri, "..", `${snapshot.suite}.results.${extension}`), filters: format === "CSV" ? { CSV: ["csv"] } : format === "JSON" ? { JSON: ["json"] } : { "Excel workbooks": ["xlsx"] } });
          if (!destination) return;
          const content = format === "CSV" ? suiteErrorsCsv(snapshot.runs, exportScope) : format === "JSON" ? JSON.stringify({ schema: "incursa.csv-suite-results/v1", ...snapshot }, null, 2) + "\n"
            : badRowsXlsx(scoped, { title: `${snapshot.suite} validation results`, checkCatalog: run => {
              if (run.member?.startsWith("cross:")) {
                const id = run.member.slice("cross:".length).split("@", 1)[0];
                return [{ id, category: "Cross-source check", description: `Validate the configured relationship or reconciliation between ${run.table ?? "suite sources"}.` }];
              }
              const member = currentSuite?.members.find(candidate => candidate.id === run.member);
              return member?.contract ? contractCheckCatalog(member.contract) : [];
            } });
          await vscode.workspace.fs.writeFile(destination, typeof content === "string" ? new TextEncoder().encode(content) : content);
          notice = `Exported results to ${destination.fsPath}`;
          await render();
        }
        else if (message.type === "jump-rule" && message.memberId && message.ruleId) {
          const member = parseSuite(document.getText()).members.find(m => m.id === message.memberId);
          if (!member) return;
          const target = member.ref ? await vscode.workspace.openTextDocument(vscode.Uri.parse(vscodeSuiteIO.resolve(document.uri.toString(), member.ref))) : document;
          const offset = ruleOffset(target.getText(), message.ruleId, member.ref ? undefined : member.id);
          const position = target.positionAt(offset ?? 0);
          await vscode.window.showTextDocument(target, { viewColumn: vscode.ViewColumn.Beside, selection: new vscode.Range(position, position) });
        }
        else if (message.type === "yaml" || message.type === "member") {
          let selection: vscode.Range | undefined;
          if (message.type === "member") {
            const parsed = parseSuite(document.getText());
            if (!Number.isInteger(message.index) || message.index! < 0 || message.index! >= parsed.members.length) return;
            const member = parsed.members[message.index!];
            if (openInline) { await openInline(member.id); return; }
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
        notice = errorDetails(error);
        await render();
        void vscode.window.showErrorMessage(notice);
      }
    })];
  panel.onDidDispose(() => { disposed = true; clearTimeout(progressTimer); scheduler.dispose(); dependencyWatchers.dispose(); subscriptions.forEach((s) => s.dispose()); });
  await refresh();
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
export async function executeVscodeSuite(uri: vscode.Uri, runner?: DesktopSqlServerRunner, crossExecutor?: CrossExecutor) {
  const suite = await loadSuite(uri.toString(), vscodeSuiteIO);
  return executeLoadedSuite(suite, runner, { crossExecutor });
}
async function executeLoadedSuite(suite: LoadedSuite, runner?: DesktopSqlServerRunner, controls: Parameters<typeof runSuite>[4] = {}) {
  const configuredConcurrency = vscode.workspace.getConfiguration("csvContract").get<number>("suiteParallelMembers", 4);
  const parallelMembers = Number.isFinite(configuredConcurrency) ? Math.min(32, Math.max(1, Math.floor(configuredConcurrency))) : 4;
  const executeCross: CrossExecutor = async (plan, signal) => {
    signal?.throwIfAborted();
    if (plan.mode === "sql") {
      if (!controls.crossExecutor) throw new Error("SQL cross-table execution is unavailable in this host.");
      return controls.crossExecutor(plan, signal);
    }
    const read = async (participant: typeof plan.from) => {
      const resolved = configuredTargets(vscode.Uri.parse(participant.source), { ...participant.contract, targets: [participant.target] })[0];
      return parseCsv(await readTargetText(resolved), participant.contract.csv);
    };
    const [from, to, participants] = await Promise.all([
      read(plan.from), read(plan.to),
      Promise.all(Object.entries(plan.participants).map(async ([id, participant]) => [id, await read(participant)] as const)).then(Object.fromEntries)
    ]);
    signal?.throwIfAborted();
    return evaluateCsvCrossCheck(plan, from, to, participants);
  };
  return runSuite(suite, async (contract, target, source, _index, onProgress) => {
    if (!runner) throw new Error("Database suite execution requires the desktop extension host.");
    return runner(await resolveBaseline(contract, source, vscodeSuiteIO), await resolveTargetBaseline(target, source, vscodeSuiteIO), controls.signal, undefined, onProgress);
  }, false, async (contract, source, target, _index, onProgress) => {
    const resolved = configuredTargets(vscode.Uri.parse(source), { ...contract, targets: [target] })[0];
    onProgress?.({ phase: "reading" });
    const csv = await readTargetText(resolved);
    onProgress?.({ phase: "validating", bytesRead: csv.length, totalBytes: csv.length });
    return validateCsv(await resolveBaseline(contract, source, vscodeSuiteIO), csv);
  }, { parallelTargets: Number.MAX_SAFE_INTEGER, parallelMembers, ...controls, crossExecutor: executeCross });
}
export async function showSuiteRun(context: vscode.ExtensionContext, uri: vscode.Uri, runner?: DesktopSqlServerRunner, crossExecutor?: CrossExecutor): Promise<void> {
  try {
    const started = Date.now();
    const report = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Running contract suite" }, () => executeVscodeSuite(uri, runner, crossExecutor));
    const panel = vscode.window.createWebviewPanel("csvContractSuiteReport", `${report.status}: ${report.suite}`, vscode.ViewColumn.Active, {});
    panel.webview.html = renderWorkspaceReportHtml({ completedAt: new Date(), durationMs: Date.now() - started,
      selectedContracts: report.members.length, targets: report.runs.length, valid: report.valid,
      entries: report.runs.map((run) => ({ status: run.status, contractLabel: `${run.suite}/${run.member}`, target: run.table ?? run.target ?? "Unresolved member", result: run.result, error: run.error }))
    }, { cspSource: panel.webview.cspSource, styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "dist", "web", "webview.css")).toString(),
      resultColorMode: vscode.workspace.getConfiguration("csvContract").get<ResultColorMode>("resultColorMode", "binary") });
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

import * as vscode from "vscode";
import { stringify } from "yaml";
import { parseCsv } from "./core/contract";
import { acceptBaselineChanges, compareBaseline, CsvSchemaObservation, parseBaseline, resolveBaseline, type SchemaBaseline } from "./core/baseline";
import type { CsvContract } from "./core/model";
import { resolveSqlServerTargets, sqlServerTargetLabel, type ResolvedSqlServerTarget } from "./core/sql-server-targets";
import { configuredTargets, readTargetText } from "./vscode-targets";
import { vscodeSuiteIO } from "./vscode-suites";

export type SqlSchemaReader = (target: ResolvedSqlServerTarget) => Promise<SchemaBaseline>;

export async function editBaseline(uri: vscode.Uri, read: () => CsvContract, write: (c: CsvContract) => Promise<void>, captureSql?: SqlSchemaReader, review = false, effective: (c: CsvContract) => CsvContract = c => c): Promise<void> {
  const original = read();
  const revision = JSON.stringify(original);
  const mode = await vscode.window.showQuickPick(["CSV file", "SQL table/view", "Manual definition"], { title: review ? "Capture current schema for drift review" : "Create schema baseline" });
  if (!mode) return;
  let captured: SchemaBaseline;
  let columnMap: Record<string, string> = {};
  let targetIndex: number | undefined;
  if (mode === "Manual definition") {
    const input = await vscode.window.showInputBox({ title: "Manual columns (JSON array)",
      value: JSON.stringify(Object.keys(original.schema.columns).map((name, i) => ({ name, ordinal: i + 1, required: original.schema.columns[name].presence === "required" }))),
      prompt: "Column objects support sqlType, nullable, maxLength, precision, scale, required and ordinal. No data rows." });
    if (input === undefined) return;
    captured = parseBaseline(JSON.stringify({ baselineVersion: 1, revision: 1, capturedAt: new Date().toISOString(), sourceKind: "manual", captureMethod: "manual", columns: JSON.parse(input) }));
  } else if (mode === "CSV file") {
    const candidates = configuredTargets(uri, original);
    const selected = await vscode.window.showQuickPick([...candidates.map(t => ({ label: t.label, target: t })), { label: "Choose another CSV…", target: undefined }], { title: "CSV baseline source" });
    if (!selected) return;
    let target = selected.target;
    if (!target) {
      const file = (await vscode.window.showOpenDialog({ canSelectMany: false, filters: { CSV: ["csv"] } }))?.[0];
      if (!file) return;
      target = { label: file.fsPath, source: file };
    }
    const csv = parseCsv(await readTargetText(target), original.csv);
    if (csv.parseErrors.length) throw new Error(csv.parseErrors.join("\n"));
    const observation = new CsvSchemaObservation(csv.headers, original.csv);
    csv.rows.forEach(r => observation.add(r));
    captured = observation.snapshot();
  } else {
    if (!captureSql) throw new Error("SQL schema capture requires the desktop extension host.");
    const target = await vscode.window.showQuickPick(resolveSqlServerTargets(effective(original)).map((t, index) => ({ label: sqlServerTargetLabel(t), target: t, index })), { title: "Explicit SQL metadata capture", placeHolder: "Selecting a target reads metadata. Target-list baselines apply only to that target." });
    if (!target) return;
    captured = await captureSql(target.target);
    columnMap = target.target.columnMap ?? {};
    if (original.sqlServer?.targets?.length) targetIndex = target.index;
  }
  let next = captured;
  let baselineUri: vscode.Uri | undefined;
  let baselineText: string | undefined;
  if (review) {
    const binding = targetIndex === undefined ? original.baseline : original.sqlServer?.targets?.[targetIndex].baseline ?? original.baseline;
    const resolved = await resolveBaseline({ ...original, baseline: binding }, uri.toString(), vscodeSuiteIO);
    if (!resolved.baseline || "ref" in resolved.baseline) throw new Error("Create a baseline before reviewing drift.");
    if (binding && "ref" in binding && (targetIndex === undefined || original.sqlServer?.targets?.[targetIndex].baseline)) {
      baselineUri = vscode.Uri.parse(vscodeSuiteIO.resolve(uri.toString(), binding.ref));
      baselineText = await vscodeSuiteIO.read(baselineUri.toString());
    }
    const changes = compareBaseline(resolved.baseline, captured, original, columnMap);
    const selected = await vscode.window.showQuickPick(changes.map(c => ({ label: `${c.severity}: ${c.column} / ${c.kind}`, description: `${JSON.stringify(c.before)} → ${JSON.stringify(c.after)}`, detail: `${c.impact}. ${c.renameCandidate ? `Possible rename of ${c.renameCandidate}. ` : ""}Affected rules: ${c.affectedRules.join(", ") || "none"}`, change: c })), { canPickMany: true, title: "Select baseline changes to accept", placeHolder: "Only selected changes become expectations. Unknown metadata cannot be accepted." });
    if (!selected?.length) return;
    next = acceptBaselineChanges(resolved.baseline, captured, selected.map(c => c.change.id), columnMap);
  }
  const preview = await vscode.workspace.openTextDocument({ content: stringify(next), language: "yaml" });
  await vscode.window.showTextDocument(preview, { viewColumn: vscode.ViewColumn.Beside });
  const accepted = await vscode.window.showInformationMessage(review ? "Accept selected changes as a new baseline revision?" : "Use this schema baseline?", { modal: true, detail: "Review the displayed schema. This changes expectations only, never data or validation rules." }, "Apply baseline");
  if (accepted !== "Apply baseline") return;
  if (JSON.stringify(read()) !== revision) throw new Error("Contract changed during baseline review. Capture and review again.");
  if (baselineUri) {
    const doc = await vscode.workspace.openTextDocument(baselineUri);
    if (doc.getText() !== baselineText) throw new Error("Baseline changed during review. Capture and review again.");
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), stringify(next));
    if (!await vscode.workspace.applyEdit(edit)) throw new Error("Could not apply baseline revision.");
  } else if (targetIndex !== undefined) {
    await write({ ...original, sqlServer: { ...original.sqlServer, targets: original.sqlServer!.targets!.map((target, index) => index === targetIndex ? { ...target, baseline: next } : target) } });
  } else await write({ ...original, baseline: next });
}

import * as vscode from "vscode";
import type { DisplayRun } from "./results-view";
import { summarizeRules, compareRules, type RuleSummary } from "./core/history";
interface HistoryEntry { id: string; at: string; definition: string; runs: { identity: string; status: string; rows?: number; errors?: number; warnings?: number; rules?: RuleSummary[] }[] }
/** A local comparison fingerprint, not a cryptographic identity. Does not retain literals. */
export function definitionFingerprint(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16);
}
export async function manageHistory(context: vscode.ExtensionContext, source: string, runs: DisplayRun[], definition: string, stale = false): Promise<void> {
  const key = `validator.history.${source}`;
  const limit = context.workspaceState.get<number>("validator.history.retention", 20);
  const history = context.workspaceState.get<HistoryEntry[]>(key, []);
  const action = await vscode.window.showQuickPick(["Save summary snapshot", "Compare with saved snapshot", "Set retention limit", "Delete all saved snapshots"], { title: "Local run history", placeHolder: `${history.length}/${limit} snapshots. Only aggregate summaries are retained; no example values.` });
  if (action === "Set retention limit") {
    const value = await vscode.window.showInputBox({ title: "Maximum snapshots per contract or suite", value: String(limit), prompt: "0 disables new snapshots. Existing histories are pruned on their next save; use Delete to remove immediately.", validateInput: value => /^\d+$/.test(value) && Number(value) <= 1000 ? undefined : "Enter an integer from 0 to 1000." });
    if (value !== undefined) { await context.workspaceState.update("validator.history.retention", Number(value)); await context.workspaceState.update(key, Number(value) ? history.slice(-Number(value)) : []); }
    return;
  }
  if (action === "Delete all saved snapshots") { await context.workspaceState.update(key, []); return; }
  const current: HistoryEntry = { id: globalThis.crypto.randomUUID(), at: new Date().toISOString(), definition: definitionFingerprint(definition),
    runs: runs.map(r => ({ identity: JSON.stringify([r.member, r.table ?? r.target]), status: r.status ?? (r.result?.valid ? "PASS" : r.result ? "FAIL" : "ERROR"), rows: r.result?.rowCount, errors: r.result?.errorCount, warnings: r.result?.warningCount, rules: summarizeRules(r.result) })) };
  if (action === "Save summary snapshot") {
    if (stale) throw new Error("Run the current definition before saving history; these results are stale."); if (!limit) throw new Error("History retention is disabled. Set a positive retention limit first.");
    if (!runs.length) throw new Error("Run tests before saving a snapshot.");
    await context.workspaceState.update(key, [...history, current].slice(-limit)); return;
  }
  if (action !== "Compare with saved snapshot") return;
  const selected = await vscode.window.showQuickPick(history.map(entry => ({ label: entry.at, description: entry.definition, entry })), { title: "Compare aggregate history" });
  if (!selected) return;
  const old = new Map(selected.entry.runs.map(r => [r.identity, r]));
  const identities = new Set([...old.keys(), ...current.runs.map(r => r.identity)]);
  const comparison = [...identities].map(identity => {
    const before = old.get(identity), after = current.runs.find(r => r.identity === identity);
    return { identity, before, after, rules: compareRules(before?.rules, after?.rules) };
  });
  const content = JSON.stringify({ warning: selected.entry.definition !== current.definition ? "Definitions changed; verdicts are not directly comparable." : "Same definition fingerprint; target data may have changed.", before: selected.entry.at, after: current.at, comparison }, null, 2);
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: "json", content }), { viewColumn: vscode.ViewColumn.Beside });
}

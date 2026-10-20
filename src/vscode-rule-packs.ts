import * as vscode from "vscode";
import { errorDetails } from "./core/error-details";
import {
  discoverRulePackBindings,
  prepareRulePackUpdateEdit,
  previewRulePackUpdate,
  type RulePackBindingOwner,
  type RulePackUpdatePreview
} from "./node/rule-pack-files";

export const updateRulePackPinCommand = "csv-contract-vsce.updateRulePackPin";
const previewScheme = "csv-contract-rule-pack-preview";

interface PinCandidate {
  document: vscode.TextDocument;
  owner: RulePackBindingOwner;
  label: string;
}

class RulePackPreviewProvider implements vscode.TextDocumentContentProvider {
  private readonly content = new Map<string, string>();
  private sequence = 0;

  create(before: string, after: string): { before: vscode.Uri; after: vscode.Uri } {
    const id = `${Date.now()}-${this.sequence++}`;
    const left = vscode.Uri.from({ scheme: previewScheme, path: `/${id}/before.yaml` });
    const right = vscode.Uri.from({ scheme: previewScheme, path: `/${id}/after.yaml` });
    this.content.set(left.toString(), before);
    this.content.set(right.toString(), after);
    while (this.content.size > 40) this.content.delete(this.content.keys().next().value!);
    return { before: left, after: right };
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.content.get(uri.toString()) ?? "";
  }
}

function requireLocalDocument(document: vscode.TextDocument): string {
  if (document.uri.scheme !== "file") throw new Error("Rule-pack pin updates require a local file-backed contract or suite.");
  return document.uri.fsPath;
}

async function candidatesFor(document: vscode.TextDocument, requestedMemberId?: string): Promise<PinCandidate[]> {
  const source = requireLocalDocument(document);
  const discovery = discoverRulePackBindings(document.getText(), source);
  const candidates = discovery.owners
    .filter(owner => requestedMemberId === undefined || owner.memberId === requestedMemberId)
    .map(owner => ({
      document,
      owner,
      label: owner.memberId ? `${owner.memberId} (inline)` : document.uri.path.split("/").pop() ?? document.uri.toString()
    }));
  for (const reference of discovery.references.filter(reference => requestedMemberId === undefined || reference.memberId === requestedMemberId)) {
    const target = await vscode.workspace.openTextDocument(vscode.Uri.file(reference.source));
    const targetDiscovery = discoverRulePackBindings(target.getText(), requireLocalDocument(target));
    candidates.push(...targetDiscovery.owners.map(owner => ({
      document: target,
      owner,
      label: `${reference.memberId} (referenced source)`
    })));
  }
  if (requestedMemberId !== undefined && !candidates.length &&
      !discovery.references.some(reference => reference.memberId === requestedMemberId)) {
    throw new Error(`Suite member '${requestedMemberId}' was not found or has no rule-pack bindings.`);
  }
  return candidates;
}

async function pickCandidate(candidates: PinCandidate[], requestedUseId?: string): Promise<PinCandidate | undefined> {
  const available = requestedUseId === undefined ? candidates : candidates.filter(candidate => candidate.owner.use.id === requestedUseId);
  if (!available.length) throw new Error(requestedUseId
    ? `Rule-pack binding '${requestedUseId}' was not found.`
    : "The selected contract or suite has no rule-pack bindings.");
  const selected = await vscode.window.showQuickPick(available.map(candidate => ({
    label: candidate.owner.use.id,
    description: candidate.label,
    detail: `${candidate.owner.use.ref} · definition ${candidate.owner.use.definition}`,
    candidate
  })), {
    title: "Preview rule-pack pin update",
    placeHolder: "Choose the exact owning contract binding to review"
  });
  return selected?.candidate;
}

function workspaceRoot(document: vscode.TextDocument): string | undefined {
  return vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
}

function ensurePackHasNoDirtyEditor(preview: RulePackUpdatePreview): void {
  const sources = new Set([preview.referencedSource, ...preview.dependencies.map(item => item.source),
    ...preview.proposedProvenance.map(item => item.source)].map(source => source.toLowerCase()));
  const dirty = vscode.workspace.textDocuments.find(document =>
    document.uri.scheme === "file" && document.isDirty && sources.has(document.uri.fsPath.toLowerCase()));
  if (dirty) throw new Error(`Rule-pack dependency ${dirty.uri.fsPath} has unsaved changes. Save or discard it, then preview again.`);
}

function previewDetail(preview: RulePackUpdatePreview): string {
  const diff = preview.semanticDiff;
  const semantic = !diff ? "Semantic comparison unavailable" : !diff.baselineAvailable
    ? `${diff.proposed.length} proposed checks; pinned pack bytes are unavailable for before/after comparison`
    : `${diff.added.length} added, ${diff.removed.length} removed, ${diff.changed.length} changed, ${diff.unchanged.length} unchanged`;
  const dependencyProblems = preview.dependencies.filter(item => !item.matches || item.error).length;
  const checkLines = !diff ? [] : diff.baselineAvailable
    ? [
        `Added: ${diff.added.map(item => item.id).join(", ") || "none"}`,
        `Removed: ${diff.removed.map(item => item.id).join(", ") || "none"}`,
        `Changed: ${diff.changed.map(item => item.id).join(", ") || "none"}`
      ]
    : [`Candidate checks: ${diff.proposed.map(item => item.id).join(", ") || "none"}`];
  const dependencyLines = preview.dependencies.map(item =>
    `${item.matches && !item.error ? "Verified" : "Invalid"}: ${item.source} (${item.viaUseId})`);
  return [
    `Owning source: ${preview.owner.source}`,
    `Rule pack: ${preview.referencedSource}`,
    `Pinned: ${preview.pinnedSha256}`,
    `Proposed: ${preview.proposedSha256}`,
    `Checks: ${semantic}`,
    ...checkLines,
    `Nested dependencies: ${preview.dependencies.length - dependencyProblems} verified, ${dependencyProblems} invalid`,
    ...dependencyLines,
    `Resolved provenance: ${preview.proposedProvenance.map(item => `${item.packId}/${item.definitionId}@${item.sha256}`).join(", ")}`,
    "The contract is not changed until you choose Apply."
  ].join("\n");
}

/**
 * Preview and explicitly apply one local rule-pack hash update.
 *
 * `uri` may identify a standalone contract or a suite. `memberId` and `useId`
 * optionally narrow invocations from custom UI; Quick Pick still exposes the
 * exact owner before the read-only diff and modal confirmation.
 */
export async function updateRulePackPin(uri?: vscode.Uri, memberId?: string, useId?: string,
  previews = new RulePackPreviewProvider()): Promise<void> {
  const source = uri
    ? await vscode.workspace.openTextDocument(uri)
    : vscode.window.activeTextEditor?.document;
  if (!source) throw new Error("Open a validation contract or suite before updating a rule-pack pin.");
  const selected = await pickCandidate(await candidatesFor(source, memberId), useId);
  if (!selected) return;

  const owner = selected.document;
  await vscode.window.showTextDocument(owner, { preview: false });
  const before = owner.getText();
  const version = owner.version;
  const root = workspaceRoot(owner);
  const preview = await previewRulePackUpdate(requireLocalDocument(owner), before, {
    useId: selected.owner.use.id,
    ...(selected.owner.memberId ? { memberId: selected.owner.memberId } : {}),
    documentVersion: version,
    ...(root ? { workspaceRoot: root } : {})
  });
  ensurePackHasNoDirtyEditor(preview);
  if (preview.status === "invalid") throw new Error(preview.diagnostic ?? "The rule-pack update preview is invalid.");
  if (preview.status === "unchanged") {
    void vscode.window.showInformationMessage(`Rule-pack binding '${preview.owner.use.id}' is already pinned to the current content.`);
    return;
  }
  if (!preview.canApply) throw new Error(preview.diagnostic ?? "The rule-pack update cannot be applied.");

  await prepareRulePackUpdateEdit(preview, {
    documentText: before,
    documentVersion: version,
    ...(root ? { workspaceRoot: root } : {})
  });
  const unavailable = [
    "# Prior pinned rule-pack content is unavailable locally.",
    `# Pinned SHA-256: ${preview.pinnedSha256}`,
    "# Review the complete candidate on the right; no semantic additions/removals are inferred.",
    ""
  ].join("\n");
  const diff = previews.create(preview.beforeText ?? unavailable, preview.proposedText ?? "");
  await vscode.commands.executeCommand("vscode.diff", diff.before, diff.after,
    `Rule-pack content preview: ${selected.label} / ${preview.owner.use.id}`);
  const apply = await vscode.window.showInformationMessage(
    `Apply the reviewed pin update for '${preview.owner.use.id}'?`,
    { modal: true, detail: previewDetail(preview) },
    "Apply"
  );
  if (apply !== "Apply") return;

  ensurePackHasNoDirtyEditor(preview);
  const applyText = owner.getText();
  const applyVersion = owner.version;
  const checked = await prepareRulePackUpdateEdit(preview, {
    documentText: applyText,
    documentVersion: applyVersion,
    ...(root ? { workspaceRoot: root } : {})
  });
  if (owner.version !== applyVersion || owner.getText() !== applyText) {
    throw new Error("The validation document changed during final dependency validation; preview again before applying.");
  }
  const edit = new vscode.WorkspaceEdit();
  edit.replace(owner.uri, new vscode.Range(owner.positionAt(checked.start), owner.positionAt(checked.end)), checked.replacement);
  if (!await vscode.workspace.applyEdit(edit)) throw new Error("VS Code could not apply the reviewed rule-pack pin update.");
  await vscode.window.showTextDocument(owner, { preview: false });
  void vscode.window.showInformationMessage(`Updated rule-pack pin '${preview.owner.use.id}' in ${owner.uri.fsPath}.`);
}

/** Register the desktop rule-pack pin command and its read-only diff provider. */
export function registerRulePackCommands(context: vscode.ExtensionContext): void {
  const previews = new RulePackPreviewProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(previewScheme, previews),
    vscode.commands.registerCommand(updateRulePackPinCommand, async (uri?: vscode.Uri, memberId?: string, useId?: string) => {
      try {
        await updateRulePackPin(uri, memberId, useId, previews);
      } catch (error) {
        void vscode.window.showErrorMessage(`Rule-pack pin was not updated: ${errorDetails(error)}`);
      }
    })
  );
}

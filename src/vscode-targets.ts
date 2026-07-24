import * as vscode from "vscode";
import type { CsvContract, CsvTarget } from "./core/model";

const remoteTargetScheme = "csv-contract-target";

export interface ResolvedTarget {
  label: string;
  source: vscode.Uri | string;
}

export function registerTargetContentProvider(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(remoteTargetScheme, {
    async provideTextDocumentContent(uri): Promise<string> {
      const url = new URLSearchParams(uri.query).get("url");
      if (!url) throw new Error("The remote CSV document does not contain a source URL.");
      return readTargetText({ label: url, source: url });
    }
  }));
}

export function relativeTargetPath(contractUri: vscode.Uri, targetUri: vscode.Uri): string {
  if (contractUri.scheme !== targetUri.scheme || contractUri.authority !== targetUri.authority) {
    return targetUri.fsPath || targetUri.path;
  }
  const contractParts = contractUri.path.split("/").filter(Boolean);
  const targetParts = targetUri.path.split("/").filter(Boolean);
  contractParts.pop();
  if (
    contractUri.scheme === "file"
    && contractParts[0]?.endsWith(":")
    && targetParts[0]?.endsWith(":")
    && contractParts[0].toLowerCase() !== targetParts[0].toLowerCase()
  ) {
    return targetUri.fsPath;
  }
  let common = 0;
  while (
    common < contractParts.length
    && common < targetParts.length
    && (contractUri.scheme === "file"
      ? contractParts[common].toLowerCase() === targetParts[common].toLowerCase()
      : contractParts[common] === targetParts[common])
  ) {
    common += 1;
  }
  const value = [
    ...Array.from({ length: contractParts.length - common }, () => ".."),
    ...targetParts.slice(common)
  ].join("/");
  return value.startsWith(".") ? value : `./${value}`;
}

export function resolveConfiguredTarget(contractUri: vscode.Uri, target: CsvTarget): ResolvedTarget {
  if (target.url !== undefined) return { label: target.url, source: target.url };
  const path = target.path;
  if (/^[a-z]:[\\/]/i.test(path) || path.startsWith("/")) {
    const uri = contractUri.scheme === "file"
      ? vscode.Uri.file(path)
      : contractUri.with({ path: path.replaceAll("\\", "/") });
    return { label: path, source: uri };
  }
  const uri = vscode.Uri.joinPath(contractUri, "..", ...path.split(/[\\/]+/));
  return { label: path, source: uri };
}

export function configuredTargets(contractUri: vscode.Uri, contract: CsvContract): ResolvedTarget[] {
  return (contract.targets ?? []).map((target) => resolveConfiguredTarget(contractUri, target));
}

export function targetKey(target: ResolvedTarget): string {
  return typeof target.source === "string" ? new URL(target.source).toString() : target.source.toString();
}

export async function readTargetText(target: ResolvedTarget): Promise<string> {
  if (typeof target.source !== "string") {
    return new TextDecoder("utf-8").decode(await vscode.workspace.fs.readFile(target.source));
  }
  const response = await fetch(target.source, { redirect: "follow" });
  if (!response.ok) throw new Error(`Unable to download ${target.label}: HTTP ${response.status} ${response.statusText}.`);
  return response.text();
}

export async function openTargetInVsCode(target: ResolvedTarget): Promise<void> {
  const uri = typeof target.source === "string"
    ? remoteTargetDocumentUri(target.source)
    : target.source;
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, { preview: true });
}

export async function openTargetExternally(target: ResolvedTarget): Promise<void> {
  const uri = typeof target.source === "string"
    ? vscode.Uri.parse(target.source)
    : target.source;
  if (!await vscode.env.openExternal(uri)) {
    throw new Error(`Unable to open ${target.label} externally.`);
  }
}

function remoteTargetDocumentUri(url: string): vscode.Uri {
  const parsed = new URL(url);
  let fileName = parsed.pathname.split("/").filter(Boolean).pop() ?? "remote.csv";
  if (!fileName.toLowerCase().endsWith(".csv")) fileName += ".csv";
  return vscode.Uri.from({
    scheme: remoteTargetScheme,
    path: `/${fileName}`,
    query: `url=${encodeURIComponent(parsed.toString())}`
  });
}

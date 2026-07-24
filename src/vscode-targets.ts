import * as vscode from "vscode";
import type { CsvContract, CsvTarget } from "./core/model";

export interface ResolvedTarget {
  label: string;
  source: vscode.Uri | string;
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

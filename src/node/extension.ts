import type * as vscode from "vscode";
import { activate as activateShared, deactivate } from "../extension";
import { compareCsvFilesDesktop } from "./semantic-comparison";

export function activate(context: vscode.ExtensionContext): void {
  activateShared(context, compareCsvFilesDesktop);
}

export { deactivate };

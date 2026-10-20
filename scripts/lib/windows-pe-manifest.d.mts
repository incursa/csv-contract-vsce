export interface VerifiedWindowsManifest {
  level: "asInvoker";
  uiAccess: "false";
}

export function verifyAsInvokerManifestText(manifest: string): VerifiedWindowsManifest;
export function verifyAsInvokerExecutable(path: string): Promise<VerifiedWindowsManifest & {
  manifest: string;
  manifestCount: number;
}>;

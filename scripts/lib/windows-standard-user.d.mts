export interface WindowsProcessTokenResult {
  verified: boolean;
  reason?: string;
  pid?: number;
  elevated?: boolean;
  elevationType?: string;
  integrityRid?: number;
  integrity?: string;
  administratorsPresent?: boolean;
  administratorsEnabled?: boolean;
  administratorsDenyOnly?: boolean;
}

export function inspectWindowsProcessToken(pid: number): WindowsProcessTokenResult;
export function inspectWindowsStandardUserToken(): WindowsProcessTokenResult;

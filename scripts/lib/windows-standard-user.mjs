/* global Buffer, process */
import { spawnSync } from "node:child_process";

const TOKEN_SCRIPT = String.raw`
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class IncursaTokenProbe {
  const uint PROCESS_QUERY_LIMITED_INFORMATION=0x1000, TOKEN_QUERY=0x0008, SE_GROUP_ENABLED=0x4, SE_GROUP_USE_FOR_DENY_ONLY=0x10;
  [StructLayout(LayoutKind.Sequential)] struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct TOKEN_GROUPS_ONE { public uint GroupCount; public SID_AND_ATTRIBUTES Groups; }
  public sealed class Result { public int pid; public bool elevated; public string elevationType; public int integrityRid; public string integrity; public bool administratorsPresent; public bool administratorsEnabled; public bool administratorsDenyOnly; }
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int tokenClass,IntPtr info,int length,out int required);
  [DllImport("advapi32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool ConvertSidToStringSid(IntPtr sid,out IntPtr text);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  [DllImport("advapi32.dll",SetLastError=true)] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
  [DllImport("advapi32.dll",SetLastError=true)] static extern IntPtr GetSidSubAuthority(IntPtr sid,uint index);
  static IntPtr Query(IntPtr token,int tokenClass,out int size) { GetTokenInformation(token,tokenClass,IntPtr.Zero,0,out size); if(size<=0) throw new Win32Exception(Marshal.GetLastWin32Error()); IntPtr buffer=Marshal.AllocHGlobal(size); if(!GetTokenInformation(token,tokenClass,buffer,size,out size)){Marshal.FreeHGlobal(buffer);throw new Win32Exception(Marshal.GetLastWin32Error());} return buffer; }
  static string SidText(IntPtr sid) { IntPtr text; if(!ConvertSidToStringSid(sid,out text)) throw new Win32Exception(Marshal.GetLastWin32Error()); try{return Marshal.PtrToStringUni(text);}finally{LocalFree(text);} }
  public static Result Inspect(int pid) {
    IntPtr process=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,false,pid); if(process==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error()); IntPtr token=IntPtr.Zero;
    try {
      if(!OpenProcessToken(process,TOKEN_QUERY,out token)) throw new Win32Exception(Marshal.GetLastWin32Error()); int size;
      IntPtr elevation=Query(token,20,out size), type=Query(token,18,out size), integrity=Query(token,25,out size), groups=Query(token,2,out size);
      try {
        bool isElevated=Marshal.ReadInt32(elevation)!=0; int elevationType=Marshal.ReadInt32(type); IntPtr sid=Marshal.ReadIntPtr(integrity); byte count=Marshal.ReadByte(GetSidSubAuthorityCount(sid)); int integrityRid=Marshal.ReadInt32(GetSidSubAuthority(sid,(uint)(count-1)));
        bool adminPresent=false,adminEnabled=false,adminDenyOnly=false; int groupCount=Marshal.ReadInt32(groups), offset=Marshal.OffsetOf(typeof(TOKEN_GROUPS_ONE),"Groups").ToInt32(), stride=Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES));
        for(int index=0;index<groupCount;index++){var group=(SID_AND_ATTRIBUTES)Marshal.PtrToStructure(IntPtr.Add(groups,offset+index*stride),typeof(SID_AND_ATTRIBUTES));if(SidText(group.Sid)!="S-1-5-32-544")continue;adminPresent=true;adminEnabled=(group.Attributes&SE_GROUP_ENABLED)!=0;adminDenyOnly=(group.Attributes&SE_GROUP_USE_FOR_DENY_ONLY)!=0;}
        return new Result{pid=pid,elevated=isElevated,elevationType=elevationType==1?"Default":elevationType==2?"Full":elevationType==3?"Limited":"Unknown-"+elevationType,integrityRid=integrityRid,integrity=integrityRid==0x1000?"low":integrityRid==0x2000?"medium":integrityRid==0x2100?"medium-plus":integrityRid==0x3000?"high":integrityRid==0x4000?"system":"rid-"+integrityRid,administratorsPresent=adminPresent,administratorsEnabled=adminEnabled,administratorsDenyOnly=adminDenyOnly};
      } finally { Marshal.FreeHGlobal(elevation);Marshal.FreeHGlobal(type);Marshal.FreeHGlobal(integrity);Marshal.FreeHGlobal(groups); }
    } finally { if(token!=IntPtr.Zero)CloseHandle(token);CloseHandle(process); }
  }
}`;

function powershellProbe(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid Windows process ID: ${pid}`);
  const command = `Add-Type -TypeDefinition @'\n${TOKEN_SCRIPT}\n'@; [IncursaTokenProbe]::Inspect(${pid}) | ConvertTo-Json -Compress`;
  const encoded = Buffer.from(command, "utf16le").toString("base64");
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Windows token inspection failed with exit ${result.status}: ${result.stderr || result.stdout}`.trim());
  return JSON.parse(result.stdout.trim());
}

function qualifiesAsStandardDesktopToken(result) {
  return !result.elevated
    && (result.elevationType === "Default" || result.elevationType === "Limited")
    && result.integrityRid === 0x2000
    && !result.administratorsEnabled
    && (!result.administratorsPresent || result.administratorsDenyOnly);
}

/** Inspect an existing Windows process token without mutating it. */
export function inspectWindowsProcessToken(pid) {
  if (process.platform !== "win32") return { verified: false, reason: "Windows token verification is unavailable on this platform." };
  const token = powershellProbe(pid);
  return qualifiesAsStandardDesktopToken(token) ? { verified: true, ...token } : { verified: false, reason: `Process ${pid} is not a verified standard desktop token.`, ...token };
}

/** Verify the packaging Node process is non-elevated at medium integrity. */
export function inspectWindowsStandardUserToken() { return inspectWindowsProcessToken(process.pid); }

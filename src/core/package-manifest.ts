import type { ValidationResult } from "./model";

/** The version of the portable validation-package envelope. */
export const PACKAGE_SCHEMA_VERSION = "1";
export const TOOL_VERSION = "0.22.0";

export interface PackageManifestOptions {
  kind?: "contract" | "suite";
  identity?: string;
  definition?: unknown;
  runId?: string;
  evaluatedAt?: string;
  scope?: string | string[];
  sourceLabels?: string[];
  targetIdentities?: string[];
  targetSources?: Array<{ id: string; source?: string }>;
  sampled?: boolean;
  truncated?: boolean;
  retainedIssueDetails?: number;
  reportedIssues?: number;
  evidenceSettings?: Record<string, unknown>;
  notices?: string[];
}

export interface PackageManifest {
  packageSchemaVersion: typeof PACKAGE_SCHEMA_VERSION;
  toolVersion: string;
  identity: { kind: "contract" | "suite"; id: string; definitionFingerprint: string };
  run: { id: string; evaluatedAt?: string };
  selectedScope: string | string[];
  sourceLabels: string[];
  targets: Array<{ id: string; source?: string }>;
  evidence: {
    retention: Record<string, unknown>;
    sampled: boolean;
    truncated: boolean;
    complete: boolean;
  };
  completenessNotices: string[];
}

function safe(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safe);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !/(password|secret|credential|connection|string|token|apiKey|accessKey|privateKey)/i.test(key))
    .sort(([a], [b]) => compareStable(a, b)).map(([key, item]) => [key, safe(item)]));
}

/** Remove connection and credential material before values enter a package. */
function portable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(portable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !/(password|secret|credential|connection|string|token|apiKey|accessKey|privateKey)/i.test(key))
    .sort(([a], [b]) => compareStable(a, b))
    .map(([key, item]) => [key, portable(item)]));
}

function stable(value: unknown): string {
  return JSON.stringify(safe(value));
}

function compareStable(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

// A deterministic, non-secret-bearing content fingerprint suitable for package identity.
function fingerprint(value: unknown): string {
  const text = stable(value);
  let a = 2166136261n;
  let b = 1099511628211n;
  for (const char of text) {
    const code = BigInt(char.codePointAt(0)!);
    a = BigInt.asUintN(64, (a ^ code) * 1099511628211n);
    b = BigInt.asUintN(64, (b ^ (code + 31n)) * 14029467366897019727n);
  }
  return `${a.toString(16).padStart(16, "0")}${b.toString(16).padStart(16, "0")}`;
}

function notice(options: PackageManifestOptions, sampled: boolean, truncated: boolean): string[] {
  return [...new Set([
    ...(sampled ? ["Validation used sampled evidence; completeness is limited to the selected sample."] : []),
    ...(truncated ? ["Issue details were truncated by the evidence-retention limit; counts remain authoritative."] : []),
    ...(options.notices ?? [])
  ])];
}

export function createPackageManifest(options: PackageManifestOptions = {}): PackageManifest {
  const sampled = options.sampled ?? false;
  const truncated = options.truncated ?? false;
  const reported = options.reportedIssues ?? 0;
  const retained = options.retainedIssueDetails ?? reported;
  const targetSources = options.targetSources
    ? [...new Map(options.targetSources.map(target => [`${target.id}\u0000${target.source ?? ""}`, target])).values()]
      .map(target => ({ id: target.id, ...(target.source === undefined ? {} : { source: target.source }) }))
      .sort((a, b) => compareStable(a.id, b.id) || compareStable(a.source ?? "", b.source ?? ""))
    : undefined;
  const targets = [...new Set(options.targetIdentities ?? [])].sort(compareStable);
  const sources = [...new Set((options.sourceLabels ?? []).filter(Boolean))].sort(compareStable);
  const identity = options.identity ?? "validation-package";
  const runId = options.runId ?? fingerprint({ identity, scope: options.scope ?? "all", targets, evaluatedAt: options.evaluatedAt });
  return {
    packageSchemaVersion: PACKAGE_SCHEMA_VERSION,
    toolVersion: TOOL_VERSION,
    identity: { kind: options.kind ?? "contract", id: identity, definitionFingerprint: fingerprint(options.definition ?? identity) },
    run: { id: runId, ...(options.evaluatedAt ? { evaluatedAt: options.evaluatedAt } : {}) },
    selectedScope: options.scope ?? "all",
    sourceLabels: sources,
    targets: targetSources ?? targets.map((id, index) => ({ id, ...(sources[index] ? { source: sources[index] } : {}) })),
    evidence: { retention: { ...(portable(options.evidenceSettings ?? {}) as Record<string, unknown>), reportedIssueDetails: reported, retainedIssueDetails: retained }, sampled, truncated, complete: !sampled && !truncated && retained >= reported },
    completenessNotices: notice(options, sampled, truncated)
  };
}

export function manifestFromRuns(identity: string, runs: Array<{ target?: string; table?: string; member?: string; spec?: string; runId?: string; evaluatedAt?: string; scope?: string; result?: ValidationResult; status?: string }>, definition?: unknown, kind: "contract" | "suite" = "contract"): PackageManifest {
  const results = runs.map(run => run.result).filter((result): result is ValidationResult => Boolean(result));
  const reported = results.reduce((sum, result) => sum + result.issueCount, 0);
  const retained = results.reduce((sum, result) => sum + result.issues.length, 0);
  const targetSources = runs.map(run => { const target = run.target ?? run.table ?? "unknown"; return { id: kind === "suite" ? `${run.member ?? "member"}/${target}` : target, source: run.spec }; });
  return createPackageManifest({ kind, identity, definition: definition ?? identity, runId: runs.find(run => run.runId)?.runId,
    evaluatedAt: runs.find(run => run.evaluatedAt)?.evaluatedAt ?? runs.find(run => run.result?.evaluatedAt)?.result?.evaluatedAt, scope: runs.find(run => run.scope)?.scope ?? "all",
    targetIdentities: targetSources.map(target => target.id), targetSources, sourceLabels: runs.map(run => run.spec ?? ""),
    sampled: results.some(result => result.preview?.scope === "sample"), truncated: results.some(result => result.truncated) || retained < reported,
    retainedIssueDetails: retained, reportedIssues: reported,
    evidenceSettings: { runCount: runs.length, statuses: [...new Set(runs.map(run => run.status).filter(Boolean))].sort() } });
}

export function contractDefinitionFingerprint(contract: unknown): string { return fingerprint(contract); }
export function suiteDefinitionFingerprint(suite: unknown): string { return fingerprint(suite); }

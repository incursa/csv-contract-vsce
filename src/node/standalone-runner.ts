import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveBaseline, resolveTargetBaseline } from "../core/baseline";
import { evaluateCsvCrossCheck } from "../core/cross-checks";
import { parseCsv } from "../core/contract";
import { createValidationReviewPackage, reviewFingerprint, type ValidationReviewPackage } from "../core/review-package";
import { loadSuite, runSuite, type LoadedSuite, type SuiteRun } from "../core/suite";
import { sqlServerConnectionLabel } from "../core/sql-server-targets";
import { resolveSuiteSqlServerTargets } from "../core/suite-target-policy";
import { renderValidationReportHtml } from "../validation-report";
import { hasCompleteReviewDefinition, reviewDefinitionText } from "../core/review-provenance";
import { SqlServerValidationSession } from "./sql-server-validator";
import { createCrossConnectionSourceAdapter, runCrossConnectionCheck } from "./cross-connection-runner";
import { validateCsvFile } from "./streaming-validator";
import { fileSuiteIO } from "./suite-files";
import { isHttpTarget, resolveConfiguredTarget } from "./target-plan";
import { withMaterializedTarget } from "./target-source";

export interface StandaloneTarget {
  id: string;
  member: string;
  kind: "csv" | "sql-server" | "cross-check";
  label: string;
  allowed: boolean;
  reason?: string;
}

export interface StandaloneDefinition {
  path: string;
  id: string;
  name?: string;
  kind: "definition" | "suite";
  targets: StandaloneTarget[];
  errors: string[];
  fingerprint: string;
}

export interface StandaloneRunProgress {
  phase: "starting" | "running" | "complete";
  completed: number;
  total: number;
  target?: string;
  rows?: number;
  bytesRead?: number;
}

export interface StandaloneRunOptions {
  targetIds: string[];
  signal?: AbortSignal;
  includeDetails?: boolean;
  maxIssues?: number;
  toolVersion?: string;
  /** Inspection fingerprint presented to the user. A changed definition must be reopened and reconfirmed. */
  expectedFingerprint?: string;
  onProgress?: (progress: StandaloneRunProgress) => void;
}

export interface StandaloneRunResult {
  report: Awaited<ReturnType<typeof runSuite>>;
  reviewPackage: ValidationReviewPackage;
  reviewJson: string;
  reportHtml: string;
}

function targetId(member: string, kind: "csv" | "sql-server", index: number): string {
  return `${encodeURIComponent(member)}:${kind}:${index}`;
}

function definitionFromSuite(path: string, suite: LoadedSuite): Omit<StandaloneDefinition, "fingerprint"> {
  const targets: StandaloneTarget[] = [];
  const errors: string[] = [];
  for (const member of suite.members) {
    if (member.error || !member.contract) {
      errors.push(`${suite.id}/${member.id}: ${member.error ?? "Contract was not loaded."}`);
      continue;
    }
    for (const [index, target] of (member.contract.targets ?? []).filter((item) => item.enabled !== false).entries()) {
      try {
        const resolved = resolveConfiguredTarget(member.source, target);
        const remote = isHttpTarget(resolved);
        targets.push({
          id: targetId(member.id, "csv", index), member: member.id, kind: "csv", label: resolved,
          allowed: !remote,
          ...(remote ? { reason: "Remote URL targets are disabled in the standalone runner." } : {})
        });
      } catch (error) {
        targets.push({ id: targetId(member.id, "csv", index), member: member.id, kind: "csv", label: target.path ?? target.url ?? "CSV target", allowed: false,
          reason: error instanceof Error ? error.message : String(error) });
      }
    }
    try {
      for (const effective of resolveSuiteSqlServerTargets(member.contract, suite.targetPolicy, member.targetOverrides, true, member.targetOverrideMode).targets) {
        const target = effective.resolvedTarget;
        targets.push({ id: targetId(member.id, "sql-server", effective.index), member: member.id, kind: "sql-server",
          label: target ? `${sqlServerConnectionLabel(target)}:${target.schema}.${target.table}` : `${effective.target.schema}.${effective.target.table}`,
          allowed: effective.enabled, ...(!effective.enabled ? { reason: `Disabled by ${effective.enabledSource}.` } : {}) });
      }
    } catch (error) {
      errors.push(`${suite.id}/${member.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const check of suite.crossChecks ?? []) for (const matrix of suite.targetMatrix?.length ? suite.targetMatrix : [undefined]) {
    const suffix = matrix ? `@${matrix.id}` : "";
    targets.push({ id: `cross:${check.id}${suffix}`, member: `cross:${check.id}${suffix}`, kind: "cross-check",
      label: `Cross-check ${check.id}${matrix ? ` (${matrix.name ?? matrix.id})` : ""}`, allowed: true });
  }
  return { path, id: suite.id, kind: suite.isSuite ? "suite" : "definition", targets, errors };
}

async function loadStandaloneSnapshot(path: string) {
  const suite = await loadSuite(path, fileSuiteIO);
  const definitions = [
    { source: path, text: await readFile(path, "utf8") },
    ...suite.members.flatMap((member) => member.contract
      ? [{ source: `${member.source}#member=${encodeURIComponent(member.id)}`, text: reviewDefinitionText(member.contract) }]
      : [])
  ];
  const summary = definitionFromSuite(path, suite);
  return { suite, definitions, definition: { ...summary, fingerprint: reviewFingerprint({ definitions, targets: summary.targets }) } };
}

export async function inspectStandaloneDefinition(inputPath: string): Promise<StandaloneDefinition> {
  const path = resolve(inputPath);
  return (await loadStandaloneSnapshot(path)).definition;
}

function assertConfirmedTargets(definition: StandaloneDefinition, targetIds: string[]): void {
  const expected = definition.targets.filter((target) => target.allowed).map((target) => target.id).sort();
  const supplied = [...new Set(targetIds)].sort();
  const blocked = definition.targets.filter((target) => !target.allowed && supplied.includes(target.id));
  if (blocked.length) throw new Error(`Blocked targets cannot run: ${blocked.map((target) => target.label).join(", ")}.`);
  if (expected.length === 0) throw new Error("The loaded definition has no allowed targets.");
  if (expected.length !== supplied.length || expected.some((id, index) => id !== supplied[index])) {
    throw new Error("Confirm every allowed target shown from the loaded definition before running.");
  }
}

export async function runStandaloneDefinition(inputPath: string, options: StandaloneRunOptions): Promise<StandaloneRunResult> {
  const path = resolve(inputPath);
  const { suite, definitions, definition } = await loadStandaloneSnapshot(path);
  if (options.expectedFingerprint && options.expectedFingerprint !== definition.fingerprint) {
    throw new Error("The loaded definition, suite, policy, or target list changed. Reopen it and confirm the targets again.");
  }
  if (definition.errors.length) throw new Error(definition.errors.join("\n"));
  assertConfirmedTargets(definition, options.targetIds);
  options.signal?.throwIfAborted();
  const maxIssues = options.includeDetails ? Math.max(1, options.maxIssues ?? 1000) : 1;
  let completed = 0;
  const total = definition.targets.filter((target) => target.allowed).length;
  options.onProgress?.({ phase: "starting", completed, total });

  const session = new SqlServerValidationSession((profile) => {
    const environmentName = `CSV_CONTRACT_SQLSERVER_${profile.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
    const connectionString = process.env[environmentName];
    if (!connectionString) throw new Error(`Connection profile '${profile}' requires environment variable ${environmentName}.`);
    return connectionString;
  });
  let report: Awaited<ReturnType<typeof runSuite>>;
  try {
    report = await runSuite(suite, async (contract, target, source, _index, onProgress) => session.validate(
      await resolveBaseline(contract, source, fileSuiteIO),
      await resolveTargetBaseline(target, source, fileSuiteIO),
      { maxIssues, signal: options.signal, onProgress }
    ), false, async (contract, source, target, _index, onProgress) => {
      const resolved = resolveConfiguredTarget(source, target);
      if (isHttpTarget(resolved)) throw new Error("Remote URL targets are disabled in the standalone runner.");
      return withMaterializedTarget(resolved, {}, async (localPath) => {
        const output = await validateCsvFile(localPath, [{ spec: source, contract: await resolveBaseline(contract, source, fileSuiteIO) }],
          { maxIssues, signal: options.signal, onProgress: (progress) => onProgress?.({
            phase: "reading", rowsRead: progress.rows, bytesRead: progress.bytesRead
          }) });
        return output.runs[0].result;
      });
    }, {
      signal: options.signal,
      parallelMembers: 4,
      parallelTargets: 4,
      onTargetProgress: (target, progress) => options.onProgress?.({ phase: "running", completed, total, target: target.target ?? target.table,
        rows: progress.rowsRead, bytesRead: progress.bytesRead }),
      onProgress: (run) => {
        completed += 1;
        options.onProgress?.({ phase: "running", completed, total, target: run.target ?? run.table });
      },
      crossExecutor: async (plan, signal) => {
        if (plan.mode === "sql") return session.validateCross(plan, signal);
        if (plan.mode === "sql-cross-connection") return runCrossConnectionCheck(plan,
          createCrossConnectionSourceAdapter(session.readBoundedRows.bind(session)), { signal });
        const read = async (participant: typeof plan.from) => {
          const configured = resolveConfiguredTarget(participant.source, participant.target);
          if (isHttpTarget(configured)) throw new Error("Remote URL targets are disabled in the standalone runner.");
          return withMaterializedTarget(configured, {}, async (localPath) => parseCsv(await readFile(localPath, "utf8"), participant.contract.csv));
        };
        const [from, to, participants] = await Promise.all([
          read(plan.from), read(plan.to),
          Promise.all(Object.entries(plan.participants).map(async ([id, participant]) => [id, await read(participant)] as const)).then(Object.fromEntries)
        ]);
        return evaluateCsvCrossCheck(plan, from, to, participants);
      }
    });
  } finally {
    await session.dispose();
  }

  const definitionSources = new Map(suite.members.map((member) => [member.id,
    [path, `${member.source}#member=${encodeURIComponent(member.id)}`]]));
  const definitionBindings: Record<string, string[]> = {};
  const runs = report.runs.map((run: SuiteRun) => {
    const bound = run.member.startsWith("cross:") ? definitions.map((item) => item.source) : definitionSources.get(run.member) ?? [path];
    if (run.workId) definitionBindings[run.workId] = bound;
    return ({
    target: run.target ?? run.table ?? `${run.suite}/${run.member}`,
    status: run.status,
    result: run.result,
    error: run.error,
    runId: run.runId,
    workId: run.workId,
    evaluatedAt: run.evaluatedAt,
    scope: run.scope
  }); });
  const completeDefinitionCoverage = suite.members.every((member) => !!member.contract && hasCompleteReviewDefinition(member.contract));
  const reviewPackage = createValidationReviewPackage({ source: path, runs, toolVersion: options.toolVersion,
    ...(completeDefinitionCoverage ? { definitions, definitionBindings } : { provenance: { definitionCoverage: "dependency-snapshots-unavailable" } }) },
    options.includeDetails ? { evidence: { mode: "detail" } } : { evidence: { mode: "aggregate-only" } });
  const reviewJson = JSON.stringify(reviewPackage, null, 2);
  const reportHtml = renderValidationReportHtml(reviewPackage);
  options.onProgress?.({ phase: "complete", completed: total, total });
  return { report, reviewPackage, reviewJson, reportHtml };
}

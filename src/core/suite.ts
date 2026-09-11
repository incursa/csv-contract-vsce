import { errorDetails } from "./error-details";
import { resolveEvaluation } from "./evaluation";
import { planCrossCheck, type CrossCheck, type CrossExecutor } from "./cross-checks";
import { isScalar, parseDocument, stringify, visit } from "yaml";
import { parseContract } from "./contract";
import type { CsvContract, CsvTarget, SqlServerIntegratedConnection, ValidationResult } from "./model";
import { resolveSqlServerTargets, type ResolvedSqlServerTarget } from "./sql-server-targets";
import { generateSqlServerValidation } from "./sql-server-generator";
import Ajv from "ajv/dist/2020";
import contractSchema from "../../schemas/csvtest.schema.json";

const validateContractShape = new Ajv({ strict: false, allErrors: true, validateFormats: false }).compile(contractSchema);

export interface SuiteConnection {
  connection?: string;
  integratedConnection?: SqlServerIntegratedConnection;
}
export interface ContractSuite {
  crossChecks?: CrossCheck[];
  suiteVersion: 1;
  id: string;
  name?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  defaults?: SuiteConnection;
  members: { id: string; ref?: string; contract?: CsvContract; name?: string; description?: string; metadata?: Record<string, unknown> }[];
}
export interface SuiteIO {
  read(location: string): Promise<string>;
  resolve(containing: string, reference: string): string;
  canonical?(location: string): Promise<string>;
}
export interface LoadedMember {
  connectionOrigins?: string[];
  id: string;
  source: string;
  contract?: CsvContract;
  error?: string;
}
export interface LoadedSuite {
  crossChecks?: CrossCheck[];
  id: string;
  source: string;
  isSuite: boolean;
  members: LoadedMember[];
}

export function yamlDocument(text: string) {
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length || doc.warnings.length) throw new Error([...doc.errors, ...doc.warnings].map((e) => e.message).join("; "));
  // Limit alias expansion and reject non-JSON data rather than changing its meaning.
  doc.toJS({ maxAliasCount: 100 });
  visit(doc, (_, node) => {
    if (isScalar(node) && typeof node.value === "number" && (!Number.isFinite(node.value) || (Number.isInteger(node.value) && !Number.isSafeInteger(node.value)))) {
      throw new Error("Numeric literal cannot be represented losslessly; quote identifiers and out-of-range numbers as strings.");
    }
  });
  return doc;
}
export function isSuiteText(text: string): boolean {
  return yamlDocument(text).has("suiteVersion");
}
function keys(value: object, allowed: string[], context: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${context}: unsupported fields ${unknown.join(", ")}; use metadata for annotations.`);
}
function connectionSettings(value: SuiteConnection, context: string): void {
  keys(value, ["connection", "integratedConnection"], context);
  if (value.connection !== undefined && (typeof value.connection !== "string" || !/^[A-Za-z0-9._-]+$/.test(value.connection))) throw new Error(`${context}: connection must be a profile name, never a connection string.`);
  if (value.connection !== undefined && value.integratedConnection !== undefined) throw new Error(`${context}: choose connection or integratedConnection, not both.`);
  if (value.integratedConnection) {
    keys(value.integratedConnection, ["server", "database", "odbcDriver", "encrypt", "trustServerCertificate"], context);
    if (!value.integratedConnection.server?.trim() || !value.integratedConnection.database?.trim()) throw new Error(`${context}: integratedConnection requires server and database.`);
  }
}
export function parseSuite(text: string): ContractSuite {
  const suite = yamlDocument(text).toJS({ maxAliasCount: 100 }) as ContractSuite;
  if (!suite || suite.suiteVersion !== 1 || typeof suite.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(suite.id)) throw new Error("Suite requires suiteVersion: 1 and a non-empty id using letters, numbers, dots, underscores or hyphens.");
  keys(suite, ["suiteVersion", "id", "name", "description", "metadata", "defaults", "members", "crossChecks"], `Suite ${suite.id}`);
  if (suite.defaults) connectionSettings(suite.defaults, `Suite ${suite.id} defaults`);
  if (!Array.isArray(suite.members) || !suite.members.length) throw new Error(`Suite ${suite.id} requires at least one member.`);
  const ids = new Set<string>();
  for (const member of suite.members) {
    if (!member || typeof member.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(member.id)) throw new Error(`Suite ${suite.id}: each member needs a stable id.`);
    if (ids.has(member.id)) throw new Error(`Suite ${suite.id}: duplicate member id '${member.id}'.`);
    ids.add(member.id);
    keys(member, ["id", "ref", "contract", "name", "description", "metadata"], `Member ${member.id}`);
    if ((member.ref !== undefined) === (member.contract !== undefined)) throw new Error(`Member ${member.id}: declare exactly one of ref or contract.`);
    if (member.ref !== undefined && (typeof member.ref !== "string" || !member.ref.trim())) throw new Error(`Member ${member.id}: ref must be a non-empty file path.`);
  }
  const checks = new Set<string>();
  if (suite.crossChecks !== undefined && !Array.isArray(suite.crossChecks)) throw new Error("crossChecks must be an array.");
  for (const check of suite.crossChecks ?? []) {
    if (!check || !/^[a-z0-9][a-z0-9._-]*$/.test(check.id) || checks.has(check.id) || !ids.has(check.from) || !ids.has(check.to) || !["foreignKey", "equalPopulation", "equalTotal"].includes(check.kind)) throw new Error("Invalid cross-check identity, kind or member dependency.");
    keys(check, ["id", "kind", "from", "to", "keys", "valueColumns", "tolerance", "nulls", "severity"], `Cross-check ${check.id}`);
    if (check.keys !== undefined && (!Array.isArray(check.keys) || !check.keys.length || check.keys.some(k => !k || typeof k.from !== "string" || typeof k.to !== "string" || Object.keys(k).some(p => !["from", "to"].includes(p))))) throw new Error("Invalid cross-check key mappings.");
    if (check.valueColumns !== undefined && (!check.valueColumns || typeof check.valueColumns.from !== "string" || typeof check.valueColumns.to !== "string" || Object.keys(check.valueColumns).some(p => !["from", "to"].includes(p)))) throw new Error("Invalid total value columns.");
    if (check.tolerance !== undefined && (typeof check.tolerance !== "string" || !/^(?:0|[1-9]\d{0,17})(?:\.\d{1,10})?$/.test(check.tolerance))) throw new Error("Invalid total tolerance.");
    if (check.kind === "foreignKey" && !check.keys?.length || check.kind === "equalTotal" && !check.valueColumns) throw new Error("Cross-check requires keys or total value columns.");
    if (check.nulls !== undefined && !["ignore", "fail"].includes(check.nulls)) throw new Error("Invalid cross-check null policy.");
    if (check.severity !== undefined && !["warning", "error"].includes(check.severity)) throw new Error("Invalid cross-check severity.");
    checks.add(check.id);
  }
  return suite;
}

/** Connection alternatives are atomic; a higher priority alternative replaces the lower one. */
export function effectiveContract(contract: CsvContract, defaults?: SuiteConnection): CsvContract {
  const copy = structuredClone(contract);
  if (!copy.sqlServer) return copy;
  const settings = copy.sqlServer;
  const own = (value: SuiteConnection): SuiteConnection | undefined => value.connection !== undefined || value.integratedConnection !== undefined
    ? { ...(value.connection !== undefined ? { connection: value.connection } : {}), ...(value.integratedConnection !== undefined ? { integratedConnection: value.integratedConnection } : {}) } : undefined;
  const inherited = own(settings) ?? defaults;
  if (settings.targets?.length) {
    settings.targets = settings.targets.map((target) => ({ ...((own(target) ?? inherited) ?? {}), ...target }));
  } else if (!own(settings) && defaults) Object.assign(settings, defaults);
  return copy;
}

export async function loadSuite(source: string, io: SuiteIO, ancestors: string[] = []): Promise<LoadedSuite> {
  const canonical = await io.canonical?.(source) ?? source;
  if (ancestors.includes(canonical)) throw new Error(`Reference cycle: ${[...ancestors, canonical].join(" -> ")}`);
  const text = await io.read(source);
  if (!isSuiteText(text)) return { id: source, source, isSuite: false, members: [{ id: source, source, contract: parseContract(text) }] };
  const suite = parseSuite(text);
  const members: LoadedMember[] = [];
  for (const member of suite.members) {
    const location = member.ref ? io.resolve(source, member.ref) : source;
    try {
      let contract = member.contract;
      if (member.ref) {
        const loaded = await loadSuite(location, io, [...ancestors, canonical]);
        if (loaded.isSuite) {
          const cycle = loaded.members.find((entry) => entry.error?.includes("Reference cycle"));
          throw new Error(cycle?.error ?? "References must point to individual contracts; nested suites are not supported.");
        }
        contract = loaded.members[0].contract;
      }
      contract = parseContract(stringify(contract));
      if (!validateContractShape(contract)) throw new Error(`Invalid contract: ${JSON.stringify(validateContractShape.errors)}`);
      const own = (value: SuiteConnection | undefined) => value?.connection !== undefined || value?.integratedConnection !== undefined;
      const connectionOrigins = contract.sqlServer?.targets?.map(target => own(target) ? "table override" : own(contract.sqlServer) ? "contract" : own(suite.defaults) ? "suite default" : "unconfigured")
        ?? (contract.sqlServer ? [own(contract.sqlServer) ? "contract" : own(suite.defaults) ? "suite default" : "unconfigured"] : []);
      members.push({ id: member.id, source: location, contract: effectiveContract(contract, suite.defaults), connectionOrigins });
    } catch (error) {
      members.push({ id: member.id, source: location, error: errorDetails(error) });
    }
  }
  return { id: suite.id, source, isSuite: true, members, ...(suite.crossChecks ? { crossChecks: suite.crossChecks } : {}) };
}

export type SuiteStatus = "PASS" | "FAIL" | "ERROR" | "SKIPPED" | "CANCELED" | "SAMPLED";
export interface SuiteRun {
  workId?: string;
  runId?: string;
  evaluatedAt?: string;
  scope?: string;
  durationMs?: number;
  suite: string;
  member: string;
  spec: string;
  table?: string;
  target?: string;
  status: SuiteStatus;
  result?: ValidationResult;
  error?: string;
}
export async function runSuite(suite: LoadedSuite, validate: (contract: CsvContract, target: ResolvedSqlServerTarget, source: string) => Promise<ValidationResult>, failFast = false,
  validateFile?: (contract: CsvContract, source: string, target: CsvTarget) => Promise<ValidationResult>,
  controls: { signal?: AbortSignal; members?: string[]; onProgress?: (run: SuiteRun) => void; crossExecutor?: CrossExecutor } = {}) {
  const runs: SuiteRun[] = [];
  const runId = globalThis.crypto.randomUUID();
  const startedAt = new Date().toISOString();
  let stopped = false;
  for (const member of suite.members) {
    const base = { suite: suite.id, member: member.id, spec: member.source };
    if (controls.signal?.aborted) { runs.push({ ...base, status: "CANCELED", error: "Canceled before member execution." }); continue; }
    if (controls.members && !controls.members.includes(member.id)) { runs.push({ ...base, status: "SKIPPED", error: "Outside selected member scope." }); continue; }
    if (stopped) { runs.push({ ...base, status: "SKIPPED", error: "Not executed after fail-fast." }); continue; }
    try {
      if (member.error || !member.contract) throw new Error(member.error ?? "Contract was not loaded.");
      const evaluatedContract = resolveEvaluation(member.contract, startedAt);
      const targets = resolveSqlServerTargets(evaluatedContract);
      if (!targets.length && !(validateFile && member.contract.targets?.length)) throw new Error("No SQL Server targets configured; dbtest requires a database target for every member.");
      for (const target of targets) {
        const identity = { ...base, table: `${target.schema}.${target.table}`, target: target.name ?? `${target.schema}.${target.table}` };
        if (controls.signal?.aborted) { runs.push({ ...identity, status: "CANCELED", error: "Canceled before target execution." }); continue; }
        if (stopped) { runs.push({ ...identity, status: "SKIPPED", error: "Not executed after fail-fast." }); continue; }
        try {
          const started = Date.now();
          const result = await validate(evaluatedContract, target, member.source);
          result.evaluatedAt = startedAt;
          runs.push(controls.signal?.aborted ? { ...identity, status: "CANCELED", error: "Canceled during execution; result discarded." }
            : { ...identity, status: result.valid ? "PASS" : "FAIL", result, durationMs: Date.now() - started });
          controls.onProgress?.(runs[runs.length - 1]);
          if (failFast && !result.valid) stopped = true;
        } catch (error) {
          runs.push({ ...identity, status: controls.signal?.aborted ? "CANCELED" : "ERROR", error: errorDetails(error) });
          controls.onProgress?.(runs[runs.length - 1]);
          if (failFast) stopped = true;
        }
      }
      for (const target of validateFile ? member.contract.targets ?? [] : []) {
        const identity = { ...base, target: target.path ?? target.url };
        if (controls.signal?.aborted) { runs.push({ ...identity, status: "CANCELED", error: "Canceled before target execution." }); continue; }
        if (stopped) { runs.push({ ...identity, status: "SKIPPED", error: "Not executed after fail-fast." }); continue; }
        try {
          const started = Date.now();
          const result = await validateFile!(evaluatedContract, member.source, target);
          result.evaluatedAt = startedAt;
          runs.push(controls.signal?.aborted ? { ...identity, status: "CANCELED", error: "Canceled during execution; result discarded." } : { ...identity, status: result.valid ? "PASS" : "FAIL", result, durationMs: Date.now() - started });
          controls.onProgress?.(runs[runs.length - 1]);
          if (failFast && !result.valid) stopped = true;
        } catch (error) {
          runs.push({ ...identity, status: controls.signal?.aborted ? "CANCELED" : "ERROR", error: errorDetails(error) });
          controls.onProgress?.(runs[runs.length - 1]);
          if (failFast) stopped = true;
        }
      }
    } catch (error) {
      runs.push({ ...base, status: controls.signal?.aborted ? "CANCELED" : "ERROR", error: errorDetails(error) });
      if (failFast) stopped = true;
    }
  }
  for (const check of suite.crossChecks ?? []) {
    const base = { suite: suite.id, member: `cross:${check.id}`, spec: suite.source, target: `${check.from} → ${check.to}` };
    if (controls.signal?.aborted) { runs.push({ ...base, status: "CANCELED", error: "Canceled before cross-check execution." }); continue; }
    if (stopped || (controls.members && !controls.members.some(id => id === check.from || id === check.to))) { runs.push({ ...base, status: "SKIPPED", error: "Cross-check outside selected scope or stopped by fail-fast." }); continue; }
    try {
      const plan = planCrossCheck(check, suite.members);
      if (!controls.crossExecutor) throw new Error("Cross-table execution is unavailable in this host.");
      const result = await controls.crossExecutor(plan, controls.signal);
      runs.push(controls.signal?.aborted ? { ...base, status: "CANCELED", error: "Cross-check canceled; result discarded." } : { ...base, status: result.valid ? "PASS" : "FAIL", result });
      if (failFast && !result.valid) stopped = true;
    } catch (error) { runs.push({ ...base, status: controls.signal?.aborted ? "CANCELED" : "ERROR", error: errorDetails(error) }); if (failFast) stopped = true; }
  }
  runs.forEach(run => { if (run.result?.preview?.scope === "sample") run.status = "SAMPLED"; });
  const status: SuiteStatus = runs.some((r) => r.status === "ERROR") || !runs.length ? "ERROR"
    : runs.some((r) => r.status === "CANCELED") ? "CANCELED" : runs.some((r) => r.status === "FAIL") ? "FAIL" : runs.some((r) => r.status === "SKIPPED") ? "SKIPPED" : runs.some(r => r.status === "SAMPLED") ? "SAMPLED" : "PASS";
  runs.forEach((run, index) => Object.assign(run, { workId: `${runId}:${index}`, runId, evaluatedAt: startedAt, scope: run.result?.preview ? JSON.stringify({ preview: run.result.preview, rules: run.result.ruleOutcomes?.map(r => r.id) }) : controls.members ? JSON.stringify(controls.members) : "all" }));
  return { suite: suite.id, runId, startedAt, completedAt: new Date().toISOString(), scope: controls.members ?? "all", valid: status === "PASS", status, exitCode: status === "PASS" ? 0 : status === "FAIL" ? 1 : 2,
    summary: { ...Object.fromEntries((["PASS", "FAIL", "ERROR", "SKIPPED", "CANCELED"] as const).map((s) => [s, runs.filter((r) => r.status === s).length])), ...(runs.some(r => r.status === "SAMPLED") ? { SAMPLED: runs.filter(r => r.status === "SAMPLED").length } : {}) },
    members: suite.members.map((m) => ({ id: m.id, runs: runs.filter((r) => r.member === m.id) })), runs };
}

export function generateSuiteSql(suite: LoadedSuite) {
  const batches = suite.members.flatMap((member) => {
    if (member.error || !member.contract) throw new Error(`${suite.id}/${member.id}: ${member.error ?? "Missing contract"}`);
    const targets = resolveSqlServerTargets(member.contract, false);
    if (!targets.length) throw new Error(`${suite.id}/${member.id}: no SQL Server target.`);
    return targets.map((target) => ({ member: member.id, table: `${target.schema}.${target.table}`, connection: target.connection, integratedConnection: target.integratedConnection,
      ...generateSqlServerValidation(member.contract!, { target, includeDetailQueries: false, suite: { id: suite.id, member: member.id } }) }));
  });
  for (const check of suite.crossChecks ?? []) {
    const plan = planCrossCheck(check, suite.members);
    const parameters = [plan.from, plan.to].flatMap(target => target.scope ? [`DECLARE @${target.scope.parameter} nvarchar(max) = NULL; -- Set this participant's runtime scope value.\nIF @${target.scope.parameter} IS NULL THROW 50001, 'Set @${target.scope.parameter} before running this cross-check.', 1;`] : []).join("\n");
    batches.push({ member: `cross:${check.id}`, table: `${check.from} → ${check.to}`, connection: plan.from.connection, integratedConnection: plan.from.integratedConnection,
      sql: parameters ? `${parameters}\n${plan.sql}` : plan.sql, ruleCount: 1, warnings: [], rules: [{ id: check.id, name: check.id, severity: check.severity ?? "error", code: "CROSS_CHECK_FAILED" }] });
  }
  const literal = (s: string): string => `N'${s.replaceAll("'", "''")}'`;
  return { batches, ruleCount: batches.reduce((sum, b) => sum + b.ruleCount, 0), warnings: batches.flatMap((b) => b.warnings.map((w) => `${suite.id}/${b.member}/${b.table}: ${w}`)),
    sql: batches.map((b) => {
      const identity = `${literal(suite.id)} AS SuiteId, ${literal(b.member)} AS MemberId, ${literal(b.table)} AS TableName`;
      const connection = b.integratedConnection ? `${b.integratedConnection.server}/${b.integratedConnection.database} (Windows)` : b.connection || "unconfigured";
      return `SELECT ${identity}, ${literal(connection)} AS ConnectionName;\n${b.sql}\nGO\n`;
    }).join("\n") };
}

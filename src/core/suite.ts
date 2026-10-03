import { errorDetails } from "./error-details";
import type { ValidationProgress } from "./run-progress";
import { resolveEvaluation } from "./evaluation";
import { planCrossCheck, type CrossCheck, type CrossExecutor } from "./cross-checks";
import { isScalar, parseDocument, stringify, visit } from "yaml";
import { parseContract } from "./contract";
import { resolveGroupContracts } from "./group-contracts";
import type { CsvContract, CsvTarget, SqlServerIntegratedConnection, ValidationResult } from "./model";
import { resolveSqlServerTargetPolicies, type ResolvedSqlServerTarget } from "./sql-server-targets";
import { generateSqlServerValidation } from "./sql-server-generator";
import Ajv from "ajv/dist/2020";
import contractSchema from "../../schemas/csvtest.schema.json";

const validateContractShape = new Ajv({ strict: false, allErrors: true, validateFormats: false }).compile(contractSchema);

export interface SuiteConnection {
  connection?: string;
  integratedConnection?: SqlServerIntegratedConnection;
}
export interface SuiteTargetPolicy {
  sqlServer?: { environments?: Record<string, boolean> };
}
export interface TargetOverride {
  target: string;
  enabled: boolean;
}
export interface ContractSuite {
  crossChecks?: CrossCheck[];
  suiteVersion: 1;
  id: string;
  name?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  defaults?: SuiteConnection;
  targetPolicy?: SuiteTargetPolicy;
  members: { id: string; ref?: string; contract?: CsvContract; targetOverrides?: TargetOverride[]; name?: string; description?: string; metadata?: Record<string, unknown> }[];
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
  targetOverrides?: TargetOverride[];
  error?: string;
}
export interface LoadedSuite {
  crossChecks?: CrossCheck[];
  id: string;
  source: string;
  isSuite: boolean;
  members: LoadedMember[];
  targetPolicy?: SuiteTargetPolicy;
  warnings?: string[];
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
const crossPredicateOperators = new Set(["equals", "notEquals", "in", "notIn", "isNull", "notNull", "isBlank", "notBlank", "equalsColumn", "notEqualsColumn",
  "greaterThan", "greaterThanOrEqual", "lessThan", "lessThanOrEqual", "dateOnOrAfter", "dateOnOrBefore", "dateAfter", "dateBefore"]);
function crossPredicate(value: unknown, context: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${context}: predicate must be an object.`);
  const predicate = value as Record<string, unknown>;
  if ("all" in predicate || "any" in predicate) {
    keys(predicate, ["all", "any"], context);
    if (("all" in predicate) === ("any" in predicate)) throw new Error(`${context}: use exactly one of all or any.`);
    const children = (predicate.all ?? predicate.any) as unknown;
    if (!Array.isArray(children) || !children.length) throw new Error(`${context}: predicate group cannot be empty.`);
    children.forEach((child, index) => crossPredicate(child, `${context}[${index}]`));
    return;
  }
  keys(predicate, ["side", "column", "operator", "value", "values", "valueType", "other"], context);
  if (!(["from", "to"] as unknown[]).includes(predicate.side) || typeof predicate.column !== "string" || !predicate.column || typeof predicate.operator !== "string" || !crossPredicateOperators.has(predicate.operator)) throw new Error(`${context}: invalid predicate side, column, or operator.`);
  if (predicate.value !== undefined && typeof predicate.value !== "string" && typeof predicate.value !== "number") throw new Error(`${context}: value must be a string or number.`);
  if (predicate.values !== undefined && (!Array.isArray(predicate.values) || !predicate.values.length || predicate.values.some(item => typeof item !== "string"))) throw new Error(`${context}: values must be a non-empty string array.`);
  if (predicate.valueType !== undefined && !["string", "number"].includes(String(predicate.valueType))) throw new Error(`${context}: valueType must be string or number.`);
  if (predicate.valueType === "number" && !["equals", "notEquals", "greaterThan", "greaterThanOrEqual", "lessThan", "lessThanOrEqual"].includes(String(predicate.operator))) throw new Error(`${context}: numeric valueType requires a numeric comparison operator.`);
  if (predicate.other !== undefined) {
    if (!predicate.other || typeof predicate.other !== "object" || Array.isArray(predicate.other)) throw new Error(`${context}: other must identify a side and column.`);
    const other = predicate.other as Record<string, unknown>;
    keys(other, ["side", "column"], `${context}.other`);
    if (!(["from", "to"] as unknown[]).includes(other.side) || typeof other.column !== "string" || !other.column) throw new Error(`${context}: other must identify a side and column.`);
  }
  const operator = predicate.operator;
  const noOperand = ["isNull", "notNull", "isBlank", "notBlank"].includes(operator);
  const valuesOperand = ["in", "notIn"].includes(operator);
  const columnOperand = ["equalsColumn", "notEqualsColumn"].includes(operator);
  if (noOperand && (predicate.value !== undefined || predicate.values !== undefined || predicate.other !== undefined) ||
      valuesOperand && (predicate.values === undefined || predicate.value !== undefined || predicate.other !== undefined) ||
      columnOperand && (predicate.other === undefined || predicate.value !== undefined || predicate.values !== undefined) ||
      !noOperand && !valuesOperand && !columnOperand && (Number(predicate.value !== undefined) + Number(predicate.other !== undefined) !== 1 || predicate.values !== undefined)) {
    throw new Error(`${context}: operator operands are invalid or ambiguous.`);
  }
}
export function parseSuite(text: string): ContractSuite {
  const suite = yamlDocument(text).toJS({ maxAliasCount: 100 }) as ContractSuite;
  if (!suite || suite.suiteVersion !== 1 || typeof suite.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(suite.id)) throw new Error("Suite requires suiteVersion: 1 and a non-empty id using letters, numbers, dots, underscores or hyphens.");
  keys(suite, ["suiteVersion", "id", "name", "description", "metadata", "defaults", "targetPolicy", "members", "crossChecks"], `Suite ${suite.id}`);
  if (suite.defaults) connectionSettings(suite.defaults, `Suite ${suite.id} defaults`);
  if (suite.targetPolicy !== undefined) {
    keys(suite.targetPolicy, ["sqlServer"], `Suite ${suite.id} targetPolicy`);
    if (suite.targetPolicy.sqlServer !== undefined) {
      keys(suite.targetPolicy.sqlServer, ["environments"], `Suite ${suite.id} targetPolicy.sqlServer`);
      const environments = suite.targetPolicy.sqlServer.environments;
      if (!environments || typeof environments !== "object" || Array.isArray(environments)) throw new Error(`Suite ${suite.id} targetPolicy.sqlServer.environments must be an object.`);
      for (const [environment, enabled] of Object.entries(environments)) if (!environment.trim() || typeof enabled !== "boolean") throw new Error(`Suite ${suite.id}: environment policies must map names to booleans.`);
    }
  }
  if (!Array.isArray(suite.members) || !suite.members.length) throw new Error(`Suite ${suite.id} requires at least one member.`);
  const ids = new Set<string>();
  for (const member of suite.members) {
    if (!member || typeof member.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(member.id)) throw new Error(`Suite ${suite.id}: each member needs a stable id.`);
    if (ids.has(member.id)) throw new Error(`Suite ${suite.id}: duplicate member id '${member.id}'.`);
    ids.add(member.id);
    keys(member, ["id", "ref", "contract", "targetOverrides", "name", "description", "metadata"], `Member ${member.id}`);
    if ((member.ref !== undefined) === (member.contract !== undefined)) throw new Error(`Member ${member.id}: declare exactly one of ref or contract.`);
    if (member.ref !== undefined && (typeof member.ref !== "string" || !member.ref.trim())) throw new Error(`Member ${member.id}: ref must be a non-empty file path.`);
    if (member.targetOverrides !== undefined) {
      if (!Array.isArray(member.targetOverrides)) throw new Error(`Member ${member.id}: targetOverrides must be an array.`);
      const overrideIds = new Set<string>();
      for (const override of member.targetOverrides) {
        if (!override || typeof override.target !== "string" || !override.target.trim() || typeof override.enabled !== "boolean") throw new Error(`Member ${member.id}: targetOverrides require target and enabled.`);
        if (overrideIds.has(override.target)) throw new Error(`Member ${member.id}: duplicate target override '${override.target}'.`);
        overrideIds.add(override.target);
        if (Object.keys(override).some(key => !["target", "enabled"].includes(key))) throw new Error(`Member ${member.id}: unsupported target override field.`);
      }
    }
  }
  const checks = new Set<string>();
  if (suite.crossChecks !== undefined && !Array.isArray(suite.crossChecks)) throw new Error("crossChecks must be an array.");
  for (const check of suite.crossChecks ?? []) {
    if (!check || !/^[a-z0-9][a-z0-9._-]*$/.test(check.id) || checks.has(check.id) || !ids.has(check.from) || !ids.has(check.to) || !["foreignKey", "equalPopulation", "equalTotal", "rowReconciliation", "relationship"].includes(check.kind)) throw new Error("Invalid cross-check identity, kind or member dependency.");
    keys(check, ["id", "kind", "from", "to", "keys", "valueColumns", "valueMappings", "tolerance", "nulls", "severity", "lookup", "when", "expect", "missing"], `Cross-check ${check.id}`);
    if (check.keys !== undefined && (!Array.isArray(check.keys) || !check.keys.length || check.keys.some(k => !k || typeof k.from !== "string" || typeof k.to !== "string" || Object.keys(k).some(p => !["from", "to"].includes(p))))) throw new Error("Invalid cross-check key mappings.");
    if (check.valueColumns !== undefined && (!check.valueColumns || typeof check.valueColumns.from !== "string" || typeof check.valueColumns.to !== "string" || Object.keys(check.valueColumns).some(p => !["from", "to"].includes(p)))) throw new Error("Invalid total value columns.");
    if (check.valueMappings !== undefined && (!Array.isArray(check.valueMappings) || !check.valueMappings.length || check.valueMappings.some(mapping => !mapping || typeof mapping.from !== "string" || typeof mapping.to !== "string" || mapping.blankTo !== undefined && typeof mapping.blankTo !== "string" || mapping.otherwise !== undefined && mapping.otherwise !== "preserve" || mapping.blankTo === undefined && mapping.otherwise === undefined || Object.keys(mapping).some(p => !["from", "to", "blankTo", "otherwise"].includes(p))))) throw new Error("Invalid reconciliation value mappings.");
    if (check.tolerance !== undefined && (typeof check.tolerance !== "string" || !/^(?:0|[1-9]\d{0,17})(?:\.\d{1,10})?$/.test(check.tolerance))) throw new Error("Invalid total tolerance.");
    if (check.kind === "foreignKey" && !check.keys?.length || check.kind === "equalTotal" && !check.valueColumns || check.kind === "rowReconciliation" && (!check.keys?.length || !check.valueMappings?.length) || check.kind === "relationship" && (!check.keys?.length || !check.lookup?.orderBy?.length || !check.expect)) throw new Error("Cross-check requires keys, total value columns, reconciliation mappings, or a relationship lookup and expectation.");
    if (check.nulls !== undefined && !["ignore", "fail"].includes(check.nulls)) throw new Error("Invalid cross-check null policy.");
    if (check.severity !== undefined && !["warning", "error"].includes(check.severity)) throw new Error("Invalid cross-check severity.");
    if (check.missing !== undefined && !["fail", "ignore"].includes(check.missing)) throw new Error("Invalid relationship missing-row policy.");
    if (check.kind !== "relationship" && (check.lookup !== undefined || check.when !== undefined || check.expect !== undefined || check.missing !== undefined)) throw new Error("lookup, when, expect, and missing are only valid for relationship cross-checks.");
    if (check.kind === "relationship" && (check.valueColumns !== undefined || check.valueMappings !== undefined || check.tolerance !== undefined)) throw new Error("Relationship cross-checks cannot declare total or reconciliation fields.");
    if (check.lookup !== undefined) {
      if (!check.lookup || typeof check.lookup !== "object") throw new Error("Invalid relationship lookup.");
      keys(check.lookup, ["orderBy"], `Cross-check ${check.id} lookup`);
      if (!Array.isArray(check.lookup.orderBy) || !check.lookup.orderBy.length || check.lookup.orderBy.some(order => !order || typeof order.column !== "string" || !order.column || !["date", "number", "string"].includes(order.type) || order.direction !== undefined && !["asc", "desc"].includes(order.direction) || Object.keys(order).some(key => !["column", "type", "direction"].includes(key)))) throw new Error("Invalid relationship lookup ordering.");
    }
    if (check.when !== undefined) crossPredicate(check.when, `Cross-check ${check.id} when`);
    if (check.expect !== undefined) crossPredicate(check.expect, `Cross-check ${check.id} expect`);
    checks.add(check.id);
  }
  return suite;
}

function validateTargetIds(contract: CsvContract, context: string): void {
  const ids = new Set<string>();
  for (const target of contract.sqlServer?.targets ?? []) if (target.id !== undefined) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(target.id)) throw new Error(`${context}: SQL target id '${target.id}' is invalid.`);
    if (ids.has(target.id)) throw new Error(`${context}: duplicate SQL target id '${target.id}'.`);
    ids.add(target.id);
  }
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
  if (!isSuiteText(text)) return { id: source, source, isSuite: false, members: [{ id: source, source,
    contract: await resolveGroupContracts(parseContract(text), source, io) }] };
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
      validateTargetIds(contract, `Member ${member.id}`);
      for (const override of member.targetOverrides ?? []) if (!(contract.sqlServer?.targets ?? []).some(target => target.id === override.target)) throw new Error(`Member ${member.id}: target override references unknown target id '${override.target}'.`);
      const own = (value: SuiteConnection | undefined) => value?.connection !== undefined || value?.integratedConnection !== undefined;
      const connectionOrigins = contract.sqlServer?.targets?.map(target => own(target) ? "table override" : own(contract.sqlServer) ? "contract" : own(suite.defaults) ? "suite default" : "unconfigured")
        ?? (contract.sqlServer ? [own(contract.sqlServer) ? "contract" : own(suite.defaults) ? "suite default" : "unconfigured"] : []);
      members.push({ id: member.id, source: location, targetOverrides: member.targetOverrides,
        contract: await resolveGroupContracts(effectiveContract(contract, suite.defaults), location, io), connectionOrigins });
    } catch (error) {
      members.push({ id: member.id, source: location, error: errorDetails(error) });
    }
  }
  const policyEnvironments = Object.keys(suite.targetPolicy?.sqlServer?.environments ?? {});
  const targetEnvironments = new Set(members.flatMap(member => (member.contract?.sqlServer?.targets ?? []).map(target => target.environment).filter((environment): environment is string => environment !== undefined)));
  const warnings = policyEnvironments.filter(environment => !targetEnvironments.has(environment)).map(environment => `Suite ${suite.id} target policy environment '${environment}' matched no SQL Server targets.`);
  return { id: suite.id, source, isSuite: true, members, ...(suite.crossChecks ? { crossChecks: suite.crossChecks } : {}), ...(suite.targetPolicy ? { targetPolicy: suite.targetPolicy } : {}), ...(warnings.length ? { warnings } : {}) };
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
export async function runSuite(suite: LoadedSuite, validate: (contract: CsvContract, target: ResolvedSqlServerTarget, source: string, index?: number,
  onProgress?: (progress: ValidationProgress) => void) => Promise<ValidationResult>, failFast = false,
  validateFile?: (contract: CsvContract, source: string, target: CsvTarget, index?: number,
    onProgress?: (progress: ValidationProgress) => void) => Promise<ValidationResult>,
  controls: { signal?: AbortSignal; members?: string[]; onProgress?: (run: SuiteRun, index?: number) => void;
    onTargetStart?: (target: Pick<SuiteRun, "suite" | "member" | "spec" | "table" | "target">, index: number) => void;
    onTargetProgress?: (target: Pick<SuiteRun, "suite" | "member" | "spec" | "table" | "target">, progress: ValidationProgress, index: number) => void;
    parallelTargets?: number; parallelMembers?: number; crossExecutor?: CrossExecutor } = {}) {
  const runs: SuiteRun[] = [];
  const runId = globalThis.crypto.randomUUID();
  const startedAt = new Date().toISOString();
  let stopped = false;
  const executeMember = async (member: LoadedSuite["members"][number]): Promise<SuiteRun[]> => {
    const memberRuns: SuiteRun[] = [];
    const base = { suite: suite.id, member: member.id, spec: member.source };
    if (controls.signal?.aborted) { memberRuns.push({ ...base, status: "CANCELED", error: "Canceled before member execution." }); return memberRuns; }
    if (controls.members && !controls.members.includes(member.id)) { memberRuns.push({ ...base, status: "SKIPPED", error: "Outside selected member scope." }); return memberRuns; }
    if (stopped) { memberRuns.push({ ...base, status: "SKIPPED", error: "Not executed after fail-fast." }); return memberRuns; }
    try {
      if (member.error || !member.contract) throw new Error(member.error ?? "Contract was not loaded.");
      const evaluatedContract = resolveEvaluation(member.contract, startedAt);
      const targetPolicies = resolveSqlServerTargetPolicies(evaluatedContract, true, suite.targetPolicy?.sqlServer, member.targetOverrides);
      const targets = targetPolicies.filter(entry => entry.enabled).map(entry => entry.target);
      const fileTargets = (validateFile ? member.contract.targets ?? [] : []).filter(target => target.enabled !== false);
      if (!targets.length && !fileTargets.length) throw new Error("No enabled targets configured for this member.");
      if (!failFast && controls.parallelTargets !== undefined && controls.parallelTargets >= 1) {
        const jobs = [
          ...targets.map((target) => ({ identity: { ...base, table: `${target.schema}.${target.table}`, target: target.name ?? `${target.schema}.${target.table}` },
            execute: (index: number) => validate(evaluatedContract, target, member.source, index,
              progress => controls.onTargetProgress?.({ ...base, table: `${target.schema}.${target.table}`, target: target.name ?? `${target.schema}.${target.table}` }, progress, index)) })),
          ...fileTargets.map((target) => ({ identity: { ...base, target: target.path ?? target.url },
            execute: (index: number) => validateFile!(evaluatedContract, member.source, target, index,
              progress => controls.onTargetProgress?.({ ...base, target: target.path ?? target.url }, progress, index)) }))
        ];
        const outcomes: SuiteRun[] = new Array(jobs.length);
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(jobs.length, Math.floor(controls.parallelTargets!)) }, async () => {
          while (next < jobs.length) {
            const index = next++;
            const job = jobs[index];
            if (controls.signal?.aborted) {
              outcomes[index] = { ...job.identity, status: "CANCELED", error: "Canceled before target execution." };
              controls.onProgress?.(outcomes[index], index);
              continue;
            }
            controls.onTargetStart?.(job.identity, index);
            const started = Date.now();
            try {
              const result = await job.execute(index);
              result.evaluatedAt = startedAt;
              outcomes[index] = controls.signal?.aborted
                ? { ...job.identity, status: "CANCELED", error: "Canceled during execution; result discarded." }
                : { ...job.identity, status: result.valid ? "PASS" : "FAIL", result, durationMs: Date.now() - started };
            } catch (error) {
              outcomes[index] = { ...job.identity, status: controls.signal?.aborted ? "CANCELED" : "ERROR", error: errorDetails(error) };
            }
            controls.onProgress?.(outcomes[index], index);
          }
        }));
        memberRuns.push(...outcomes);
        return memberRuns;
      }
      for (const [targetIndex, target] of targets.entries()) {
        const identity = { ...base, table: `${target.schema}.${target.table}`, target: target.name ?? `${target.schema}.${target.table}` };
        if (controls.signal?.aborted) { memberRuns.push({ ...identity, status: "CANCELED", error: "Canceled before target execution." }); continue; }
        if (stopped) { memberRuns.push({ ...identity, status: "SKIPPED", error: "Not executed after fail-fast." }); continue; }
        try {
          controls.onTargetStart?.(identity, targetIndex);
          const started = Date.now();
          const result = await validate(evaluatedContract, target, member.source, targetIndex,
            progress => controls.onTargetProgress?.(identity, progress, targetIndex));
          result.evaluatedAt = startedAt;
          memberRuns.push(controls.signal?.aborted ? { ...identity, status: "CANCELED", error: "Canceled during execution; result discarded." }
            : { ...identity, status: result.valid ? "PASS" : "FAIL", result, durationMs: Date.now() - started });
          controls.onProgress?.(memberRuns[memberRuns.length - 1]);
          if (failFast && !result.valid) stopped = true;
        } catch (error) {
          memberRuns.push({ ...identity, status: controls.signal?.aborted ? "CANCELED" : "ERROR", error: errorDetails(error) });
          controls.onProgress?.(memberRuns[memberRuns.length - 1]);
          if (failFast) stopped = true;
        }
      }
      for (const [fileIndex, target] of fileTargets.entries()) {
        const identity = { ...base, target: target.path ?? target.url };
        const targetIndex = targets.length + fileIndex;
        if (controls.signal?.aborted) { memberRuns.push({ ...identity, status: "CANCELED", error: "Canceled before target execution." }); continue; }
        if (stopped) { memberRuns.push({ ...identity, status: "SKIPPED", error: "Not executed after fail-fast." }); continue; }
        try {
          controls.onTargetStart?.(identity, targetIndex);
          const started = Date.now();
          const result = await validateFile!(evaluatedContract, member.source, target, targetIndex,
            progress => controls.onTargetProgress?.(identity, progress, targetIndex));
          result.evaluatedAt = startedAt;
          memberRuns.push(controls.signal?.aborted ? { ...identity, status: "CANCELED", error: "Canceled during execution; result discarded." } : { ...identity, status: result.valid ? "PASS" : "FAIL", result, durationMs: Date.now() - started });
          controls.onProgress?.(memberRuns[memberRuns.length - 1]);
          if (failFast && !result.valid) stopped = true;
        } catch (error) {
          memberRuns.push({ ...identity, status: controls.signal?.aborted ? "CANCELED" : "ERROR", error: errorDetails(error) });
          controls.onProgress?.(memberRuns[memberRuns.length - 1]);
          if (failFast) stopped = true;
        }
      }
    } catch (error) {
      memberRuns.push({ ...base, status: controls.signal?.aborted ? "CANCELED" : "ERROR", error: errorDetails(error) });
      if (failFast) stopped = true;
    }
    return memberRuns;
  };
  const memberConcurrency = failFast ? 1 : Math.max(1, Math.floor(controls.parallelMembers ?? suite.members.length));
  if (memberConcurrency === 1 || suite.members.length < 2) {
    for (const member of suite.members) runs.push(...await executeMember(member));
  } else {
    const outcomes: SuiteRun[][] = new Array(suite.members.length);
    let nextMember = 0;
    await Promise.all(Array.from({ length: Math.min(memberConcurrency, suite.members.length) }, async () => {
      while (nextMember < suite.members.length) {
        const index = nextMember++;
        outcomes[index] = await executeMember(suite.members[index]);
      }
    }));
    outcomes.forEach(memberRuns => runs.push(...memberRuns));
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
  for (const member of suite.members) if (member.contract?.groupTests?.length || member.contract?.orderedRules?.length) {
    throw new Error(`Standalone SQL generation cannot include grouped or ordered rules in ${member.id}; run dbtest.`);
  }
  const batches = suite.members.flatMap((member) => {
    if (member.error || !member.contract) throw new Error(`${suite.id}/${member.id}: ${member.error ?? "Missing contract"}`);
    const targets = resolveSqlServerTargetPolicies(member.contract, false, suite.targetPolicy?.sqlServer, member.targetOverrides)
      .filter(entry => entry.enabled).map(entry => entry.target);
    if (!targets.length) throw new Error(`${suite.id}/${member.id}: no SQL Server target.`);
    return targets.map((target) => ({ member: member.id, table: `${target.schema}.${target.table}`, connection: target.connection, integratedConnection: target.integratedConnection,
      ...generateSqlServerValidation(member.contract!, { target, includeDetailQueries: false, suite: { id: suite.id, member: member.id } }) }));
  });
  for (const check of suite.crossChecks ?? []) {
    const plan = planCrossCheck(check, suite.members);
    if (plan.mode !== "sql") throw new Error(`Standalone SQL generation cannot include CSV cross-check ${check.id}; run the suite instead.`);
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

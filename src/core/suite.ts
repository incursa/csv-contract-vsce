import { errorDetails } from "./error-details";
import type { ValidationProgress } from "./run-progress";
import { resolveEvaluation } from "./evaluation";
import { planCrossCheck, type CrossCheck, type CrossExecutor } from "./cross-checks";
import { isScalar, parseDocument, stringify, visit } from "yaml";
import { parseContract } from "./contract";
import { resolveGroupContracts } from "./group-contracts";
import type { CsvContract, CsvTarget, SqlServerIntegratedConnection, ValidationResult } from "./model";
import type { ResolvedSqlServerTarget } from "./sql-server-targets";
import { generateSqlServerValidation } from "./sql-server-generator";
import { applySuiteTargetPolicy, diagnoseSuiteTargetPolicy, resolveSuiteSqlServerTargets, type SuiteTargetEnabledSource, type SuiteTargetOverride, type SuiteTargetPolicy, type SuiteTargetPolicyDiagnostic } from "./suite-target-policy";
import Ajv from "ajv/dist/2020";
import contractSchema from "../../schemas/csvtest.schema.json";
import { resolveContractRulePacks, type RulePackProvenance } from "./rule-packs";
import { contractForTarget, validateRuleTargetSelectors } from "./target-scoping";

const validateContractShape = new Ajv({ strict: false, allErrors: true, validateFormats: false }).compile(contractSchema);

export interface SuiteConnection {
  connection?: string;
  integratedConnection?: SqlServerIntegratedConnection;
}
export interface ContractSuite {
  crossChecks?: CrossCheck[];
  targetMatrix?: SuiteTargetMatrixEntry[];
  targetPolicy?: SuiteTargetPolicy;
  suiteVersion: 1;
  id: string;
  name?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  defaults?: SuiteConnection;
  members: { id: string; ref?: string; contract?: CsvContract; name?: string; description?: string; metadata?: Record<string, unknown>; targetOverrideMode?: import("./suite-target-policy").SuiteTargetOverrideMode; targetOverrides?: SuiteTargetOverride[] }[];
}
export interface SuiteTargetMatrixEntry { id: string; name?: string; target: string }
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
  targetOverrides?: SuiteTargetOverride[];
  targetOverrideMode?: import("./suite-target-policy").SuiteTargetOverrideMode;
  rulePackProvenance?: RulePackProvenance[];
  error?: string;
}
export interface LoadedSuite {
  crossChecks?: CrossCheck[];
  targetMatrix?: SuiteTargetMatrixEntry[];
  targetPolicy?: SuiteTargetPolicy;
  targetPolicyDiagnostics?: SuiteTargetPolicyDiagnostic[];
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
function targetReplacement(value: unknown, context: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${context}: replacement must be a SQL Server target object.`);
  const target = value as unknown as Record<string, unknown> & SuiteConnection;
  keys(target, ["id", "environment", "enabled", "baseline", "name", "connection", "integratedConnection", "schema", "table", "objectType", "columnMap", "scope"], context);
  if (target.connection !== undefined && (typeof target.connection !== "string" || !/^[A-Za-z0-9._-]+$/.test(target.connection))) throw new Error(`${context}: connection must be a profile name, never a connection string.`);
  if (target.connection !== undefined && target.integratedConnection !== undefined) throw new Error(`${context}: choose connection or integratedConnection, not both.`);
  if (target.integratedConnection) {
    keys(target.integratedConnection, ["server", "database", "odbcDriver", "encrypt", "trustServerCertificate"], `${context} integratedConnection`);
    if (!target.integratedConnection.server?.trim() || !target.integratedConnection.database?.trim()) throw new Error(`${context}: integratedConnection requires server and database.`);
  }
  if (typeof target.schema !== "string" || !target.schema.trim() || typeof target.table !== "string" || !target.table.trim()) throw new Error(`${context}: replacement requires schema and table.`);
  if (target.id !== undefined && (typeof target.id !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(target.id))) throw new Error(`${context}: replacement id is invalid.`);
  if (target.environment !== undefined && (typeof target.environment !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(target.environment))) throw new Error(`${context}: replacement environment is invalid.`);
  if (target.enabled !== undefined && typeof target.enabled !== "boolean") throw new Error(`${context}: replacement enabled must be boolean.`);
  if (target.objectType !== undefined && !["table", "view"].includes(String(target.objectType))) throw new Error(`${context}: replacement objectType must be table or view.`);
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
function crossKeys(value: unknown, context: string): void {
  if (!Array.isArray(value) || !value.length || value.some(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return true;
    const key = item as Record<string, unknown>;
    if (typeof key.from !== "string" || typeof key.to !== "string" || Object.keys(key).some(field => !["from", "to", "normalizers"].includes(field))) return true;
    return key.normalizers !== undefined && (!Array.isArray(key.normalizers) || !key.normalizers.length || key.normalizers.some(normalizer => !["trim", "lowercase", "trimLeadingZeros"].includes(String(normalizer))));
  })) throw new Error(`${context}: invalid key mappings or normalizers.`);
}
function crossSelections(value: unknown, ids: Set<string>, context: string): void {
  if (!Array.isArray(value) || !value.length) throw new Error(`${context}: selections must be a non-empty array.`);
  for (const [index, item] of value.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${context}[${index}]: selection must be an object.`);
    const selection = item as Record<string, unknown>;
    keys(selection, ["where", "partitionBy", "orderBy", "having", "requires"], `${context}[${index}]`);
    if (selection.where !== undefined) crossPredicate(selection.where, `${context}[${index}].where`);
    if (selection.having !== undefined) crossPredicate(selection.having, `${context}[${index}].having`);
    if ((selection.partitionBy === undefined) !== (selection.orderBy === undefined)) throw new Error(`${context}[${index}]: partitionBy and orderBy must be supplied together.`);
    if (selection.partitionBy !== undefined && (!Array.isArray(selection.partitionBy) || !selection.partitionBy.length || selection.partitionBy.some(column => typeof column !== "string" || !column))) throw new Error(`${context}[${index}]: invalid partitionBy.`);
    if (selection.orderBy !== undefined && (!Array.isArray(selection.orderBy) || !selection.orderBy.length || selection.orderBy.some(order => !order || typeof order !== "object" || typeof order.column !== "string" || !["date", "number", "string"].includes(order.type) || order.direction !== undefined && !["asc", "desc"].includes(order.direction) || Object.keys(order).some(key => !["column", "type", "direction"].includes(key))))) throw new Error(`${context}[${index}]: invalid orderBy.`);
    if (selection.requires !== undefined) {
      if (!Array.isArray(selection.requires) || !selection.requires.length) throw new Error(`${context}[${index}]: requires must be a non-empty array.`);
      for (const [requiredIndex, raw] of selection.requires.entries()) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${context}[${index}].requires[${requiredIndex}]: invalid required match.`);
        const required = raw as Record<string, unknown>;
        keys(required, ["member", "keys", "where"], `${context}[${index}].requires[${requiredIndex}]`);
        if (typeof required.member !== "string" || !ids.has(required.member)) throw new Error(`${context}[${index}].requires[${requiredIndex}]: unknown member.`);
        crossKeys(required.keys, `${context}[${index}].requires[${requiredIndex}].keys`);
        if (required.where !== undefined) crossPredicate(required.where, `${context}[${index}].requires[${requiredIndex}].where`);
      }
    }
  }
}
export function parseSuite(text: string): ContractSuite {
  const suite = yamlDocument(text).toJS({ maxAliasCount: 100 }) as ContractSuite;
  if (!suite || suite.suiteVersion !== 1 || typeof suite.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(suite.id)) throw new Error("Suite requires suiteVersion: 1 and a non-empty id using letters, numbers, dots, underscores or hyphens.");
  keys(suite, ["suiteVersion", "id", "name", "description", "metadata", "defaults", "members", "crossChecks", "targetMatrix", "targetPolicy"], `Suite ${suite.id}`);
  if (suite.defaults) connectionSettings(suite.defaults, `Suite ${suite.id} defaults`);
  if (suite.targetPolicy !== undefined) {
    if (!suite.targetPolicy || typeof suite.targetPolicy !== "object" || Array.isArray(suite.targetPolicy)) throw new Error(`Suite ${suite.id}: targetPolicy must be an object.`);
    keys(suite.targetPolicy, ["sqlServer"], `Suite ${suite.id} targetPolicy`);
    const sqlServer = suite.targetPolicy.sqlServer;
    if (!sqlServer || typeof sqlServer !== "object" || Array.isArray(sqlServer)) throw new Error(`Suite ${suite.id}: targetPolicy.sqlServer is required.`);
    keys(sqlServer, ["environments"], `Suite ${suite.id} targetPolicy.sqlServer`);
    if (!sqlServer.environments || typeof sqlServer.environments !== "object" || Array.isArray(sqlServer.environments) || !Object.keys(sqlServer.environments).length ||
        Object.entries(sqlServer.environments).some(([environment, enabled]) => !/^[a-z0-9][a-z0-9._-]*$/.test(environment) || typeof enabled !== "boolean")) {
      throw new Error(`Suite ${suite.id}: targetPolicy.sqlServer.environments must map environment IDs to booleans.`);
    }
  }
  if (!Array.isArray(suite.members) || !suite.members.length) throw new Error(`Suite ${suite.id} requires at least one member.`);
  const ids = new Set<string>();
  for (const member of suite.members) {
    if (!member || typeof member.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(member.id)) throw new Error(`Suite ${suite.id}: each member needs a stable id.`);
    if (ids.has(member.id)) throw new Error(`Suite ${suite.id}: duplicate member id '${member.id}'.`);
    ids.add(member.id);
    keys(member, ["id", "ref", "contract", "name", "description", "metadata", "targetOverrideMode", "targetOverrides"], `Member ${member.id}`);
    if ((member.ref !== undefined) === (member.contract !== undefined)) throw new Error(`Member ${member.id}: declare exactly one of ref or contract.`);
    if (member.ref !== undefined && (typeof member.ref !== "string" || !member.ref.trim())) throw new Error(`Member ${member.id}: ref must be a non-empty file path.`);
    if (member.targetOverrides !== undefined) {
      if (!Array.isArray(member.targetOverrides) || !member.targetOverrides.length) throw new Error(`Member ${member.id}: targetOverrides must be a non-empty array.`);
      const overridden = new Set<string>();
      for (const override of member.targetOverrides) {
        if (!override || typeof override !== "object" || Array.isArray(override)) throw new Error(`Member ${member.id}: invalid target override.`);
        keys(override, ["target", "enabled", "replacement"], `Member ${member.id} target override`);
        if (typeof override.target !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(override.target) ||
            override.enabled !== undefined && typeof override.enabled !== "boolean" || override.enabled === undefined && override.replacement === undefined || overridden.has(override.target)) {
          throw new Error(`Member ${member.id}: invalid or duplicate target override.`);
        }
        if (override.replacement !== undefined) targetReplacement(override.replacement, `Member ${member.id} target override '${override.target}'`);
        overridden.add(override.target);
      }
    }
    if (member.targetOverrideMode !== undefined && !["merge", "replace"].includes(member.targetOverrideMode)) throw new Error(`Member ${member.id}: targetOverrideMode must be merge or replace.`);
    if (member.targetOverrideMode === "replace" && !member.targetOverrides?.length) throw new Error(`Member ${member.id}: replace mode requires targetOverrides.`);
  }
  if (suite.targetMatrix !== undefined) {
    if (!Array.isArray(suite.targetMatrix) || !suite.targetMatrix.length) throw new Error(`Suite ${suite.id}: targetMatrix must be a non-empty array.`);
    const matrixIds = new Set<string>();
    for (const entry of suite.targetMatrix) {
      if (!entry || typeof entry !== "object") throw new Error(`Suite ${suite.id}: invalid targetMatrix entry.`);
      keys(entry, ["id", "name", "target"], `Suite ${suite.id} targetMatrix`);
      if (typeof entry.id !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(entry.id) || matrixIds.has(entry.id) || typeof entry.target !== "string" || !entry.target.trim() || entry.name !== undefined && typeof entry.name !== "string") throw new Error(`Suite ${suite.id}: invalid or duplicate targetMatrix entry.`);
      matrixIds.add(entry.id);
    }
  }
  const checks = new Set<string>();
  if (suite.crossChecks !== undefined && !Array.isArray(suite.crossChecks)) throw new Error("crossChecks must be an array.");
  for (const check of suite.crossChecks ?? []) {
    if (!check || !/^[a-z0-9][a-z0-9._-]*$/.test(check.id) || checks.has(check.id) || !ids.has(check.from) || !ids.has(check.to) || !["foreignKey", "equalPopulation", "equalTotal", "rowReconciliation", "relationship"].includes(check.kind)) throw new Error("Invalid cross-check identity, kind or member dependency.");
    keys(check, ["id", "kind", "from", "to", "keys", "valueColumns", "valueMappings", "tolerance", "nulls", "severity", "lookup", "when", "expect", "missing", "evidence", "fromSelections", "toSelections", "crossConnection"], `Cross-check ${check.id}`);
    if (check.crossConnection !== undefined) {
      if (!check.crossConnection || typeof check.crossConnection !== "object" || Array.isArray(check.crossConnection)) throw new Error(`Cross-check ${check.id}: crossConnection must be an object.`);
      keys(check.crossConnection, ["enabled", "maxRows"], `Cross-check ${check.id} crossConnection`);
      if (check.crossConnection.enabled !== true || check.crossConnection.maxRows !== undefined && (!Number.isInteger(check.crossConnection.maxRows) || check.crossConnection.maxRows < 1 || check.crossConnection.maxRows > 250000)) {
        throw new Error(`Cross-check ${check.id}: crossConnection requires enabled: true and maxRows between 1 and 250000 when supplied.`);
      }
    }
    if (check.keys !== undefined) crossKeys(check.keys, `Cross-check ${check.id} keys`);
    if (check.valueColumns !== undefined && (!check.valueColumns || typeof check.valueColumns.from !== "string" || typeof check.valueColumns.to !== "string" || Object.keys(check.valueColumns).some(p => !["from", "to"].includes(p)))) throw new Error("Invalid total value columns.");
    if (check.valueMappings !== undefined && (!Array.isArray(check.valueMappings) || !check.valueMappings.length || check.valueMappings.some(mapping => !mapping || typeof mapping.from !== "string" || typeof mapping.to !== "string" || mapping.blankTo !== undefined && typeof mapping.blankTo !== "string" || mapping.otherwise !== undefined && mapping.otherwise !== "preserve" || mapping.blankTo === undefined && mapping.otherwise === undefined || Object.keys(mapping).some(p => !["from", "to", "blankTo", "otherwise"].includes(p))))) throw new Error("Invalid reconciliation value mappings.");
    if (check.tolerance !== undefined && (typeof check.tolerance !== "string" || !/^(?:0|[1-9]\d{0,17})(?:\.\d{1,10})?$/.test(check.tolerance))) throw new Error("Invalid total tolerance.");
    if (check.kind === "foreignKey" && !check.keys?.length || check.kind === "equalTotal" && !check.valueColumns || check.kind === "rowReconciliation" && (!check.keys?.length || !check.valueMappings?.length) || check.kind === "relationship" && (!check.keys?.length || !check.lookup?.orderBy?.length || !check.expect)) throw new Error("Cross-check requires keys, total value columns, reconciliation mappings, or a relationship lookup and expectation.");
    if (check.nulls !== undefined && !["ignore", "fail"].includes(check.nulls)) throw new Error("Invalid cross-check null policy.");
    if (check.severity !== undefined && !["warning", "error"].includes(check.severity)) throw new Error("Invalid cross-check severity.");
    if (check.missing !== undefined && !["fail", "ignore"].includes(check.missing)) throw new Error("Invalid relationship missing-row policy.");
    if (check.evidence !== undefined && !["rows", "aggregate"].includes(check.evidence)) throw new Error("Invalid cross-check evidence policy.");
    if (check.kind !== "relationship" && (check.lookup !== undefined || check.when !== undefined || check.expect !== undefined || check.missing !== undefined)) throw new Error("lookup, when, expect, and missing are only valid for relationship cross-checks.");
    if (check.kind === "relationship" && (check.valueColumns !== undefined || check.valueMappings !== undefined || check.tolerance !== undefined)) throw new Error("Relationship cross-checks cannot declare total or reconciliation fields.");
    if (check.lookup !== undefined) {
      if (!check.lookup || typeof check.lookup !== "object") throw new Error("Invalid relationship lookup.");
      keys(check.lookup, ["orderBy"], `Cross-check ${check.id} lookup`);
      if (!Array.isArray(check.lookup.orderBy) || !check.lookup.orderBy.length || check.lookup.orderBy.some(order => !order || typeof order.column !== "string" || !order.column || !["date", "number", "string"].includes(order.type) || order.direction !== undefined && !["asc", "desc"].includes(order.direction) || Object.keys(order).some(key => !["column", "type", "direction"].includes(key)))) throw new Error("Invalid relationship lookup ordering.");
    }
    if (check.when !== undefined) crossPredicate(check.when, `Cross-check ${check.id} when`);
    if (check.expect !== undefined) crossPredicate(check.expect, `Cross-check ${check.id} expect`);
    if (check.fromSelections !== undefined) crossSelections(check.fromSelections, ids, `Cross-check ${check.id} fromSelections`);
    if (check.toSelections !== undefined) crossSelections(check.toSelections, ids, `Cross-check ${check.id} toSelections`);
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
  if (!isSuiteText(text)) {
    const packs = await resolveContractRulePacks(parseContract(text), source, io);
    const resolvedContract = await resolveGroupContracts(packs.contract, source, io);
    validateRuleTargetSelectors(resolvedContract);
    resolveSuiteSqlServerTargets(resolvedContract, undefined, [], false);
    return { id: source, source, isSuite: false, members: [{ id: source, source,
      contract: resolvedContract, ...(packs.provenance.length ? { rulePackProvenance: packs.provenance } : {}) }] };
  }
  const suite = parseSuite(text);
  const members: LoadedMember[] = [];
  for (const member of suite.members) {
    const location = member.ref ? io.resolve(source, member.ref) : source;
    try {
      let contract = member.contract;
      let rulePackProvenance: RulePackProvenance[] = [];
      let alreadyResolved = false;
      if (member.ref) {
        const loaded = await loadSuite(location, io, [...ancestors, canonical]);
        if (loaded.isSuite) {
          const cycle = loaded.members.find((entry) => entry.error?.includes("Reference cycle"));
          throw new Error(cycle?.error ?? "References must point to individual contracts; nested suites are not supported.");
        }
        contract = loaded.members[0].contract;
        rulePackProvenance = loaded.members[0].rulePackProvenance ?? [];
        alreadyResolved = true;
      }
      if (!contract) throw new Error(`Member ${member.id}: contract was not loaded.`);
      if (!alreadyResolved) contract = parseContract(stringify(contract));
      if (!validateContractShape(contract)) throw new Error(`Invalid contract: ${JSON.stringify(validateContractShape.errors)}`);
      const own = (value: SuiteConnection | undefined) => value?.connection !== undefined || value?.integratedConnection !== undefined;
      const connectionOrigins = contract.sqlServer?.targets?.map(target => own(target) ? "table override" : own(contract.sqlServer) ? "contract" : own(suite.defaults) ? "suite default" : "unconfigured")
        ?? (contract.sqlServer ? [own(contract.sqlServer) ? "contract" : own(suite.defaults) ? "suite default" : "unconfigured"] : []);
      let resolvedContract: CsvContract;
      if (alreadyResolved) {
        // Apply connection defaults to the resolved definition without serializing or resolving it
        // again. Preserve non-enumerable resolved group bindings created by the child loader.
        resolvedContract = effectiveContract(contract, suite.defaults);
        if (contract.groupTests) resolvedContract.groupTests = contract.groupTests;
      } else {
        const packs = await resolveContractRulePacks(effectiveContract(contract, suite.defaults), location, io);
        resolvedContract = await resolveGroupContracts(packs.contract, location, io);
        rulePackProvenance = packs.provenance;
      }
      // Validate target identities and override references while retaining the unmodified child definition.
      validateRuleTargetSelectors(resolvedContract);
      resolveSuiteSqlServerTargets(resolvedContract, suite.targetPolicy, member.targetOverrides, false, member.targetOverrideMode);
      members.push({ id: member.id, source: location, contract: resolvedContract, connectionOrigins,
        ...(member.targetOverrides ? { targetOverrides: member.targetOverrides } : {}), ...(member.targetOverrideMode ? { targetOverrideMode: member.targetOverrideMode } : {}), ...(rulePackProvenance.length ? { rulePackProvenance } : {}) });
    } catch (error) {
      members.push({ id: member.id, source: location, error: errorDetails(error) });
    }
  }
  const targetPolicyDiagnostics = diagnoseSuiteTargetPolicy(suite.targetPolicy, members.flatMap((member) => member.contract ? [member.contract] : []));
  return { id: suite.id, source, isSuite: true, members, ...(suite.crossChecks ? { crossChecks: suite.crossChecks } : {}), ...(suite.targetMatrix ? { targetMatrix: suite.targetMatrix } : {}),
    ...(suite.targetPolicy ? { targetPolicy: suite.targetPolicy } : {}), ...(targetPolicyDiagnostics.length ? { targetPolicyDiagnostics } : {}) };
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
  targetIndex?: number;
  targetId?: string;
  environment?: string;
  enabledSource?: SuiteTargetEnabledSource;
  status: SuiteStatus;
  result?: ValidationResult;
  error?: string;
}
export interface SuiteReport {
  suite: string;
  runId: string;
  startedAt: string;
  completedAt: string;
  scope: string[] | "all";
  valid: boolean;
  status: SuiteStatus;
  exitCode: 0 | 1 | 2;
  summary: Record<SuiteStatus, number>;
  members: { id: string; runs: SuiteRun[] }[];
  runs: SuiteRun[];
}
interface GeneratedSuiteSqlBatch extends ReturnType<typeof generateSqlServerValidation> {
  member: string;
  table: string;
  connection: string;
  integratedConnection?: SqlServerIntegratedConnection;
  targetId?: string;
  environment?: string;
  enabledSource?: SuiteTargetEnabledSource;
}
export async function runSuite(suite: LoadedSuite, validate: (contract: CsvContract, target: ResolvedSqlServerTarget, source: string, index?: number,
  onProgress?: (progress: ValidationProgress) => void) => Promise<ValidationResult>, failFast = false,
  validateFile?: (contract: CsvContract, source: string, target: CsvTarget, index?: number,
    onProgress?: (progress: ValidationProgress) => void) => Promise<ValidationResult>,
  controls: { signal?: AbortSignal; members?: string[]; onProgress?: (run: SuiteRun, index?: number) => void;
    onTargetStart?: (target: Pick<SuiteRun, "suite" | "member" | "spec" | "table" | "target" | "targetIndex" | "targetId" | "environment" | "enabledSource">, index: number) => void;
    onTargetProgress?: (target: Pick<SuiteRun, "suite" | "member" | "spec" | "table" | "target" | "targetIndex" | "targetId" | "environment" | "enabledSource">, progress: ValidationProgress, index: number) => void;
    parallelTargets?: number; parallelMembers?: number; crossExecutor?: CrossExecutor } = {}): Promise<SuiteReport> {
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
      const policyResolution = resolveSuiteSqlServerTargets(evaluatedContract, suite.targetPolicy, member.targetOverrides, true, member.targetOverrideMode);
      const effectiveSqlTargets = policyResolution.targets;
      const targets = effectiveSqlTargets.filter((target) => target.enabled).map((target) => ({ ...target, resolvedTarget: target.resolvedTarget! }));
      const fileTargets = (validateFile ? member.contract.targets ?? [] : []).filter(target => target.enabled !== false);
      if (suite.isSuite) {
        for (const target of effectiveSqlTargets.filter((entry) => !entry.enabled)) {
          const identity = { ...base, table: `${target.target.schema}.${target.target.table}`, target: target.target.name ?? `${target.target.schema}.${target.target.table}`, targetIndex: target.index,
            ...(target.id ? { targetId: target.id } : {}), ...(target.environment ? { environment: target.environment } : {}), enabledSource: target.enabledSource };
          const skipped = { ...identity, status: "SKIPPED" as const, error: `Disabled by ${target.enabledSource}.` };
          memberRuns.push(skipped);
          controls.onProgress?.(skipped, target.index);
        }
      }
      if (!targets.length && !fileTargets.length && (!suite.isSuite || !effectiveSqlTargets.length)) throw new Error("No enabled targets configured for this member.");
      if (!failFast && controls.parallelTargets !== undefined && controls.parallelTargets >= 1) {
        const jobs = [
          ...targets.map((effective) => { const target = effective.resolvedTarget; const identity = { ...base, table: `${target.schema}.${target.table}`, target: target.name ?? `${target.schema}.${target.table}`, targetIndex: effective.index,
            ...(effective.id ? { targetId: effective.id } : {}), ...(effective.environment ? { environment: effective.environment } : {}), enabledSource: effective.enabledSource };
            return { identity, targetIndex: effective.index, execute: () => validate(contractForTarget(evaluatedContract, effective.id), target, member.source, effective.index,
              progress => controls.onTargetProgress?.(identity, progress, effective.index)) }; }),
          ...fileTargets.map((target, fileIndex) => { const targetIndex = effectiveSqlTargets.length + fileIndex; const identity = { ...base, target: target.path ?? target.url, targetIndex }; return ({ identity, targetIndex,
            execute: () => validateFile!(contractForTarget(evaluatedContract, target.id), member.source, target, targetIndex,
              progress => controls.onTargetProgress?.(identity, progress, targetIndex)) }); })
        ];
        const outcomes: SuiteRun[] = new Array(jobs.length);
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(jobs.length, Math.floor(controls.parallelTargets!)) }, async () => {
          while (next < jobs.length) {
            const index = next++;
            const job = jobs[index];
            if (controls.signal?.aborted) {
              outcomes[index] = { ...job.identity, status: "CANCELED", error: "Canceled before target execution." };
              controls.onProgress?.(outcomes[index], job.targetIndex);
              continue;
            }
            controls.onTargetStart?.(job.identity, job.targetIndex);
            const started = Date.now();
            try {
              const result = await job.execute();
              result.evaluatedAt = startedAt;
              outcomes[index] = controls.signal?.aborted
                ? { ...job.identity, status: "CANCELED", error: "Canceled during execution; result discarded." }
                : { ...job.identity, status: result.valid ? "PASS" : "FAIL", result, durationMs: Date.now() - started };
            } catch (error) {
              outcomes[index] = { ...job.identity, status: controls.signal?.aborted ? "CANCELED" : "ERROR", error: errorDetails(error) };
            }
            controls.onProgress?.(outcomes[index], job.targetIndex);
          }
        }));
        memberRuns.push(...outcomes);
        return memberRuns;
      }
      for (const effective of targets) {
        const targetIndex = effective.index;
        const target = effective.resolvedTarget;
        const identity = { ...base, table: `${target.schema}.${target.table}`, target: target.name ?? `${target.schema}.${target.table}`, targetIndex,
          ...(effective.id ? { targetId: effective.id } : {}), ...(effective.environment ? { environment: effective.environment } : {}), enabledSource: effective.enabledSource };
        if (controls.signal?.aborted) { memberRuns.push({ ...identity, status: "CANCELED", error: "Canceled before target execution." }); continue; }
        if (stopped) { memberRuns.push({ ...identity, status: "SKIPPED", error: "Not executed after fail-fast." }); continue; }
        try {
          controls.onTargetStart?.(identity, targetIndex);
          const started = Date.now();
          const result = await validate(contractForTarget(evaluatedContract, effective.id), target, member.source, targetIndex,
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
        const targetIndex = effectiveSqlTargets.length + fileIndex;
        const identity = { ...base, target: target.path ?? target.url, targetIndex };
        if (controls.signal?.aborted) { memberRuns.push({ ...identity, status: "CANCELED", error: "Canceled before target execution." }); continue; }
        if (stopped) { memberRuns.push({ ...identity, status: "SKIPPED", error: "Not executed after fail-fast." }); continue; }
        try {
          controls.onTargetStart?.(identity, targetIndex);
          const started = Date.now();
          const result = await validateFile!(contractForTarget(evaluatedContract, target.id), member.source, target, targetIndex,
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
  const policyMembers = suite.members.map((member) => member.contract ? { ...member, contract: applySuiteTargetPolicy(member.contract, suite.targetPolicy, member.targetOverrides, member.targetOverrideMode) } : member);
  for (const { check, matrix } of (suite.crossChecks ?? []).flatMap(check => (suite.targetMatrix?.length ? suite.targetMatrix : [undefined]).map(matrix => ({ check, matrix })))) {
    const suffix = matrix ? `@${matrix.id}` : "";
    const base = { suite: suite.id, member: `cross:${check.id}${suffix}`, spec: suite.source, target: `${check.from} → ${check.to}${matrix ? ` (${matrix.name ?? matrix.id})` : ""}` };
    if (controls.signal?.aborted) { runs.push({ ...base, status: "CANCELED", error: "Canceled before cross-check execution." }); continue; }
    if (stopped || (controls.members && !controls.members.some(id => id === check.from || id === check.to))) { runs.push({ ...base, status: "SKIPPED", error: "Cross-check outside selected scope or stopped by fail-fast." }); continue; }
    try {
      const plan = planCrossCheck(check, policyMembers, matrix ? { targetName: matrix.target } : undefined);
      if (!controls.crossExecutor) throw new Error("Cross-table execution is unavailable in this host.");
      const result = await controls.crossExecutor(plan, controls.signal);
      runs.push(controls.signal?.aborted ? { ...base, status: "CANCELED", error: "Cross-check canceled; result discarded." } : { ...base, status: result.valid ? "PASS" : "FAIL", result });
      if (failFast && !result.valid) stopped = true;
    } catch (error) { runs.push({ ...base, status: controls.signal?.aborted ? "CANCELED" : "ERROR", error: errorDetails(error) }); if (failFast) stopped = true; }
  }
  runs.forEach(run => { if (run.result?.preview?.scope === "sample") run.status = "SAMPLED"; });
  const status: SuiteStatus = runs.some((r) => r.status === "ERROR") || !runs.length ? "ERROR"
    : runs.some((r) => r.status === "CANCELED") ? "CANCELED" : runs.some((r) => r.status === "FAIL") ? "FAIL" : runs.some((r) => r.status === "SKIPPED") ? "SKIPPED" : runs.some(r => r.status === "SAMPLED") ? "SAMPLED" : "PASS";
  const identities = new Map<string, number>();
  runs.forEach((run) => {
    const identity = JSON.stringify([suite.id, run.member, run.targetId ?? (run.targetIndex === undefined ? null : `index:${run.targetIndex}`), run.table ?? (run.member.startsWith("cross:") ? "cross" : "target")]);
    const occurrence = identities.get(identity) ?? 0;
    identities.set(identity, occurrence + 1);
    const targetScope = run.targetIndex === undefined ? undefined : { targetIndex: run.targetIndex, ...(run.targetId ? { targetId: run.targetId } : {}), ...(run.environment ? { environment: run.environment } : {}) };
    Object.assign(run, { workId: `suite:${identity}:${occurrence}`, runId, evaluatedAt: startedAt,
      scope: run.result?.preview ? JSON.stringify({ preview: run.result.preview, rules: run.result.ruleOutcomes?.map(r => r.id), ...(targetScope ? { target: targetScope } : {}) })
        : targetScope ? JSON.stringify({ members: controls.members ?? "all", target: targetScope }) : controls.members ? JSON.stringify(controls.members) : "all" });
  });
  const summary = Object.fromEntries((["PASS", "FAIL", "ERROR", "SKIPPED", "CANCELED", "SAMPLED"] as const).map((value) => [value, runs.filter((run) => run.status === value).length])) as Record<SuiteStatus, number>;
  return { suite: suite.id, runId, startedAt, completedAt: new Date().toISOString(), scope: controls.members ?? "all", valid: status === "PASS", status, exitCode: status === "PASS" ? 0 : status === "FAIL" ? 1 : 2,
    summary, members: suite.members.map((m) => ({ id: m.id, runs: runs.filter((r) => r.member === m.id) })), runs };
}

export function generateSuiteSql(suite: LoadedSuite) {
  for (const member of suite.members) if (member.contract?.groupTests?.length || member.contract?.orderedRules?.length) {
    throw new Error(`Standalone SQL generation cannot include grouped or ordered rules in ${member.id}; run dbtest.`);
  }
  const batches: GeneratedSuiteSqlBatch[] = suite.members.flatMap((member): GeneratedSuiteSqlBatch[] => {
    if (member.error || !member.contract) throw new Error(`${suite.id}/${member.id}: ${member.error ?? "Missing contract"}`);
    const targets = resolveSuiteSqlServerTargets(member.contract, suite.targetPolicy, member.targetOverrides, false, member.targetOverrideMode).targets.filter((target) => target.enabled)
      .map((target) => ({ ...target, resolvedTarget: target.resolvedTarget! }));
    if (!targets.length) throw new Error(`${suite.id}/${member.id}: no SQL Server target.`);
    return targets.map((effective) => { const target = effective.resolvedTarget; return ({ member: member.id, table: `${target.schema}.${target.table}`, connection: target.connection, integratedConnection: target.integratedConnection,
      ...(effective.id ? { targetId: effective.id } : {}), ...(effective.environment ? { environment: effective.environment } : {}), enabledSource: effective.enabledSource,
      ...generateSqlServerValidation(contractForTarget(member.contract!, effective.id), { target, includeDetailQueries: false, suite: { id: suite.id, member: member.id } }) }); });
  });
  const policyMembers = suite.members.map((member) => member.contract ? { ...member, contract: applySuiteTargetPolicy(member.contract, suite.targetPolicy, member.targetOverrides, member.targetOverrideMode) } : member);
  for (const { check, matrix } of (suite.crossChecks ?? []).flatMap(check => (suite.targetMatrix?.length ? suite.targetMatrix : [undefined]).map(matrix => ({ check, matrix })))) {
    const plan = planCrossCheck(check, policyMembers, matrix ? { targetName: matrix.target } : undefined);
    if (plan.mode !== "sql") throw new Error(`Standalone SQL generation cannot include CSV cross-check ${check.id}; run the suite instead.`);
    const parameters = [plan.from, plan.to, ...Object.values(plan.participants)].flatMap(target => target.scope ? [`DECLARE @${target.scope.parameter} nvarchar(max) = NULL; -- Set this participant's runtime scope value.\nIF @${target.scope.parameter} IS NULL THROW 50001, 'Set @${target.scope.parameter} before running this cross-check.', 1;`] : []).join("\n");
    batches.push({ member: `cross:${check.id}${matrix ? `@${matrix.id}` : ""}`, table: `${check.from} → ${check.to}${matrix ? ` (${matrix.name ?? matrix.id})` : ""}`, connection: plan.from.connection, integratedConnection: plan.from.integratedConnection,
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

import type { CsvContract, SqlServerTableTarget } from "./model";
import { resolveSqlServerTargets, type ResolvedSqlServerTarget } from "./sql-server-targets";

export type SuiteTargetEnabledSource = "member-override" | "suite-policy" | "contract" | "default";

export interface SuiteSqlServerTargetPolicy {
  environments: Record<string, boolean>;
}

export interface SuiteTargetPolicy {
  sqlServer?: SuiteSqlServerTargetPolicy;
}

export interface SuiteTargetOverride {
  target: string;
  enabled: boolean;
}

export interface SuiteTargetPolicyDiagnostic {
  severity: "warning";
  code: "SUITE_TARGET_ENVIRONMENT_UNUSED";
  message: string;
  environment: string;
}

export interface EffectiveSuiteSqlServerTarget {
  /** The configured target. This object is cloned and never mutates the child contract. */
  target: SqlServerTableTarget;
  /** Present only when the effective target is enabled and passes normal target validation. */
  resolvedTarget?: ResolvedSqlServerTarget;
  index: number;
  id?: string;
  environment?: string;
  enabled: boolean;
  enabledSource: SuiteTargetEnabledSource;
}

const policyName = /^[a-z0-9][a-z0-9._-]*$/;

function configuredTargets(contract: CsvContract): SqlServerTableTarget[] {
  const sqlServer = contract.sqlServer;
  if (!sqlServer) return [];
  if (sqlServer.targets?.length) return sqlServer.targets.map((target) => structuredClone(target));
  if (sqlServer.schema && sqlServer.table) return [{
    enabled: sqlServer.enabled,
    connection: sqlServer.connection,
    integratedConnection: sqlServer.integratedConnection,
    schema: sqlServer.schema,
    table: sqlServer.table,
    objectType: sqlServer.objectType,
    columnMap: sqlServer.columnMap,
    scope: sqlServer.scope
  }];
  return [];
}

function resolvedTarget(contract: CsvContract, target: SqlServerTableTarget, requireConnection: boolean): ResolvedSqlServerTarget {
  const copy = structuredClone(contract);
  copy.sqlServer = { ...copy.sqlServer!, targets: [{ ...target, enabled: true }] };
  delete copy.sqlServer.schema;
  delete copy.sqlServer.table;
  return resolveSqlServerTargets(copy, requireConnection)[0];
}

/**
 * Resolve suite-only enablement without mutating the contract. Target IDs are scoped to one
 * contract, so different suite members may safely reuse the same ID.
 */
export function resolveSuiteSqlServerTargets(
  contract: CsvContract,
  targetPolicy?: SuiteTargetPolicy,
  targetOverrides: SuiteTargetOverride[] = [],
  requireConnection = true
): { targets: EffectiveSuiteSqlServerTarget[]; diagnostics: SuiteTargetPolicyDiagnostic[] } {
  const targets = configuredTargets(contract);
  const ids = new Map<string, number>();
  for (const [index, target] of targets.entries()) {
    if (target.id !== undefined) {
      if (!policyName.test(target.id)) throw new Error(`SQL Server target ${index + 1} has invalid id '${target.id}'.`);
      if (ids.has(target.id)) throw new Error(`SQL Server target id '${target.id}' must be unique within its contract.`);
      ids.set(target.id, index);
    }
    if (target.environment !== undefined && !policyName.test(target.environment)) {
      throw new Error(`SQL Server target ${target.id ?? index + 1} has invalid environment '${target.environment}'.`);
    }
  }

  const overrides = new Map<string, boolean>();
  for (const override of targetOverrides) {
    if (!ids.has(override.target)) throw new Error(`Target override references unknown SQL Server target id '${override.target}'.`);
    if (overrides.has(override.target)) throw new Error(`Target override for '${override.target}' is duplicated.`);
    overrides.set(override.target, override.enabled);
  }

  const environments = targetPolicy?.sqlServer?.environments ?? {};
  for (const [index, target] of targets.entries()) {
    if (target.environment !== undefined && Object.hasOwn(environments, target.environment) && target.id === undefined) {
      throw new Error(`SQL Server target ${index + 1} must declare a stable id before suite environment policy '${target.environment}' can apply.`);
    }
  }
  const effective = targets.map((target, index): EffectiveSuiteSqlServerTarget => {
    let enabled: boolean;
    let enabledSource: SuiteTargetEnabledSource;
    if (target.id !== undefined && overrides.has(target.id)) {
      enabled = overrides.get(target.id)!;
      enabledSource = "member-override";
    } else if (target.environment !== undefined && Object.hasOwn(environments, target.environment)) {
      enabled = environments[target.environment];
      enabledSource = "suite-policy";
    } else if (target.enabled !== undefined) {
      enabled = target.enabled;
      enabledSource = "contract";
    } else {
      enabled = true;
      enabledSource = "default";
    }
    return {
      target,
      index,
      ...(target.id !== undefined ? { id: target.id } : {}),
      ...(target.environment !== undefined ? { environment: target.environment } : {}),
      enabled,
      enabledSource,
      ...(enabled ? { resolvedTarget: resolvedTarget(contract, target, requireConnection) } : {})
    };
  });
  return { targets: effective, diagnostics: [] };
}

/** Return a runtime-only clone whose enabled flags reflect the suite policy. */
export function applySuiteTargetPolicy(contract: CsvContract, targetPolicy?: SuiteTargetPolicy, targetOverrides: SuiteTargetOverride[] = []): CsvContract {
  const copy = structuredClone(contract);
  const effective = resolveSuiteSqlServerTargets(copy, targetPolicy, targetOverrides, false).targets;
  if (!copy.sqlServer || !effective.length) return copy;
  if (copy.sqlServer.targets?.length) {
    copy.sqlServer.targets = copy.sqlServer.targets.map((target, index) => ({ ...target, enabled: effective[index].enabled }));
  } else {
    copy.sqlServer.enabled = effective[0].enabled;
  }
  return copy;
}

/** Warn once at suite scope when an environment policy cannot affect any loaded member. */
export function diagnoseSuiteTargetPolicy(targetPolicy: SuiteTargetPolicy | undefined, contracts: CsvContract[]): SuiteTargetPolicyDiagnostic[] {
  const configured = new Set(contracts.flatMap((contract) => configuredTargets(contract).map((target) => target.environment).filter((value): value is string => value !== undefined)));
  return Object.keys(targetPolicy?.sqlServer?.environments ?? {}).filter((environment) => !configured.has(environment)).map((environment) => ({
    severity: "warning",
    code: "SUITE_TARGET_ENVIRONMENT_UNUSED",
    environment,
    message: `Suite SQL Server environment policy '${environment}' matches no configured targets.`
  }));
}

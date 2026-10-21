import Ajv from "ajv/dist/2020";
import { isAlias, parseDocument, visit } from "yaml";
import schema from "../../schemas/rulepack.schema.json";
import type { CsvContract, ConditionalRule, GroupRule, GroupTest, OrderedRule } from "./model";
import type { SuiteIO } from "./suite";
import { predicateColumns } from "./predicate";
import { validateOrderedDefinition } from "./ordered-rule";
import { groupSelectionColumns } from "./group-selection";

export type RulePackScalar = string | number | boolean | null;

export interface RulePackParameter {
  required?: boolean;
  default?: RulePackScalar;
  description?: string;
}

export interface RulePackUse {
  id: string;
  ref: string;
  sha256: string;
  definition: string;
  parameters?: Record<string, RulePackScalar>;
  /** Stable logical target IDs on which every rule contributed by this binding executes. */
  targets?: string[];
}

export interface RulePackFragment {
  rules?: ConditionalRule[];
  groupRules?: GroupRule[];
  orderedRules?: OrderedRule[];
  groupTests?: GroupTest[];
}

export interface RulePackDefinition {
  id: string;
  description?: string;
  parameters?: Record<string, RulePackParameter>;
  uses?: RulePackUse[];
  fragment?: RulePackFragment;
}

export interface RulePackDocument {
  version: 1;
  id: string;
  definitions: RulePackDefinition[];
}

export interface RulePackRead {
  text: string;
  sha256: string;
  canonicalSource: string;
}

export interface RulePackIO {
  read(source: string): Promise<RulePackRead>;
  /** Resolve a local path relative to the containing source and enforce any workspace boundary. */
  resolve(containingSource: string, ref: string): Promise<string>;
}

export interface RulePackProvenance {
  source: string;
  sha256: string;
  packId: string;
  definitionId: string;
  viaUseId?: string;
  parameters: Record<string, RulePackScalar>;
}

export interface ResolvedRulePackDefinition {
  packId: string;
  definitionId: string;
  fragment: RulePackFragment;
  provenance: RulePackProvenance[];
}

export interface ResolvedContractRulePacks {
  contract: CsvContract;
  provenance: RulePackProvenance[];
}

export interface RulePackExplanation {
  packId: string;
  definitionId: string;
  provenance: RulePackProvenance[];
  applicationOrder: Array<{ kind: keyof RulePackFragment; index: number; id: string }>;
  groupSelections: Array<{ id: string; groupBy: string[]; selection: string }>;
  orderedRules: Array<{ id: string; partitionBy: string[]; orderBy: string[]; checks: string[] }>;
}

export interface ResolvedRulePackCheck {
  key: string;
  kind: keyof RulePackFragment;
  id: string;
  digest: string;
  order: number;
}

export interface RulePackCheckChange {
  key: string;
  kind: keyof RulePackFragment;
  id: string;
  beforeDigest?: string;
  afterDigest?: string;
}

export interface RulePackCheckDiff {
  baselineAvailable: boolean;
  added: RulePackCheckChange[];
  removed: RulePackCheckChange[];
  changed: RulePackCheckChange[];
  unchanged: RulePackCheckChange[];
  proposed: ResolvedRulePackCheck[];
}

/** Runtime-only origin used by the group-contract loader; never serialized. */
export const rulePackGroupSource = Symbol("validation-rule-pack-group-source");
/** Runtime-only, verified provenance retained on resolved executable contracts. */
export const rulePackProvenance = Symbol("validation-rule-pack-provenance");

export function resolvedRulePackProvenance(contract: CsvContract): readonly RulePackProvenance[] {
  return (contract as CsvContract & { [rulePackProvenance]?: RulePackProvenance[] })[rulePackProvenance] ?? [];
}

const validateShape = new Ajv({ strict: false, allErrors: true, validateFormats: false }).compile(schema);
const placeholder = /\$\{([A-Za-z0-9._-]+)\}/g;

function safeObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (safeObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function stableDigest(value: unknown): string {
  // This is a stable content fingerprint for comparison, not a security boundary.
  let hash = 2166136261;
  for (const character of canonicalJson(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function parseRulePack(text: string): RulePackDocument {
  const document = parseDocument(text, { uniqueKeys: true });
  if (document.errors.length) throw new Error(`Invalid rule pack YAML: ${document.errors.map(error => error.message).join("; ")}`);
  visit(document, (_, node) => {
    if (isAlias(node) || (node && typeof node === "object" && "anchor" in node && node.anchor)) {
      throw new Error("Rule packs do not allow YAML anchors or aliases; reuse must be explicit and pinned.");
    }
  });
  const value = document.toJS() as unknown;
  if (!validateShape(value)) throw new Error(`Invalid rule pack: ${JSON.stringify(validateShape.errors)}`);
  const pack = value as unknown as RulePackDocument;
  const definitionIds = new Set<string>();
  for (const definition of pack.definitions) {
    if (definitionIds.has(definition.id)) throw new Error(`Duplicate rule-pack definition id ${definition.id}.`);
    definitionIds.add(definition.id);
    const useIds = new Set<string>();
    for (const use of definition.uses ?? []) {
      if (useIds.has(use.id)) throw new Error(`Duplicate use id ${use.id} in definition ${definition.id}.`);
      useIds.add(use.id);
      validateLocalRef(use.ref);
    }
  }
  return pack;
}

export function validateLocalRef(ref: string): void {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(ref) || /^[/\\]/.test(ref) || /^[A-Za-z]:[/\\]/.test(ref)) {
    throw new Error(`Rule-pack reference '${ref}' must be a relative local path; URLs and absolute paths are not allowed.`);
  }
  if (ref.includes("\0")) throw new Error("Rule-pack references cannot contain NUL bytes.");
}

function bindParameters(definition: RulePackDefinition, supplied: Record<string, RulePackScalar>): Record<string, RulePackScalar> {
  const declarations = definition.parameters ?? {};
  for (const name of Object.keys(supplied)) {
    if (!(name in declarations)) throw new Error(`Unknown parameter ${name} for definition ${definition.id}.`);
  }
  const bound: Record<string, RulePackScalar> = {};
  for (const [name, declaration] of Object.entries(declarations)) {
    if (name in supplied) bound[name] = supplied[name];
    else if ("default" in declaration) bound[name] = declaration.default!;
    else if (declaration.required !== false) throw new Error(`Missing required parameter ${name} for definition ${definition.id}.`);
  }
  return bound;
}

function substituteString(value: string, parameters: Record<string, RulePackScalar>): RulePackScalar {
  const exact = /^\$\{([A-Za-z0-9._-]+)\}$/.exec(value);
  if (exact) {
    if (!(exact[1] in parameters)) throw new Error(`Unbound parameter ${exact[1]}.`);
    return parameters[exact[1]];
  }
  return value.replace(placeholder, (_, name: string) => {
    if (!(name in parameters)) throw new Error(`Unbound parameter ${name}.`);
    const replacement = parameters[name];
    if (replacement === null) return "null";
    return String(replacement);
  });
}

function substitute(value: unknown, parameters: Record<string, RulePackScalar>): unknown {
  if (typeof value === "string") return substituteString(value, parameters);
  if (Array.isArray(value)) return value.map(item => substitute(item, parameters));
  if (safeObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, parameters)]));
  return value;
}

function merge(into: RulePackFragment, addition: RulePackFragment): void {
  for (const key of ["rules", "groupRules", "orderedRules", "groupTests"] as const) {
    const items = addition[key];
    if (!items?.length) continue;
    if (into[key]) (into[key] as unknown[]).push(...items);
    else into[key] = [...items] as never;
  }
}

function scopedFragment(fragment: RulePackFragment, targets?: string[]): RulePackFragment {
  if (!targets?.length) return fragment;
  const requested = new Set(targets);
  const scoped: RulePackFragment = {};
  for (const key of ["rules", "groupRules", "orderedRules", "groupTests"] as const) {
    const items = fragment[key];
    if (!items?.length) continue;
    scoped[key] = items.map(item => {
      const existing = (item as { targets?: string[] }).targets;
      const effective = existing ? existing.filter(target => requested.has(target)) : [...targets];
      return { ...item, targets: effective };
    }).filter(item => item.targets.length > 0) as never;
  }
  return scoped;
}

function allIds(fragment: RulePackFragment): string[] {
  const ids: string[] = [];
  const scan = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(scan);
    if (!safeObject(value)) return;
    if (typeof value.id === "string") ids.push(value.id);
    Object.values(value).forEach(scan);
  };
  scan(fragment);
  return ids;
}

function rejectDuplicateRuleIds(fragment: RulePackFragment): void {
  const seen = new Set<string>();
  for (const id of allIds(fragment)) {
    if (seen.has(id)) throw new Error(`Duplicate resolved rule id ${id}.`);
    seen.add(id);
  }
}

function rejectUndeclaredRuleColumns(contract: CsvContract): void {
  const declared = new Set(Object.keys(contract.schema.columns));
  const assertColumns = (id: string, columns: string[]): void => {
    for (const column of new Set(columns)) if (!declared.has(column)) {
      throw new Error(`Resolved rule ${id} references undeclared column ${column}.`);
    }
  };
  for (const rule of contract.rules ?? []) assertColumns(rule.id, [
    ...predicateColumns(rule.when), ...predicateColumns(rule.expect)
  ]);
  for (const rule of contract.groupRules ?? []) assertColumns(rule.id, [
    ...predicateColumns(rule.when), ...rule.groupBy, rule.require.column
  ]);
  for (const rule of contract.orderedRules ?? []) validateOrderedDefinition(rule, declared);
  for (const group of contract.groupTests ?? []) assertColumns(group.id, [
    ...group.groupBy, ...groupSelectionColumns(group.select)
  ]);
}

interface ResolveContext {
  io: RulePackIO;
  active: string[];
}

async function resolveOne(source: string, definitionId: string, supplied: Record<string, RulePackScalar>, context: ResolveContext,
  expectedHash?: string, viaUseId?: string): Promise<ResolvedRulePackDefinition> {
  const read = await context.io.read(source);
  if (expectedHash && read.sha256.toLowerCase() !== expectedHash.toLowerCase()) {
    throw new Error(`Pinned hash mismatch for ${source}: expected ${expectedHash.toLowerCase()}, found ${read.sha256.toLowerCase()}.`);
  }
  const key = `${read.canonicalSource}#${definitionId}`;
  const cycleAt = context.active.indexOf(key);
  if (cycleAt >= 0) throw new Error(`Rule-pack cycle detected: ${[...context.active.slice(cycleAt), key].join(" -> ")}.`);
  const pack = parseRulePack(read.text);
  const definition = pack.definitions.find(item => item.id === definitionId);
  if (!definition) throw new Error(`Definition ${definitionId} was not found in rule pack ${pack.id}.`);
  const parameters = bindParameters(definition, supplied);
  const next = { ...context, active: [...context.active, key] };
  const fragment: RulePackFragment = {};
  const provenance: RulePackProvenance[] = [];
  for (const use of definition.uses ?? []) {
    const childSource = await context.io.resolve(read.canonicalSource, use.ref);
    const childParameters = substitute(use.parameters ?? {}, parameters) as Record<string, RulePackScalar>;
    const child = await resolveOne(childSource, use.definition, childParameters, next, use.sha256, use.id);
    merge(fragment, scopedFragment(child.fragment, use.targets));
    provenance.push(...child.provenance);
  }
  const localFragment = substitute(definition.fragment ?? {}, parameters) as RulePackFragment;
  for (const group of localFragment.groupTests ?? []) {
    Object.defineProperty(group, rulePackGroupSource, { value: read.canonicalSource, enumerable: false });
  }
  merge(fragment, localFragment);
  provenance.push({ source: read.canonicalSource, sha256: read.sha256, packId: pack.id, definitionId, ...(viaUseId ? { viaUseId } : {}), parameters });
  rejectDuplicateRuleIds(fragment);
  return { packId: pack.id, definitionId, fragment, provenance };
}

export async function resolveRulePackDefinition(source: string, definitionId: string,
  parameters: Record<string, RulePackScalar>, io: RulePackIO): Promise<ResolvedRulePackDefinition> {
  return resolveOne(source, definitionId, parameters, { io, active: [] });
}

async function webSha256(text: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("SHA-256 is unavailable in this runtime; pinned rule packs cannot be verified.");
  const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, "0")).join("");
}

/** Adapt the browser-safe suite loader to pinned rule-pack reads. */
export function suiteRulePackIO(io: SuiteIO): RulePackIO {
  return {
    async read(source) {
      const text = await io.read(source);
      return { text, sha256: await webSha256(text), canonicalSource: await io.canonical?.(source) ?? source };
    },
    async resolve(containingSource, ref) {
      validateLocalRef(ref);
      return io.resolve(containingSource, ref);
    }
  };
}

/** Resolve and merge contract bindings before normal contract/group semantic validation. */
export async function resolveContractRulePacks(contract: CsvContract, source: string, io: SuiteIO): Promise<ResolvedContractRulePacks> {
  const bindings = (contract as CsvContract & { rulePacks?: RulePackUse[] }).rulePacks ?? [];
  if (!bindings.length) return { contract, provenance: [] };
  const packIO = suiteRulePackIO(io);
  const fragment: RulePackFragment = {};
  const provenance: RulePackProvenance[] = [];
  const bindingIds = new Set<string>();
  for (const binding of bindings) {
    if (bindingIds.has(binding.id)) throw new Error(`Duplicate contract rule-pack binding id ${binding.id}.`);
    bindingIds.add(binding.id);
    validateLocalRef(binding.ref);
    const referencedSource = await packIO.resolve(source, binding.ref);
    const resolved = await resolveOne(referencedSource, binding.definition, binding.parameters ?? {}, { io: packIO, active: [] }, binding.sha256, binding.id);
    merge(fragment, scopedFragment(resolved.fragment, binding.targets));
    provenance.push(...resolved.provenance);
  }
  const local = { ...contract } as CsvContract & { rulePacks?: RulePackUse[] };
  delete local.rulePacks;
  const resolvedContract: CsvContract = {
    ...local,
    ...((fragment.rules?.length || local.rules?.length) ? { rules: [...(fragment.rules ?? []), ...(local.rules ?? [])] } : {}),
    ...((fragment.groupRules?.length || local.groupRules?.length) ? { groupRules: [...(fragment.groupRules ?? []), ...(local.groupRules ?? [])] } : {}),
    ...((fragment.orderedRules?.length || local.orderedRules?.length) ? { orderedRules: [...(fragment.orderedRules ?? []), ...(local.orderedRules ?? [])] } : {}),
    ...((fragment.groupTests?.length || local.groupTests?.length) ? { groupTests: [...(fragment.groupTests ?? []), ...(local.groupTests ?? [])] } : {})
  };
  rejectDuplicateRuleIds({ rules: resolvedContract.rules, groupRules: resolvedContract.groupRules,
    orderedRules: resolvedContract.orderedRules, groupTests: resolvedContract.groupTests });
  rejectUndeclaredRuleColumns(resolvedContract);
  Object.defineProperty(resolvedContract, rulePackProvenance, { value: provenance, enumerable: false });
  return { contract: resolvedContract, provenance };
}

export function resolvedRulePackChecks(resolved: ResolvedRulePackDefinition): ResolvedRulePackCheck[] {
  const checks: ResolvedRulePackCheck[] = [];
  let order = 0;
  for (const kind of ["rules", "groupRules", "orderedRules", "groupTests"] as const) {
    for (const check of resolved.fragment[kind] ?? []) {
      checks.push({ key: `${kind}:${check.id}`, kind, id: check.id, digest: stableDigest(check), order: order++ });
    }
  }
  return checks;
}

export function compareResolvedRulePackChecks(current: ResolvedRulePackDefinition | undefined,
  proposed: ResolvedRulePackDefinition): RulePackCheckDiff {
  const before = current ? resolvedRulePackChecks(current) : [];
  const after = resolvedRulePackChecks(proposed);
  if (!current) return { baselineAvailable: false, added: [], removed: [], changed: [], unchanged: [], proposed: after };
  const beforeByKey = new Map(before.map(item => [item.key, item]));
  const afterByKey = new Map(after.map(item => [item.key, item]));
  const added: RulePackCheckChange[] = [];
  const removed: RulePackCheckChange[] = [];
  const changed: RulePackCheckChange[] = [];
  const unchanged: RulePackCheckChange[] = [];
  for (const item of after) {
    const previous = beforeByKey.get(item.key);
    const change = { key: item.key, kind: item.kind, id: item.id,
      ...(previous ? { beforeDigest: previous.digest } : {}), afterDigest: item.digest };
    if (!previous) added.push(change);
    else if (previous.digest === item.digest) unchanged.push(change);
    else changed.push(change);
  }
  for (const item of before) if (!afterByKey.has(item.key)) {
    removed.push({ key: item.key, kind: item.kind, id: item.id, beforeDigest: item.digest });
  }
  return { baselineAvailable: true, added, removed, changed, unchanged, proposed: after };
}

function orderedCheckIds(rule: OrderedRule): string[] {
  const checks = [rule.duplicateOrder, rule.invalidOrder, ...(rule.relations ?? []), rule.event?.unmapped, rule.initial,
    ...(rule.transitions ?? []), rule.invalidTransition, ...(rule.cardinality ?? []), ...(rule.adjacency ?? []), rule.invalidFinal]
    .filter(value => value !== undefined);
  return checks.map(value => value!.id);
}

/** Describe already-resolved declarative content. This never evaluates predicates or user-provided code. */
export function explainResolvedRulePack(resolved: ResolvedRulePackDefinition): RulePackExplanation {
  const applicationOrder: RulePackExplanation["applicationOrder"] = [];
  for (const kind of ["rules", "groupRules", "orderedRules", "groupTests"] as const) {
    (resolved.fragment[kind] ?? []).forEach((rule, index) => applicationOrder.push({ kind, index, id: rule.id }));
  }
  return {
    packId: resolved.packId,
    definitionId: resolved.definitionId,
    provenance: resolved.provenance,
    applicationOrder,
    groupSelections: (resolved.fragment.groupTests ?? []).map(group => ({
      id: group.id,
      groupBy: [...group.groupBy],
      selection: group.select ? JSON.stringify(group.select) : "all groups"
    })),
    orderedRules: (resolved.fragment.orderedRules ?? []).map(rule => ({
      id: rule.id,
      partitionBy: [...(rule.partitionBy ?? [])],
      orderBy: rule.orderBy.map(order => `${order.column}:${order.type}`),
      checks: orderedCheckIds(rule)
    }))
  };
}

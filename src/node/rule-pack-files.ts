import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { parseDocument, stringify } from "yaml";
import { parseContract } from "../core/contract";
import { resolveGroupContracts } from "../core/group-contracts";
import type { SuiteIO } from "../core/suite";
import {
  compareResolvedRulePackChecks,
  parseRulePack,
  resolveContractRulePacks,
  resolveRulePackDefinition,
  validateLocalRef,
  type RulePackCheckDiff,
  type RulePackIO,
  type RulePackProvenance,
  type RulePackUse
} from "../core/rule-packs";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function rulePackTextSha256(text: string): string { return sha256(text); }

function canonical(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function validationSuiteIO(workspaceRoot?: string): SuiteIO {
  const root = workspaceRoot ? resolve(workspaceRoot) : undefined;
  return {
    async read(location) {
      const actual = await realpath(resolve(location));
      if (root && !contained(root, actual)) throw new Error(`Validation dependency escapes the configured workspace: ${location}.`);
      return readFile(actual, "utf8");
    },
    resolve(containing, reference) {
      validateLocalRef(reference);
      const target = resolve(dirname(containing), reference);
      if (root && !contained(root, target)) throw new Error(`Validation dependency escapes the configured workspace: ${reference}.`);
      return target;
    },
    async canonical(location) {
      const actual = await realpath(resolve(location));
      if (root && !contained(root, actual)) throw new Error(`Validation dependency escapes the configured workspace: ${location}.`);
      return canonical(actual);
    }
  };
}

/** Filesystem adapter for local, optionally workspace-confined, pinned rule packs. */
export function fileRulePackIO(workspaceRoot?: string): RulePackIO {
  const rootPromise = workspaceRoot ? realpath(resolve(workspaceRoot)) : undefined;
  return {
    async read(source) {
      const actual = await realpath(resolve(source));
      if (rootPromise && !contained(await rootPromise, actual)) throw new Error(`Rule-pack path escapes the configured workspace: ${source}.`);
      const text = await readFile(actual, "utf8");
      return { text, sha256: sha256(text), canonicalSource: canonical(actual) };
    },
    async resolve(containingSource, ref) {
      validateLocalRef(ref);
      const actual = await realpath(resolve(dirname(containingSource), ref));
      if (rootPromise && !contained(await rootPromise, actual)) throw new Error(`Rule-pack reference escapes the configured workspace: ${ref}.`);
      return actual;
    }
  };
}

export interface RulePackPinPreview {
  ref: string;
  source: string;
  pinnedSha256: string;
  currentSha256: string;
  changed: boolean;
  proposedUse: RulePackUse;
}

/** Read-only update preview. The caller must explicitly persist proposedUse. */
export async function previewRulePackPin(containingSource: string, use: RulePackUse,
  workspaceRoot?: string): Promise<RulePackPinPreview> {
  const io = fileRulePackIO(workspaceRoot);
  const source = await io.resolve(resolve(containingSource), use.ref);
  const current = await io.read(source);
  return {
    ref: use.ref,
    source: current.canonicalSource,
    pinnedSha256: use.sha256.toLowerCase(),
    currentSha256: current.sha256,
    changed: current.sha256 !== use.sha256.toLowerCase(),
    proposedUse: { ...use, sha256: current.sha256 }
  };
}

export type RulePackBindingPath = Array<string | number>;

export interface RulePackBindingOwner {
  kind: "contract" | "suite-inline";
  source: string;
  memberId?: string;
  use: RulePackUse;
  path: RulePackBindingPath;
}

export interface ReferencedRulePackOwner {
  kind: "suite-reference";
  memberId: string;
  source: string;
  parentSource: string;
}

export interface RulePackBindingDiscovery {
  owners: RulePackBindingOwner[];
  references: ReferencedRulePackOwner[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function usesAt(value: unknown): RulePackUse[] {
  return isRecord(value) && Array.isArray(value.rulePacks) ? value.rulePacks as RulePackUse[] : [];
}

/** Locate only bindings owned by this exact document; referenced members are returned as redirects. */
export function discoverRulePackBindings(text: string, source: string): RulePackBindingDiscovery {
  const document = parseDocument(text, { uniqueKeys: true });
  if (document.errors.length) throw new Error(`Invalid validation YAML: ${document.errors.map(error => error.message).join("; ")}`);
  const value = document.toJS() as unknown;
  if (!isRecord(value)) throw new Error("Validation definition must be an object.");
  const owners: RulePackBindingOwner[] = [];
  const references: ReferencedRulePackOwner[] = [];
  if (Array.isArray(value.members)) {
    value.members.forEach((rawMember, memberIndex) => {
      if (!isRecord(rawMember)) return;
      const memberId = typeof rawMember.id === "string" ? rawMember.id : `member-${memberIndex + 1}`;
      if (typeof rawMember.ref === "string") {
        validateLocalRef(rawMember.ref);
        references.push({ kind: "suite-reference", memberId, source: resolve(dirname(source), rawMember.ref), parentSource: source });
        return;
      }
      usesAt(rawMember.contract).forEach((use, useIndex) => owners.push({ kind: "suite-inline", source, memberId, use,
        path: ["members", memberIndex, "contract", "rulePacks", useIndex] }));
    });
  } else {
    usesAt(value).forEach((use, useIndex) => owners.push({ kind: "contract", source, use, path: ["rulePacks", useIndex] }));
  }
  return { owners, references };
}

export interface RulePackDependencyStatus {
  source: string;
  ref: string;
  viaUseId: string;
  definitionId: string;
  expectedSha256: string;
  currentSha256?: string;
  matches: boolean;
  error?: string;
}

async function inspectDependencies(source: string, definitionId: string, io: RulePackIO, active: string[],
  statuses: RulePackDependencyStatus[]): Promise<void> {
  const read = await io.read(source);
  const key = `${read.canonicalSource}#${definitionId}`;
  if (active.includes(key)) return;
  const pack = parseRulePack(read.text);
  const definition = pack.definitions.find(item => item.id === definitionId);
  if (!definition) throw new Error(`Definition ${definitionId} was not found in rule pack ${pack.id}.`);
  for (const use of definition.uses ?? []) {
    const childSource = await io.resolve(read.canonicalSource, use.ref);
    let childRead: Awaited<ReturnType<RulePackIO["read"]>> | undefined;
    let error: string | undefined;
    try { childRead = await io.read(childSource); } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
    statuses.push({ source: childSource, ref: use.ref, viaUseId: use.id, definitionId: use.definition,
      expectedSha256: use.sha256.toLowerCase(), ...(childRead ? { currentSha256: childRead.sha256 } : {}),
      matches: childRead?.sha256 === use.sha256.toLowerCase(), ...(error ? { error } : {}) });
    if (childRead) {
      try { await inspectDependencies(childSource, use.definition, io, [...active, key], statuses); }
      catch (caught) { statuses.at(-1)!.error = caught instanceof Error ? caught.message : String(caught); }
    }
  }
}

export interface RulePackUpdatePreview {
  status: "unchanged" | "ready" | "invalid";
  canApply: boolean;
  diagnostic?: string;
  owner: RulePackBindingOwner;
  documentSha256: string;
  documentVersion?: number;
  referencedSource: string;
  pinnedSha256: string;
  proposedSha256?: string;
  beforeText?: string;
  proposedText?: string;
  semanticDiff?: RulePackCheckDiff;
  proposedProvenance: RulePackProvenance[];
  dependencies: RulePackDependencyStatus[];
}

export interface PreviewRulePackUpdateOptions {
  useId: string;
  memberId?: string;
  documentVersion?: number;
  workspaceRoot?: string;
  /** Optional prior bytes. They must hash exactly to the current pin before being used as a semantic baseline. */
  pinnedPackText?: string;
}

function shaNode(documentText: string, path: RulePackBindingPath): { start: number; end: number } {
  const document = parseDocument(documentText, { uniqueKeys: true });
  if (document.errors.length) throw new Error(`Invalid validation YAML: ${document.errors.map(error => error.message).join("; ")}`);
  const node = document.getIn([...path, "sha256"], true) as { range?: [number, number, number] } | undefined;
  if (!node?.range) throw new Error("Pinned sha256 scalar was not found at the selected binding.");
  return { start: node.range[0], end: node.range[1] };
}

async function validateProposedConsumer(documentText: string, owner: RulePackBindingOwner, proposedSha256: string,
  workspaceRoot?: string): Promise<RulePackProvenance[]> {
  const { start, end } = shaNode(documentText, owner.path);
  const proposedDocumentText = `${documentText.slice(0, start)}${proposedSha256}${documentText.slice(end)}`;
  const document = parseDocument(proposedDocumentText, { uniqueKeys: true });
  if (document.errors.length) throw new Error(`Invalid proposed validation YAML: ${document.errors.map(error => error.message).join("; ")}`);
  const contractPath = owner.kind === "contract" ? [] : owner.path.slice(0, 3);
  const rawContract = contractPath.length ? document.getIn(contractPath) : document.toJS();
  const contract = parseContract(stringify(rawContract));
  const io = validationSuiteIO(workspaceRoot);
  const packed = await resolveContractRulePacks(contract, owner.source, io);
  await resolveGroupContracts(packed.contract, owner.source, io);
  return packed.provenance;
}

export async function previewRulePackUpdate(documentSource: string, documentText: string,
  options: PreviewRulePackUpdateOptions): Promise<RulePackUpdatePreview> {
  documentSource = resolve(documentSource);
  const discovery = discoverRulePackBindings(documentText, documentSource);
  const matches = discovery.owners.filter(owner => owner.use.id === options.useId &&
    (options.memberId === undefined || owner.memberId === options.memberId));
  if (matches.length !== 1) throw new Error(`Expected one rule-pack binding '${options.useId}', found ${matches.length}.`);
  const owner = matches[0];
  if (typeof owner.use.ref !== "string" || typeof owner.use.sha256 !== "string" ||
    !/^[a-fA-F0-9]{64}$/.test(owner.use.sha256) || typeof owner.use.definition !== "string") {
    throw new Error(`Rule-pack binding '${options.useId}' is malformed; ref, definition, and a 64-character sha256 are required.`);
  }
  validateLocalRef(owner.use.ref);
  const io = fileRulePackIO(options.workspaceRoot);
  const referencedSource = await io.resolve(documentSource, owner.use.ref);
  let currentRead: Awaited<ReturnType<RulePackIO["read"]>>;
  try { currentRead = await io.read(referencedSource); }
  catch (caught) {
    return { status: "invalid", canApply: false, diagnostic: caught instanceof Error ? caught.message : String(caught), owner,
      documentSha256: sha256(documentText), ...(options.documentVersion === undefined ? {} : { documentVersion: options.documentVersion }),
      referencedSource, pinnedSha256: owner.use.sha256.toLowerCase(), proposedProvenance: [], dependencies: [] };
  }
  const dependencies: RulePackDependencyStatus[] = [];
  try { await inspectDependencies(referencedSource, owner.use.definition, io, [], dependencies); }
  catch (caught) { dependencies.push({ source: referencedSource, ref: owner.use.ref, viaUseId: owner.use.id,
    definitionId: owner.use.definition, expectedSha256: owner.use.sha256.toLowerCase(), currentSha256: currentRead.sha256,
    matches: currentRead.sha256 === owner.use.sha256.toLowerCase(), error: caught instanceof Error ? caught.message : String(caught) }); }
  const base = { owner, documentSha256: sha256(documentText),
    ...(options.documentVersion === undefined ? {} : { documentVersion: options.documentVersion }), referencedSource,
    pinnedSha256: owner.use.sha256.toLowerCase(), proposedSha256: currentRead.sha256, proposedText: currentRead.text, dependencies };
  let proposed;
  try { proposed = await resolveRulePackDefinition(referencedSource, owner.use.definition, owner.use.parameters ?? {}, io); }
  catch (caught) {
    return { ...base, status: "invalid", canApply: false, diagnostic: caught instanceof Error ? caught.message : String(caught),
      proposedProvenance: [] };
  }
  try { await validateProposedConsumer(documentText, owner, currentRead.sha256, options.workspaceRoot); }
  catch (caught) {
    return { ...base, status: "invalid", canApply: false,
      diagnostic: `The proposed pack is not valid in its consuming contract: ${caught instanceof Error ? caught.message : String(caught)}`,
      proposedProvenance: proposed.provenance };
  }
  let current = currentRead.sha256 === owner.use.sha256.toLowerCase() ? proposed : undefined;
  let beforeText: string | undefined;
  if (!current && options.pinnedPackText !== undefined) {
    const pinnedHash = sha256(options.pinnedPackText);
    if (pinnedHash !== owner.use.sha256.toLowerCase()) throw new Error(`Prior rule-pack bytes hash to ${pinnedHash}, not pinned ${owner.use.sha256.toLowerCase()}.`);
    beforeText = options.pinnedPackText;
    const overlay: RulePackIO = {
      read: async source => canonical(source) === canonical(referencedSource)
        ? { text: options.pinnedPackText!, sha256: pinnedHash, canonicalSource: canonical(referencedSource) }
        : io.read(source),
      resolve: (containing, ref) => io.resolve(containing, ref)
    };
    current = await resolveRulePackDefinition(referencedSource, owner.use.definition, owner.use.parameters ?? {}, overlay);
  } else if (current) beforeText = currentRead.text;
  const unchanged = currentRead.sha256 === owner.use.sha256.toLowerCase();
  return { ...base, status: unchanged ? "unchanged" : "ready", canApply: !unchanged,
    ...(beforeText === undefined ? {} : { beforeText }), semanticDiff: compareResolvedRulePackChecks(current, proposed),
    proposedProvenance: proposed.provenance };
}

export interface PrepareRulePackUpdateOptions {
  documentText: string;
  documentVersion?: number;
  workspaceRoot?: string;
}

/** Revalidate every previewed input and return a scalar-only YAML edit. This never writes either file. */
export async function prepareRulePackUpdateEdit(preview: RulePackUpdatePreview,
  options: PrepareRulePackUpdateOptions): Promise<{ updatedText: string; start: number; end: number; replacement: string }> {
  if (!preview.canApply || preview.status !== "ready" || !preview.proposedSha256) throw new Error("This rule-pack preview is not valid for apply.");
  if (sha256(options.documentText) !== preview.documentSha256) throw new Error("Validation document changed after preview; preview again before applying.");
  if (preview.documentVersion !== undefined && options.documentVersion !== preview.documentVersion) {
    throw new Error("Validation document version changed after preview; preview again before applying.");
  }
  const rediscovered = discoverRulePackBindings(options.documentText, preview.owner.source).owners
    .find(owner => JSON.stringify(owner.path) === JSON.stringify(preview.owner.path));
  if (!rediscovered || JSON.stringify(rediscovered.use) !== JSON.stringify(preview.owner.use)) {
    throw new Error("Rule-pack binding changed after preview; preview again before applying.");
  }
  const io = fileRulePackIO(options.workspaceRoot);
  const source = await io.resolve(preview.owner.source, rediscovered.use.ref);
  const current = await io.read(source);
  if (current.sha256 !== preview.proposedSha256) throw new Error("Referenced rule pack changed after preview; preview again before applying.");
  const resolved = await resolveRulePackDefinition(source, rediscovered.use.definition, rediscovered.use.parameters ?? {}, io);
  if (JSON.stringify(resolved.provenance) !== JSON.stringify(preview.proposedProvenance)) {
    throw new Error("A nested rule-pack dependency changed after preview; preview again before applying.");
  }
  await validateProposedConsumer(options.documentText, rediscovered, current.sha256, options.workspaceRoot);
  const { start, end } = shaNode(options.documentText, preview.owner.path);
  const updatedText = `${options.documentText.slice(0, start)}${preview.proposedSha256}${options.documentText.slice(end)}`;
  return { updatedText, start, end, replacement: preview.proposedSha256 };
}

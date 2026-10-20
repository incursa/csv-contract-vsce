import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import Ajv from "ajv/dist/2020";
import { isAlias, parseDocument, stringify, visit } from "yaml";
import schema from "../../schemas/validationfixtures.schema.json";
import { parseContract, validateCsv } from "../core/contract";
import { resolveGroupContracts } from "../core/group-contracts";
import type { CsvContract, ValidationResult } from "../core/model";
import { resolveContractRulePacks, validateLocalRef, type RulePackProvenance } from "../core/rule-packs";
import type { SuiteIO } from "../core/suite";

interface ExpectedRuleOutcome { id: string; selected?: number; passed?: number; failed?: number }
interface ExpectedGroupOutcome { id: string; groups?: number; passed?: number; failed?: number }
export interface ValidationFixtureExpectation {
  valid: boolean;
  rowCount?: number;
  issueCount?: number;
  errorCount?: number;
  warningCount?: number;
  issueCodes?: string[];
  issueRuleIds?: string[];
  ruleOutcomes?: ExpectedRuleOutcome[];
  groupOutcomes?: ExpectedGroupOutcome[];
}
export interface ValidationFixtureCase {
  id: string;
  description?: string;
  csv: string;
  expect: ValidationFixtureExpectation;
}
export interface ValidationFixtureDocument {
  version: 1;
  id: string;
  contract: { ref: string; sha256: string } | { inline: CsvContract };
  cases: ValidationFixtureCase[];
}
export interface ValidationFixtureCaseResult {
  id: string;
  passed: boolean;
  failures: string[];
  result: ValidationResult;
}
export interface ValidationFixtureRun {
  id: string;
  source: string;
  contractSource: string;
  contractSha256: string;
  rulePackProvenance: RulePackProvenance[];
  total: number;
  passed: number;
  failed: number;
  validationIssueCount: number;
  cases: ValidationFixtureCaseResult[];
}

const validateShape = new Ajv({ strict: false, allErrors: true, validateFormats: false }).compile(schema);
const evaluatedAt = "2000-01-01T00:00:00.000Z";

function hash(text: string): string { return createHash("sha256").update(text, "utf8").digest("hex"); }
function sorted(values: string[]): string[] { return [...values].sort((a, b) => a.localeCompare(b)); }
function canonical(path: string): string { return process.platform === "win32" ? path.toLowerCase() : path; }
function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function fixtureIO(root?: string): SuiteIO {
  return {
    async read(location) {
      const actual = await realpath(resolve(location));
      if (root && !contained(root, actual)) throw new Error(`Fixture dependency escapes the configured workspace: ${location}.`);
      return readFile(actual, "utf8");
    },
    resolve(containing, reference) {
      validateLocalRef(reference);
      const target = resolve(dirname(containing), reference);
      if (root && !contained(root, target)) throw new Error(`Fixture dependency escapes the configured workspace: ${reference}.`);
      return target;
    },
    async canonical(location) {
      const actual = await realpath(resolve(location));
      if (root && !contained(root, actual)) throw new Error(`Fixture dependency escapes the configured workspace: ${location}.`);
      return canonical(actual);
    }
  };
}

export function parseValidationFixtures(text: string): ValidationFixtureDocument {
  const document = parseDocument(text, { uniqueKeys: true });
  if (document.errors.length) throw new Error(`Invalid fixture YAML: ${document.errors.map(error => error.message).join("; ")}`);
  visit(document, (_, node) => {
    if (isAlias(node) || (node && typeof node === "object" && "anchor" in node && node.anchor)) {
      throw new Error("Validation fixtures do not allow YAML anchors or aliases.");
    }
  });
  const value = document.toJS() as unknown;
  if (!validateShape(value)) throw new Error(`Invalid validation fixtures: ${JSON.stringify(validateShape.errors)}`);
  const fixtures = value as unknown as ValidationFixtureDocument;
  const ids = new Set<string>();
  for (const item of fixtures.cases) {
    if (ids.has(item.id)) throw new Error(`Duplicate fixture case id ${item.id}.`);
    ids.add(item.id);
    if (Object.keys(item.expect).length < 2) throw new Error(`Fixture ${item.id} must assert more than valid/invalid status.`);
  }
  if ("ref" in fixtures.contract) validateLocalRef(fixtures.contract.ref);
  return fixtures;
}

function compareFields<T extends object>(label: string, expected: T[], actual: T[], failures: string[]): void {
  for (const wanted of expected) {
    const found = actual.find(item => (item as { id?: string }).id === (wanted as { id?: string }).id);
    if (!found) { failures.push(`${label} ${(wanted as { id?: string }).id} was not reported.`); continue; }
    for (const [key, value] of Object.entries(wanted)) {
      if (key !== "id" && (found as Record<string, unknown>)[key] !== value) {
        failures.push(`${label} ${(wanted as { id?: string }).id}.${key}: expected ${value}, found ${(found as Record<string, unknown>)[key]}.`);
      }
    }
  }
}

function evaluateCase(item: ValidationFixtureCase, contract: CsvContract): ValidationFixtureCaseResult {
  const result = validateCsv(contract, item.csv, undefined, evaluatedAt);
  const failures: string[] = [];
  for (const field of ["valid", "rowCount", "issueCount", "errorCount", "warningCount"] as const) {
    const expected = item.expect[field];
    if (expected !== undefined && result[field] !== expected) failures.push(`${field}: expected ${expected}, found ${result[field]}.`);
  }
  if (item.expect.issueCodes && JSON.stringify(sorted(item.expect.issueCodes)) !== JSON.stringify(sorted(result.issues.map(issue => issue.code)))) {
    failures.push(`issueCodes: expected [${sorted(item.expect.issueCodes).join(", ")}], found [${sorted(result.issues.map(issue => issue.code)).join(", ")}].`);
  }
  if (item.expect.issueRuleIds && JSON.stringify(sorted(item.expect.issueRuleIds)) !== JSON.stringify(sorted(result.issues.flatMap(issue => issue.testId ? [issue.testId] : [])))) {
    failures.push(`issueRuleIds: expected [${sorted(item.expect.issueRuleIds).join(", ")}], found [${sorted(result.issues.flatMap(issue => issue.testId ? [issue.testId] : [])).join(", ")}].`);
  }
  compareFields("rule", item.expect.ruleOutcomes ?? [], result.ruleOutcomes ?? [], failures);
  compareFields("group", item.expect.groupOutcomes ?? [], result.groupOutcomes ?? [], failures);
  return { id: item.id, passed: failures.length === 0, failures, result };
}

export async function runValidationFixtures(source: string, workspaceRoot?: string): Promise<ValidationFixtureRun> {
  const fixtureSource = await realpath(resolve(source));
  const root = workspaceRoot ? await realpath(resolve(workspaceRoot)) : undefined;
  if (root && !contained(root, fixtureSource)) throw new Error(`Fixture path escapes the configured workspace: ${source}.`);
  const fixtures = parseValidationFixtures(await readFile(fixtureSource, "utf8"));
  let contract: CsvContract;
  let contractSource: string;
  let contractSha256: string;
  let contractDefinitionSource: string;
  if ("inline" in fixtures.contract) {
    const contractText = stringify(fixtures.contract.inline);
    contract = parseContract(contractText);
    contractSource = `${canonical(fixtureSource)}#inline`;
    contractDefinitionSource = fixtureSource;
    contractSha256 = hash(contractText);
  } else {
    const binding = fixtures.contract;
    const contractPath = await realpath(resolve(dirname(fixtureSource), binding.ref));
    if (root && !contained(root, contractPath)) throw new Error(`Fixture contract reference escapes the configured workspace: ${binding.ref}.`);
    const contractText = await readFile(contractPath, "utf8");
    contractSha256 = hash(contractText);
    if (contractSha256 !== binding.sha256.toLowerCase()) {
      throw new Error(`Pinned fixture contract hash mismatch: expected ${binding.sha256.toLowerCase()}, found ${contractSha256}.`);
    }
    contract = parseContract(contractText);
    contractSource = canonical(contractPath);
    contractDefinitionSource = contractPath;
  }
  const io = fixtureIO(root);
  const packs = await resolveContractRulePacks(contract, contractDefinitionSource, io);
  contract = await resolveGroupContracts(packs.contract, contractDefinitionSource, io);
  const cases = fixtures.cases.map(item => evaluateCase(item, contract));
  return {
    id: fixtures.id,
    source: canonical(fixtureSource),
    contractSource,
    contractSha256,
    rulePackProvenance: packs.provenance,
    total: cases.length,
    passed: cases.filter(item => item.passed).length,
    failed: cases.filter(item => !item.passed).length,
    validationIssueCount: cases.reduce((count, item) => count + item.result.issueCount, 0),
    cases
  };
}

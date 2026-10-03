import type { EvidenceValue, FailureEvidence, FailureEvidenceRecord, ValidationIssue, ValidationResult } from "./core/model";

export type EvidenceMaskStrategy = "hash" | "redact" | "partial" | "zero";

/** Export-only policy. It is deliberately free of connection or target settings. */
export interface EvidenceProfile {
  id?: string;
  name?: string;
  include?: string[];
  exclude?: string[];
  mask?: Record<string, EvidenceMaskStrategy>;
}

export interface EvidenceProfilePreview {
  profileId?: string;
  profileName?: string;
  included: string[];
  excluded: string[];
  masked: string[];
  unknown: string[];
  redaction: boolean;
  warning?: string;
}

export interface RedactedValidationResult extends Omit<ValidationResult, "issues"> {
  issues: ValidationIssue[];
}

function hash(value: string, seed: string): string {
  let result = 2166136261;
  for (const character of `${seed}\0${value}`) {
    result ^= character.charCodeAt(0);
    result = Math.imul(result, 16777619);
  }
  return `h${(result >>> 0).toString(16).padStart(8, "0")}`;
}

function masked(value: EvidenceValue, strategy: EvidenceMaskStrategy, seed: string): EvidenceValue {
  if (value === null) return null;
  if (strategy === "zero") return typeof value === "number" ? 0 : typeof value === "boolean" ? false : "";
  if (strategy === "hash") return hash(String(value), seed);
  if (strategy === "partial") {
    const text = String(value);
    return text.length <= 2 ? "*".repeat(text.length) : `${text.slice(0, 1)}${"*".repeat(Math.min(8, text.length - 1))}`;
  }
  return "[REDACTED]";
}

function redactValues(values: Record<string, EvidenceValue>, profile: EvidenceProfile, seed: string): Record<string, EvidenceValue> {
  const preview = policy(profile, Object.keys(values));
  return Object.fromEntries(preview.included.map(column => {
    const strategy = profile.mask?.[column];
    return [column, strategy ? masked(values[column], strategy, seed) : values[column]];
  }));
}

function policy(profile: EvidenceProfile | undefined, columns: string[]): EvidenceProfilePreview {
  // An omitted include list preserves the legacy full-row behavior. An
  // explicitly supplied list, including an empty one, is an allowlist.
  const include = profile?.include === undefined ? undefined : new Set(profile.include);
  const exclude = new Set(profile?.exclude ?? []);
  const masks = new Set(Object.keys(profile?.mask ?? {}));
  const configured = new Set([...(profile?.include ?? []), ...(profile?.exclude ?? []), ...masks]);
  const unknown = [...configured].filter(column => !columns.includes(column));
  const included = columns.filter(column => (!include || include.has(column)) && !exclude.has(column));
  const excluded = columns.filter(column => !included.includes(column));
  const maskedColumns = included.filter(column => masks.has(column));
  const redaction = excluded.length > 0 || maskedColumns.length > 0;
  return {
    profileId: profile?.id,
    profileName: profile?.name,
    included,
    excluded,
    masked: maskedColumns,
    unknown,
    redaction,
    ...(unknown.length ? { warning: `Profile references unknown columns: ${unknown.join(", ")}. They were ignored.` } : {})
  };
}

export function previewEvidenceProfile(profile: EvidenceProfile | undefined, columns: string[]): EvidenceProfilePreview {
  return policy(profile, columns);
}

/** Whether a profile changes any of the supplied evidence columns. */
export function evidenceProfileRedacts(profile: EvidenceProfile | undefined, columns: string[]): boolean {
  return policy(profile, columns).redaction;
}

export function redactEvidenceRecord(record: FailureEvidenceRecord, profile: EvidenceProfile | undefined, seed = "default"): FailureEvidenceRecord {
  if (!profile) return record;
  // The profile identity is the package-level salt: the same identifier must
  // produce the same masked value in primary, related, and aggregate evidence.
  return { ...record, values: redactValues(record.values, profile, profile.id ?? profile.name ?? "profile") };
}

export function redactFailureEvidence(evidence: FailureEvidence | undefined, profile: EvidenceProfile | undefined, seed = "default"): FailureEvidence | undefined {
  if (!evidence || !profile) return evidence;
  return {
    ...evidence,
    samples: evidence.samples.map((sample, index) => ({
      primary: sample.primary && redactEvidenceRecord(sample.primary, profile, `${seed}:primary:${index}`),
      related: sample.related?.map((record, relatedIndex) => redactEvidenceRecord(record, profile, `${seed}:related:${index}:${relatedIndex}`))
    })),
    aggregate: evidence.aggregate === undefined ? undefined : redactEvidenceRecord({ values: evidence.aggregate }, profile, `${seed}:aggregate`).values
  };
}

export function redactValidationResult(result: ValidationResult | undefined, profile: EvidenceProfile | undefined, seed = "default"): RedactedValidationResult | undefined {
  if (!result || !profile) return result;
  return { ...result, issues: result.issues.map((issue, index) => {
    const issueColumns = [...Object.keys(issue.group ?? {}), ...(issue.column ? [issue.column] : [])];
    const issuePolicy = policy(profile, issueColumns);
    const group = issue.group && Object.fromEntries(Object.entries(issue.group)
      .filter(([column]) => issuePolicy.included.includes(column))
      .map(([column, value]) => {
        const strategy = profile.mask?.[column];
        return [column, strategy ? String(masked(value, strategy, profile.id ?? profile.name ?? "profile")) : value];
      }));
    const actualIncluded = !issue.column || issuePolicy.included.includes(issue.column);
    const actualStrategy = issue.column ? profile.mask?.[issue.column] : undefined;
    const redactIssueValue = (value: string | number | undefined): string | number | undefined => {
      if (value === undefined || !issue.column || !actualIncluded) return actualIncluded ? value : undefined;
      return actualStrategy ? (masked(value, actualStrategy, profile.id ?? profile.name ?? "profile") as string | number) : value;
    };
    return {
      ...issue,
      group,
      evidence: redactFailureEvidence(issue.evidence, profile, `${seed}:issue:${index}`),
      actual: redactIssueValue(issue.actual),
      expected: redactIssueValue(issue.expected)
    };
  }), examples: result.examples?.map((example, index) => ({
    ...example,
    values: redactValues(example.values, profile, profile.id ?? profile.name ?? "profile") as Record<string, string>
  })) };
}

export function profileHasCredentials(profile: EvidenceProfile | undefined): boolean {
  if (!profile) return false;
  return Object.keys(profile).some(key => /pass(word)?|secret|token|credential|connection|string/i.test(key));
}

# Saved validation runs

Validation review packages are self-contained, redacted records of a run. They can be archived, parsed later, and compared without reconnecting to a CSV file, URL, or database.

## Package format

`createValidationReviewPackage` in `src/core/review-package.ts` creates the versioned `incursa.validation-review-package/v1` format. A package retains:

- package and producer identity;
- source and validation-definition fingerprints;
- a stable `workId`, target, and scope for each run;
- aggregate row and issue counts;
- whether evaluation and retained issue details are complete;
- redacted findings and, when explicitly enabled, bounded redacted evidence.

`parseValidationReviewPackage(text)` validates the package version before use. Unknown versions are rejected. Legacy `incursa.csv-contract-results/v1` exports can be upgraded, but they do not contain validation-definition fingerprints and therefore normally cannot support a conclusive new/resolved comparison.

Definition fingerprints are change identifiers, not cryptographic signatures. A package proves what it contains; it does not attest the source system or rerun a source query.

## Comparing packages

Use `compareValidationReviewPackages(before, after)` from `src/core/review-diff.ts`. The comparison returns:

- `newFailures`: a stable rule identity has failures only in the later run;
- `resolvedFailures`: a stable rule identity has failures only in the earlier run;
- `persistentFailures`: the same rule still has failures, including full before/after finding-event counts and the event-count delta;
- `indeterminate`: the evidence cannot safely establish a change.

A failure identity is the exact combination of `workId`, target, and `ruleId` (`ValidationIssue.testId`). Issue ordering and row numbers do not affect identity. Repeated findings for one rule are grouped and reported as counts, so a decrease from two findings to one is persistent improvement, not a resolution.

Classification is allowed only when all of these match or are complete:

1. Both packages include the same validation-definition source/fingerprint set.
2. Each matched target is bound to the same non-empty set of effective definition fingerprints. This prevents a global definition set from hiding definitions swapped between work items.
3. The exact `workId` and target identify one run in each package.
4. Both runs include the same non-empty scope identity.
5. Both evaluations are complete rather than sampled, canceled, skipped, errored, or unknown.
6. Every counted issue detail is retained and the result is not truncated.
7. Every finding has a stable rule ID, and a rule ID does not describe conflicting finding shapes within one run.

If any condition fails, the affected comparison is `indeterminate`. In particular, a later package that omits retained evidence is never interpreted as a pass or a resolution. A target that disappears or changes is not treated as resolved. A newly appearing target is not treated as a new failure until it can be matched to the earlier run.

## Counts and bounded detail

The package stores total issue counts separately from retained issue details. The diff names these `beforeFindingEvents` and `afterFindingEvents`: they count saved issue objects, not necessarily impacted source records. In particular, an aggregate SQL check can represent many affected rows with one finding event. Comparison uses the counts only after verifying that `totalIssues`, `retainedIssues`, `result.issueCount`, and the retained issue array agree. Bounded row samples inside a finding are descriptive evidence only; they are never used as proof that unretained failures disappeared.

The diff copies only descriptive fields already present in the redacted packages. It does not fetch source data, expand samples, or include raw source rows that were not saved in the package.

## Human HTML report

`renderReviewDiffHtml(comparison)` in `src/review-diff-report.ts` turns the in-memory comparison into a standalone human-readable HTML document. The renderer performs no source queries, adds no JavaScript, loads no external resources, applies a restrictive content-security policy, and HTML-escapes every value supplied by the packages. The report repeats the finding-event count boundary and presents indeterminate evidence separately so it cannot look like a pass.

## CLI Excel export

Create a self-contained Excel report directly from a saved review package:

```text
csv-contract export --source review.json --out review.xlsx
```

The command parses the versioned review package strictly and never reconnects to its original CSV, URL, or database. The default export applies aggregate-only redaction even if the saved package contains retained row evidence.

To include the package's already-retained, redacted detail, opt in explicitly:

```text
csv-contract export --source review.json --out review-with-detail.xlsx --include-details
```

Detail export cannot recover findings or rows that were truncated, sampled, excluded, or never saved. Credential-like fields and inline secrets are scrubbed again during export.

The destination must be a different path from the source (including an existing filesystem alias) and must use the `.xlsx` extension. Existing output is protected by default; pass `--force` only when replacement is intentional. The workbook is streamed to a temporary sibling. Without `--force`, an atomic create-if-absent link publishes it without overwriting a file created during serialization; with `--force`, a final rename replaces the destination. An interrupted write does not expose a partial workbook.

## Example

```ts
import { parseValidationReviewPackage } from "./core/review-package";
import { compareValidationReviewPackages } from "./core/review-diff";
import { renderReviewDiffHtml } from "./review-diff-report";

const before = parseValidationReviewPackage(beforeJson);
const after = parseValidationReviewPackage(afterJson);
const comparison = compareValidationReviewPackages(before, after);
const html = renderReviewDiffHtml(comparison);

if (comparison.indeterminate.length) {
  // Display the reasons; do not infer a pass or resolution.
}
```

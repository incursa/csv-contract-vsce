# Validation review packages

A validation review package is a portable, versioned snapshot for human review,
saved-run comparison, and downstream report generation. Its schema identifier is
`incursa.validation-review-package/v1`.

Create packages with `createValidationReviewPackage`. The required input is a
source reference and one or more `IssueExportRun` values. The package records a
stable source/definition fingerprint, creation identity and time, tool version,
provenance, explicit per-target status, issue retention, evaluation completeness,
diagnostic error and warning totals, and the redacted validation result. Diagnostic
counts are independent of retained detail and evidence redaction.

Each target carries aggregate check-status coverage and definition fingerprints.
One supplied definition binds automatically. With multiple definitions, use
`definitionBindings` keyed by run ID, work ID, or target (in that priority order).
An unbound multi-definition target has an empty fingerprint list, so comparison
must treat compatibility as unknown rather than assuming the package-wide set.

The default evidence policy is `aggregate-only`. It removes primary and related
row samples and retained examples, masks free-text finding values and execution
errors, and only leaves count-like numeric or Boolean aggregate fields visible.
Detailed evidence requires the explicit `detail` profile. Its `include`,
`exclude`, and `mask` patterns apply to primary, related, aggregate, example,
group, value, message, diagnostic, expected/actual, and error content. `*` is a
wildcard. Credential-like values are scrubbed regardless of profile. Redaction
always creates a detached result and never mutates raw run results.

Definition text is omitted by default. `includeDefinitions: true` includes a
credential-scrubbed copy; SHA-256 fingerprints are present either way. A
fingerprint is a deterministic, collision-resistant change identity, not a
signature or proof of authorship.

Only a complete, valid run whose explicit check coverage contains no blocking
failed check and no unknown or not-evaluated check can receive `PASS` and a
`pass` verdict. A failed warning-severity check remains visible in coverage and
warning totals but does not turn an otherwise valid run into `FAIL`; failed
checks with error or omitted severity are blocking. Failed validation is
`FAIL`. A truncated retained issue list is reported as limited
detail and does not by itself change a trustworthy aggregate verdict. Execution errors, cancellation, skipped or
unknown work, and sampled evaluation use `ERROR`, `CANCELED`, `SKIPPED`,
`UNKNOWN`, or `SAMPLED` with `not-assessed`. Consumers must not interpret those
states as passes. Evaluation completeness and retained issue-detail completeness
are separate fields.

`parseValidationReviewPackage` validates v1 review packages and rejects unknown
versions or contradictory target verdicts. It also upgrades existing
`incursa.csv-contract-results/v1` exports through their validated parser using
the safe aggregate-only policy.

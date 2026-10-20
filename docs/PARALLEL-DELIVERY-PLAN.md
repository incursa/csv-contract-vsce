# Validation delivery workstreams

This local implementation builds on the existing version-1 validation definitions
and generic file names. The existing uncommitted work is preserved. No publishing,
database deployment, or ClickUp status change is implied by implementation.

## Integration boundaries

- One shared validation engine serves VS Code, CLI, and the portable runner.
- One versioned, validated review package feeds human reports and saved-run comparisons.
- Shared reports default to aggregate-only evidence. Retained details require an explicit policy.
- Missing, skipped, canceled, sampled, and incomplete results are not silently promoted to passed results.
- Reuse and test fixtures remain declarative; no arbitrary code is executed from definitions.
- Cross-connection checks require explicit opt-in and bounded, read-only source reads.

## Parallel lanes

| Lane | Owned outcome |
| --- | --- |
| Review foundation | Package manifest, provenance, fingerprints, redaction, strict parsing |
| Human reports | Offline HTML and clearer Excel review workbooks |
| Standalone | Portable Windows executable, local UI, CLI, packaging |
| Saved runs | Reopening and conservative run comparisons |
| Check outcomes | Bounded explicit row/check outcomes |
| Suite policy | Effective SQL target policy and non-mutating resolution |
| Authoring | Pinned local reuse, explain, synthetic rule acceptance fixtures |
| Reliability | CSV/SQL cancellation and resource cleanup |
| SQL metadata | Foreign-key and filtered-index schema baselines |
| Cross-connection | Explicit bounded multi-connection checks |
| Policy UI | Workbench policy controls and provenance |
| Result health | Optional importance weighting without changing PASS/FAIL |

## Release gates

1. Type checking, lint, and the full unit suite include all new tests.
2. Browser and Workbench smoke tests retain existing functionality.
3. Synthetic fixtures cover incomplete results, redaction, hostile report text,
   cancellation, target-policy precedence, and changed run definitions.
4. Standalone execution is compared with the shared CLI engine; packaging is
   smoke-tested on this Windows machine. Clean-machine installation and live SQL
   authentication are separate acceptance gates, not implied by unit tests.
5. VSIX and executable artifacts identify their version and validation limits.

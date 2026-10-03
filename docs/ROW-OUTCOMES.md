# Row outcome evidence

`ValidationResult.rowOutcomes` is a bounded, exportable projection of checks evaluated for retained source rows. Each record contains the source row number and a check-id map. The stable states are:

- `pass`: the check was evaluated and passed.
- `fail`: the check was evaluated and failed.
- `not-applicable`: a conditional selector did not apply to this row.
- `not-evaluated`: the check requires a later aggregate/ordered phase or could not be evaluated.
- `unknown`: the outcome cannot be established from retained evidence.

No consumer should infer `pass` from a missing check key. `rowOutcomeSummary` reports the configured retention limit, retained rows, omitted rows, and whether the evidence is complete. Preview/sample validation is explicitly incomplete (`incompleteBecause: sampled`); exceeding the retention limit is explicitly incomplete (`truncated`). Aggregate issue counts and the existing `valid`/`issues` fields remain authoritative for backward compatibility.

CSV and SQL client-side validation use the same model. SQL server-side aggregate checks remain `not-evaluated` for row evidence unless the shared client-side predicate evaluator runs; their aggregate counts and diagnostics are unchanged.

Check identifiers are stable and namespaced: `schema.<column>` covers row-level column constraints (including uniqueness), `identity.<id>` covers composite identity checks, `row.<id>` covers selector-based row tests, `rule.<id>` covers conditional predicates, `group.<id>` covers grouped requirements, and `ordered.<check-id>` covers ordered checks. A grouped or ordered check may be recorded as `not-evaluated` while its aggregate phase is pending, then is updated to `pass` or `fail` for retained rows when that phase completes. Cross-source checks expose aggregate evidence only and therefore report `not-evaluated` row evidence.

# Controlled cross-connection validation

Cross-connection suite checks are an explicit, bounded fallback for checks whose
SQL Server participants cannot be queried through one compatible connection.
They are disabled unless the individual cross-check opts in:

```yaml
crossChecks:
  - id: source-to-target
    kind: foreignKey
    from: source
    to: target
    keys:
      - { from: PersonId, to: PersonId }
    evidence: aggregate
    crossConnection:
      enabled: true
      maxRows: 50000
```

`maxRows` is optional and defaults to 50,000. It must be between 1 and the hard
250,000-row ceiling. A host may enforce a lower ceiling. A source that returns
more than the effective limit, or reports that it applied a lower limit, makes
the cross-check `ERROR`; it never produces a partial `PASS`.

Opt-in also selects the portable evaluator when all targets currently share a
connection. Moving a target to another connection therefore does not silently
change comparison semantics. Portable keys and mapped values are exact,
case-sensitive text after declared normalizers; database collation and padding
rules are not used. SQL NULL is retained as a distinct internal null marker,
while a real empty string follows the contract's configured CSV null values.
Numeric predicates, ordering, and totals use bounded exact-decimal parsing
(maximum 1,024 input characters and exponent magnitude 100).

## Execution model

The runner resolves the columns needed by keys, totals, mappings, predicates,
ordering, and row selections. It issues one read-only, parameterized `SELECT`
per participant and requests `maxRows + 1` rows so overflow can be detected.
Columns unrelated to the cross-check are not selected. Runtime scope values are
required for scoped targets, are passed separately from SQL text, and are
converted with the target's declared SQL type. Projected values cross the
driver as text, and numeric totals/comparisons use exact decimal arithmetic so
large bigint/decimal values are not rounded through JavaScript floating point.
Repeated roles for one member are read once with the union of required columns.

The bounded row collections are then evaluated by the same relationship and
reconciliation engine used for CSV participants. Row evidence remains capped at
100 samples, and `evidence: aggregate` suppresses row samples entirely.

This mode does **not** create a distributed SQL join or transaction. Sources are
read independently and sequentially. The result is therefore a controlled
comparison of separately observed states, not an atomic snapshot. Use a common
batch/load scope when the data requires a stable logical boundary.

## Failure and cancellation behavior

- Mixed CSV and SQL participants are unsupported and produce an error.
- Missing runtime scope values produce an error before that source is queried.
- Connection, query, conversion, and adapter errors propagate as suite errors.
- Cancellation is checked before and after every source read, and the same
  `AbortSignal` is passed to every adapter call.
- A cancellation or over-limit condition discards the comparison; neither can
be reported as `PASS`.

Whole-run guards supplement the per-source row limit: at most 16 unique
participants, 256 projected columns per participant, 500,000 materialized rows,
64 MiB of UTF-8 value data, and 65,536 characters per value. Hosts can lower the row, byte,
and value limits. All scope requirements are validated before the first query.
Evaluation is synchronous after materialization, so an abort cannot interrupt a
single JavaScript instruction; periodic checks plus these hard bounds constrain
that latency.

The SQL adapter streams rows and enforces these read limits before retaining
them. Projected cells are capped server-side at 65,537 characters: the extra
character detects overflow, which is an error rather than silently truncated
validation input.

The host integrates this mode by wrapping its existing `CrossExecutor` with
`withCrossConnectionExecutor`. Existing same-connection SQL checks continue to
use server-side SQL. The source adapter receives the resolved target, minimal
projection, read-only SQL, row limit, optional bound scope value, and abort
signal; it must not silently truncate results.

## Validation boundary

Automated tests use synthetic adapters and invented rows across two connection
profiles. They verify plan opt-in, projections, bounds, scope parameterization,
errors, and cancellation without accessing a live database or protected data.
Live database connectivity, permissions, driver cancellation, and operational
snapshot suitability remain environment acceptance checks.

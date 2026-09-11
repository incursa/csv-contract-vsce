# Validator workflows

This document describes the validator increment following 0.13.2. See the
[roadmap status](VALIDATOR-ROADMAP.md#implementation-status--september-11-2026)
for explicitly outstanding capabilities.

## Shared authoring

Expand a suite member and choose **Open contract** or **Edit inline contract**.
Both use the same Workbench as a standalone contract. Referenced edits go to the
referenced file; inline edits go to the selected member in the suite. Member IDs,
not their positions, determine the destination. A member opened through a suite
retains that suite's effective connection defaults for execution. Edits preserve
untouched YAML nodes and comments where possible. VS Code document undo/redo and
Save apply normally. An outdated visual edit is rejected rather than replacing a
newer document revision.

**Add validation** inserts ordinary contract rules. String literals such as
`"0001"` remain strings. Null treatment can fail, allow or exclude configured null
markers from conditional selection. Normalization remains controlled by `csv`:
`trimValues`, `caseSensitive`, and `nullValues`. The unique-column preset uses the
existing constraint, which ignores configured nulls; population sets
`schema.rowCount.min`. Existing rules remain editable in YAML.

Fixed date predicates are `dateOnOrAfter`, `dateOnOrBefore`, `dateAfter`, and
`dateBefore`. Accept `YYYY-MM-DD` at UTC midnight, or ISO timestamps with explicit
`Z`/offset and seconds. Reject invalid calendar dates, local timestamps, and
locale-dependent parsing. Date predicates and JavaScript regexes use exact SQL
client fallback. Numeric comparisons also accept `otherColumn` when `value` is
absent; invalid or blank numeric operands fail the predicate. Bounds can be
inclusive or exclusive. Relative dates and configurable decimal precision are
not available in this increment.

## Schema baselines

Use **Create schema baseline** and choose CSV, SQL table/view, or a manual column
definition. CSV capture reads the selected file without retaining records in the
baseline. SQL capture is an explicit metadata query and requires the desktop
host. Manual capture accepts a JSON array of column metadata. Review the generated
YAML, choose **Apply baseline**, then save the affected document.

An embedded example:

```yaml
baseline:
  baselineVersion: 1
  revision: 1
  capturedAt: '2026-09-11T00:00:00Z'
  sourceKind: manual
  captureMethod: manual
  policy:
    default: error
    order: exact
    changes:
      added: warning
      observedType: warning
    columns:
      OptionalNote: allowed
  columns:
    - name: EmployeeId
      ordinal: 1
      required: true
      sqlType: nvarchar
      maxLength: 40
      nullable: false
```

Alternatively, move the baseline mapping into a sidecar and use:

```yaml
baseline:
  ref: ./schemas/employees.baseline.yaml
```

Sidecar paths resolve relative to the containing contract, or the suite for an
inline contract. Combine/split rebases paths and reports them as external
dependencies. Use `combine --allow-external` to retain dependencies intentionally;
a bundle containing sidecar references is not claimed to be self-contained.
Missing, invalid or unreadable baselines cause execution errors.

`sourceKind` is `csv`, `sql`, or `manual`; `captureMethod` is `csv-header`,
`sql-metadata`, or `manual`. CSV baselines retain interpretation settings and
`inference: {scope: complete|sample, rows: N}`. `observedType` (`string`, `number`,
`unknown`) and `observedNullable` are observations, not declared types or
nullability. Leading-zero values are conservatively strings. The capture UI
currently reads the complete CSV. It does not offer sampling controls.

SQL metadata includes `sqlType`, `maxLength` (SQL Server metadata bytes, including
`-1` for max), `precision`, `scale`, `nullable`, `identity`, `computed`, and
`primaryKeyOrdinal` (zero for a known non-key column). Missing/null metadata is
unknown. Capture object identity is provenance, not an implicit prohibition on
intentionally sharing a baseline between equivalent targets. Manual baselines
may omit properties that are not expectations and mark columns `required: false`.

Validation compares schema separately from data rules and emits `SCHEMA_DRIFT`
issues with before/after values. Structural and declared-metadata changes default
to errors; inferred changes default to warnings. Column policy overrides change
policy, which overrides the default. `allowed` suppresses the drift issue, not
unrelated contract assertions. `order: ignore` disables ordinal checks. Changes
in physical SQL names are mapped back to canonical contract names in reports.

**Review schema drift** captures current metadata, lists before/after differences,
affected rule IDs and possible rename candidates, and lets you select changes to
accept. A rename is never assumed automatically. Review the new baseline revision
and explicitly apply it; Save persists it. Unknown metadata cannot be accepted as
an expectation. Acceptance detects intervening edits. Validation and reloads never
write baselines.

## Preview and live execution

**Run preview** beside a conditional rule evaluates that draft rule against one
explicitly selected target. It uses the same rule evaluator and SQL compiler as
normal execution. It reports rows examined, selected, passed and failed. Zero
selected rows are labeled explicitly. This increment performs full-scope
evaluation, never a silently sampled run; it retrieves no SQL example records
unless the existing exact fallback requires reading the scope. Coverage diagnostics
and the source picker explain fallback before preview execution.

**Enable live tests** intentionally runs the initial tests and watches valid
definition changes. It is off when an editor opens, is not persisted between
sessions, and never polls database data. The debounce is 500 ms with one in-flight
run per editor. Invalid definitions suppress execution. Newer revisions cancel
publication of old results; executors that cannot abort finish before the newest
queued revision starts. **Cancel execution** cancels pending work and discards
in-flight results; it does not promise immediate driver termination.

**Pause live tests** stops scheduling. The single editor pauses after three
consecutive execution-error reports. Assertions are not retried automatically.
The existing SQL request timeout remains in effect (15 seconds for integrated
connections). **Watch CSV input changes** is separate from definition watching in
the contract editor, off by default, and only schedules work when live tests are
enabled. Watching is currently limited to filesystem events supplied by the VS
Code workspace. HTTP input data and database data are not polled.

Suites watch referenced definitions and baseline dependencies, invalidate changed
members, and rerun affected members. **Run selected members** and **Rerun failed
members** leave omitted members explicitly skipped. A partial run cannot become
overall PASS. Errors, failed assertions, skipped work, cancellation, running and
stale reports remain distinguishable. Last completed results remain visible when
stale. Unsaved valid edits are used for execution.

## Connections, results, templates and history

**Edit connection** uses the shared profile/integrated/inherit form. Suite
**Bulk edit connections** chooses members and an explicit override policy,
shows a YAML diff, and applies the reviewed changes as undoable document edits.
Integrated bulk edits default to encryption enabled and certificate trust disabled.
Credentials remain in Secret Storage or supported environment configuration.

**Test connection / preflight** explicitly reads SQL metadata, exercising driver,
authentication, database access and object visibility, then checks required
columns. Query errors remain errors; empty metadata means missing or inaccessible,
not proven absence. Preflight is not a guarantee of subsequent validation.

The shared failure grid displays retained issues, expected/actual values, rule
IDs and truncation. **Jump to rule** opens the owning YAML location. Search works
over retained diagnostics; it cannot search discarded examples. Filtering suite
members limits the suite export to visible members and records its scope. Normal
exports retain the original aggregate counts and do not query the source again.

**Run history** offers save, compare and delete. It is explicit local workspace
storage of the newest 20 aggregate snapshots, with a definition fingerprint and
timestamps. It retains no examples, credentials or rule literal values. Changed
definitions are flagged when comparing; missing/unexecuted work is not considered
newly passing. Retention is fixed in this increment.

**Insert rule template** reads reviewed YAML/JSON, prompts for parameters and
previews ordinary inserted rules. Existing rules are never linked to later
template changes. IDs must remain unique. Example:

```yaml
templateVersion: 1
name: Required identifier
parameters: [column, ruleId]
rules:
  - id: '${ruleId}'
    expect: {column: '${column}', operator: notNull}
```

Coverage diagnostics flag empty data-validation coverage, missing targets,
undeclared predicate columns, identical rules, simple contradictory unconditional
literal checks, unscoped SQL and client fallback. They are conservative diagnostics,
not proof that a contract captures all business requirements.

## Cross-table checks

Suites can declare aggregate checks with explicit participating member IDs:

```yaml
crossChecks:
  - id: department-exists
    kind: foreignKey
    from: employees
    to: departments
    keys: [{from: DepartmentId, to: Id}]
    nulls: ignore
    severity: error
  - id: matching-population
    kind: equalPopulation
    from: employees
    to: archive
```

Each participating member must resolve to exactly one unscoped SQL object on the
same connection/database. Foreign-key equality uses SQL's native typed equality
and collation; `nulls: ignore` excludes rows with any SQL-null source key and
`nulls: fail` fails them. CSV normalization markers do not redefine native SQL
NULL for these relational checks. Canonical key names use each target's column map.
Equal population compares `COUNT_BIG` totals. Queries are read-only aggregates
and retrieve no employee/example records. Scoped and cross-connection comparisons
are explicitly rejected. Selective/live changes to either participant invalidate
the cross-check. The Workbench, CLI dbtest and SQL generation share the same plan.

## Compatibility and verification

### Execution policy and current boundaries

SQL requests default to a 15-second timeout. Set `CSV_CONTRACT_SQL_TIMEOUT_MS`
in the extension/CLI process environment to an integer from 1 to 600000 to change
it; restart the extension host to replace existing pools. Opening files still
does not connect. `CSV_CONTRACT_SQL_RETRIES` defaults to 0; explicitly setting 1
or 2 retries only timeout/socket/reset query errors with short backoff. Assertion
results and permission/SQL errors are never retried. Cancellation invokes the
driver's request cancellation and discards stale completions. Pool acquisition
and synchronous CSV evaluation cannot be interrupted mid-operation; subsequent
work waits rather than overlapping. No database data polling is implemented.

**Run history → Set retention limit** accepts 0–1000 snapshots per contract/suite,
default 20. Zero disables new snapshots. The current history is pruned immediately;
other histories are pruned on their next save. Delete removes the selected
contract/suite history immediately. Histories contain aggregate summaries, never
source examples or credentials.

Existing nested conditional predicates can be edited through **Edit rule-id**:
change columns/operators/literals or switch existing groups between all/any, then
**Apply rule changes** and save normally. Adding/removing nested branches remains
a YAML operation. Legacy SQL-only conditional rules retain their restricted schema;
the host rejects unsupported operators rather than changing their scope.

Row tests and grouped rules have explicit preview buttons. Their aggregate result
is displayed without fabricated per-row pass counts. Previews cover the complete
configured scope, never a silently sampled subset. Date instants accept up to
seven fractional digits but compare at JavaScript millisecond precision. SQL native
dates use a separate ISO projection in client fallback, preserving existing raw
literal comparisons. No source examples are added to aggregate SQL reports.

For matching totals, use `kind: equalTotal`, `valueColumns: {from: Amount, to: Amount}`
and optional quoted `tolerance: "0.01"`. Totals use decimal(28,10), with at most 18
integer digits; overflow is an execution error. SQL NULL values are ignored unless
`nulls: fail`; blank/non-numeric values fail the check. This is an aggregate check
with one failed assertion on mismatch/invalid input, not a count of bad rows.

Incomplete roadmap items and their implementation barriers:

- Relative dates and richer typed/precision/uniqueness policies need a versioned
  evaluation-context and policy representation shared by streaming, SQL compilation
  and stored reports. This release offers fixed ISO bounds and existing literal/null
  semantics only; it does not simulate dynamic dates by freezing an authoring time.
- Sampled previews and bounded passing/failing SQL examples need a separate projection
  and selection plan that preserves complete aggregate counts and row locators.
  The existing exact fallback reads the scope, so it is explicitly disclosed rather
  than presented as a bounded example query.
- Per-issue selection/export, richer baseline impact classification and additional SQL
  key kinds are incomplete. Current exports offer retained filtered issues in single
  editors and selected member scope in suites; JSON records scope/staleness and keeps
  original aggregate totals. CSV carries diagnostics but not all JSON run metadata.
- Cross-table scopes need per-participant parameter binding and reproducible scope
  identity. Scoped and cross-connection checks are rejected; complete same-connection
  objects are supported. Linked templates remain the roadmap's future design option.

These are missing implementation work, not features claimed to be complete or
limitations requiring remote database access. Remote database verification remains
separately unperformed because it requires the owner's approval.

Contracts remain `version: 1` and suites `suiteVersion: 1`. Existing literal values,
member independence, rule ordering and validation semantics are retained. Parsing
now validates the documented schema before executing valid drafts; unsupported
fields should use `metadata` for non-executable annotations. New formats require
this extension increment; older extensions do not understand them.

SQL numeric predicates now turn failed/blank conversions into definite failed
predicates rather than letting SQL UNKNOWN disappear under NOT. This corrects
invalid-data handling without changing existing reviewed literal expectations.

Development uses synthetic CSVs and fake execution callbacks. McKee acceptance
compares all 23 unchanged definitions, 1,303 generated rules and combine/split
semantics offline. It is not remote database verification. Real host tests use
the actual VS Code web extension host; rendered tests use Playwright with CSP and
save screenshots outside the repository. Release checks remain
`npm run release:check`; publication uses the existing `v*` tag workflow.

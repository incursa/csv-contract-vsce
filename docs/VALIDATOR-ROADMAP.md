# Validator extension roadmap

Discussion draft · September 10, 2026

## Implementation status — September 11, 2026

SQL lifecycle follow-up (0.15.2): desktop operations await owned connection closure before completion, including failed/canceled work. Windows integrated operations additionally await isolated worker exit to release native ODBC pools. Driver cleanup errors remain errors. No explicit transactions are opened; implicit transactions are disabled. See the verification and workflow documents for tests and limitations.

The roadmap remains the specification. Work is being delivered in tested increments;
this table distinguishes implemented code from outstanding acceptance work.

| Area | Current increment | Still outstanding |
| --- | --- | --- |
| Shared editors | Shared standalone/referenced/inline editor; lossless YAML edits; nested branch add/remove/wrap/reorder; selector editing; shared results, connection and preflight controls | None for current editor scope |
| Baselines | Versioned CSV/SQL/manual baselines; severity policies; before/after selective acceptance; SQL-target overrides; dependency rebasing; collation/unique-key membership and conservative impact labels | CSV targets share a contract baseline; foreign-key and filtered-index definitions are not captured |
| Presets | Null, typed constant/list, relative/fixed ISO dates, numeric precision/ranges, patterns, conditional requirements, comparisons, composite uniqueness/null policies, population | SQL typed/date/precision policies use disclosed exact fallback |
| Previews | Explicit selected CSV/SQL source; sample or complete scope; real selected/pass/fail counts; bounded passing/failing conditional examples; aggregate row/group results; distinct SAMPLED status | Samples are first/unordered rows, not statistical; complete SQL previews may read the scope into memory |
| Live execution | Explicit enable/pause/cancel; initial execution; valid edits/reloads; serial debounce; dependency watchers; stale suppression; affected reruns; bounded SQL timeout/retry | In-flight pool acquisition and synchronous CSV work cannot be interrupted; later runs wait |
| Connections/results | Shared/bulk connection editing; provenance; preflight; searchable failures; rule navigation; selected issue exports with run metadata; progress and selected reruns | Search covers retained details only |
| History/templates/cross-table | Stable-rule aggregate history comparisons; configurable retention; parameterized ordinary-rule templates; independently scoped same-connection relational checks; coverage diagnostics | Linked templates remain optional future work; cross-connection checks are unsupported |

Verified locally for 0.15.0: 108 passing regression tests (one opt-in acceptance test
skipped by default), separately passing 23-contract McKee offline acceptance
(1,303 SQL rules, no translation warnings), rendered desktop/narrow Workbench
interactions and an actual VS Code host run. `npm run release:check` passed,
including 25 PowerShell checks, branding and production VSIX packaging.
Version 0.15.0 was published by [release run 34644555030](https://github.com/incursa/csv-contract-vsce/actions/runs/34644555030) from commit `81011a244f1f13854515c456cd9d73f3e1b1ae96`. An independent public Marketplace query confirmed 0.15.0 as the newest version.
[Verification details](VALIDATOR-VERIFICATION.md) describe the evidence.
No remote database was contacted. McKee acceptance used a temporary copy of the
23 contract definitions and synthetic blank records; it did not read employee data
or add CSV targets. The original fixture was not modified.

Consequential format/default decisions and workflows are documented in
[Validator workflows](VALIDATOR-WORKFLOWS.md), including the concrete implementation
barriers for unfinished items. Outstanding entries above are not
implemented substitutes or claims of roadmap completion.

This document records the requested improvements and related proposals for CSV
Contract Workbench. It is a product backlog, not a description of shipped features
or a commitment to a release date. Version 0.13.2 already provides compound suites,
suite connection editing, structured execution diagnostics, and CSV/JSON result
export; the items below build on that foundation.

## Direction and priorities

Make authoring, running, and troubleshooting validations consistent across single
contracts and suites. Support both CSV and SQL sources while preserving their
differences. A SQL-only suite must remain SQL-only.

The McKee HCM suite of 23 heterogeneous SQL Server tables is the practical workflow
to design against. Its contracts must retain independent schemas and rules.

User-emphasized priorities:

1. Schema drift detection with baselines captured from CSV or SQL, or authored manually.
2. Common validation presets that are easy to add and configure.
3. A consistent single-contract and suite editing experience.
4. Rule previews that can execute against a live connection and show successes and failures.
5. Opt-in live testing after rule edits, saves, and external file reloads.

Additional agreed discussion areas include connection management, preflight checks,
failure navigation, selective reruns, history, reusable templates, cross-table
checks, and coverage diagnostics.

## 1. Common validation presets

Provide an **Add validation** picker in both editors, followed by a small form and
a plain-English description of the resulting rule.

Initial catalog:

| Preset | Configuration and behavior |
| --- | --- |
| Never null | Distinguish null, empty string, and whitespace using the contract's normalization settings. |
| Always a constant | Choose the expected literal, its type, case sensitivity, and treatment of nulls. Preserve values such as `"0001"`. |
| Allowed / prohibited values | Maintain a typed list, with explicit null handling. |
| Date range | Fixed or relative bounds, inclusive/exclusive endpoints, date parsing, and time-zone policy. |
| Number range | Minimum/maximum, boundary inclusion, precision, and invalid-number behavior. |
| Unique value or combination | One or more columns, with an explicit policy for nulls and duplicates. |
| Text length or pattern | Minimum/maximum length, prefix/suffix, or regex; show when SQL requires client fallback. |
| Required when | For example, completion date is required when status is Complete. |
| Compare columns | For example, start date must be on or before end date. |
| Population / row count | Expected total count, selected-row count, or minimum population. |

Presets should create ordinary editable contract rules, reusing existing semantics
where possible. They must not introduce an opaque second rule format. Unsupported
semantics require an explicit format extension and engine support before the UI
offers them. Relative dates need a recorded evaluation time for reproducible runs.

Acceptance: a user can add “never null,” “always this constant,” and “within this
date range” without editing YAML, then inspect and modify the generated rule.

## 2. Consistent single-contract and suite editors

Use shared components for connections, schema, rule forms, previews, results,
exports, progress, empty states, and errors. Keep labels and keyboard behavior
consistent. A suite adds member navigation around the same contract editor.

- Edit inline suite contracts visually, with the same capabilities as standalone contracts.
- Show whether a member is referenced or inline and where edits will be saved.
- Preserve rule IDs, ordering, comments where feasible, and unrelated YAML content.
- Support normal undo/redo and clear dirty/saved indicators.
- Show a reviewable YAML diff for bulk changes or generated content.
- Use the same failure detail and connection controls everywhere.

Acceptance: the same contract offers equivalent editing and execution controls
standalone, referenced by a suite, and embedded inline. Moving between those forms
must not alter validation semantics.

## 3. Live rule preview

Preview is more than generated SQL: it must be able to run the draft rule against
a selected live SQL connection and show actual success/failure results. CSV sources
should offer equivalent evaluation against the selected file.

Suggested flow:

1. Select a preset or edit a rule.
2. Review its plain-English meaning, selected source, effective connection, and scope.
3. Choose **Run preview**; optionally enable automatic preview for subsequent edits.
4. Show rows examined, rows selected by the condition, passes, failures, and errors.
5. Inspect bounded passing/failing examples and the generated query or execution plan description.
6. Save the rule, revise it, or discard the draft.

Use the same compiler, normalization, and evaluator as a normal run. Explain
conditional rules that matched zero rows rather than displaying an unexplained
green result. For group/count rules, show the relevant aggregate instead of
inventing per-row pass/fail results.

Display whether evaluation covered the entire scope or a sample. A sample preview
must not be presented as a full-table validation. Limit example-row retrieval
separately from aggregate evaluation; do not fetch a complete table just to preview
a few failures. Show client-side fallback and its likely cost before execution.

Preview results belong to a particular draft revision, source, scope, and run time.
Editing any of these marks the preview stale. Preview execution is read-only and
must not write data or deploy SQL. Credentials stay outside contracts and baselines.

Acceptance: a rule with known passing and failing synthetic records displays both
correctly, and produces the same verdict as the saved rule evaluated over the same
data and scope. Connection failures appear as execution errors, not failed assertions.

## 4. Schema baselines and drift detection

Schema drift is a major priority. Provide **Create schema baseline** with three
entry points: snapshot a CSV, snapshot a SQL table/view, or define a baseline manually.

### Capturing a baseline

| Source | Baseline content |
| --- | --- |
| CSV | Header names and order, duplicate headers, delimiter/header settings, encoding when known, and optional observed type/nullability information. |
| SQL table/view | Schema/object identity; column names and order; SQL types, length, precision, scale, and nullability; identity/computed flags and available key metadata. |
| Manual | Expected columns, types, nullability, order policy, required/optional status, and explicitly permitted variations. |

CSV has no authoritative declared types. Separate observed or inferred properties
from user-approved expectations. Record whether inference used a sample or the
complete file, and keep ambiguous values such as identifiers with leading zeros
as strings until the user chooses otherwise. Unsupported or unavailable SQL
metadata should be marked unknown, not silently treated as absent.

Store baselines as reviewable, versioned text artifacts or embedded metadata with
an explicit format version. Record source kind, capture method, timestamp, and
relevant interpretation settings. Do not embed credentials or source data rows.
Resolve baseline file references relative to the containing contract or suite;
combine/split must preserve their meaning and report portability dependencies.

### Comparing and reviewing drift

- Detect added, removed, renamed candidates, reordered, and duplicated columns.
- Detect SQL type, length, precision, scale, nullability, and supported key changes.
- Respect target-specific column mappings and show physical and canonical names.
- Compare CSV inferred type changes separately from structural header changes.
- Flag possible renames for review; do not automatically equate a removal and addition.
- Let the user classify changes as allowed, warning, or failure at an appropriate scope.
- Report schema drift separately from data-rule failures and metadata-access errors.
- Show a before/after diff, affected rules, and the likely impact of each change.
- Offer **Accept selected changes as new baseline**, with a preview and explicit save.
- Never silently update the baseline during a run or after an external file reload.

Each heterogeneous suite member can have its own baseline. Equivalent targets can
share one intentionally. A baseline defines expected structure; it complements
validation rules rather than replacing them.

Acceptance: tests cover added/removed columns, SQL type narrowing, nullability
changes, CSV header changes, inferred-type ambiguity, manual baselines, and selective
acceptance. A failed metadata query must never produce “no drift.”

## 5. Live tests after changes

Provide an explicit **Live tests** toggle per editor or suite, with a clear active
indicator, pause control, and selected execution scope. Enabling it can run the
initial tests and then rerun relevant checks after changes.

- Observe visual rule edits, YAML edits, saves, external reloads, referenced member changes, and baseline changes.
- Distinguish watching test definitions from watching CSV input data; make input watching a separate option.
- In the initial design, SQL live mode reruns on configuration/test changes. Polling for database data changes is a separate future option.
- Debounce rapid edits and wait for valid syntax; show parse diagnostics while a draft is incomplete.
- Coalesce duplicate save/reload events and avoid loops caused by generated reports or the extension's own saves.
- Prevent overlapping runs; cancel superseded work when supported or queue only the newest revision.
- Rerun affected members and their declared dependencies rather than all 23 tables unnecessarily.
- Invalidate affected results when defaults, connections, shared definitions, or column mappings change.
- Preserve the last completed report but label it stale, with the revision and timestamp it represents.
- Bound concurrency and query time, reuse suitable connection pools, and pause clearly on repeated connection errors.
- Keep assertion failure, execution error, skipped, canceled, stale, and running states distinct.

Use unsaved valid editor content consistently for preview/live runs, and identify
that revision in results. Changes during execution must never attach an old verdict
to the newly edited rule. Enabling database live tests is an intentional user action;
opening a file alone does not start database queries.

Acceptance: bursts of edits produce one final rerun, an external reload updates the
correct member, invalid intermediate YAML does not execute, and an older slow run
cannot overwrite newer results. Verify event behavior in a real VS Code host.

## 6. Connection management and preflight

Extend the current connection controls into a single connection overview:

- Show each member/table's effective connection and whether it comes from a suite default, contract, or table override.
- Apply a connection to selected members with a diff and clear override behavior.
- Support named profiles, Windows integrated settings, and inheritance consistently.
- Keep credentials in Secret Storage or supported external runtime configuration.
- Provide **Test connection** and optional preflight: local driver availability, authentication, database access, object visibility, and required columns.
- Give actionable diagnostics without equating a failed metadata query with a missing table.

Preflight complements execution; a successful preflight cannot guarantee that a
later query will succeed or that data will remain unchanged.

## 7. Failure grid, navigation, and exports

Replace long result lists with a shared, searchable grid where appropriate.

- Filter by suite, member, table, rule, status, and severity.
- Show expected/actual values or aggregates, affected counts, and configured row locators.
- Preserve stable rule IDs and provide **Jump to rule** from each failure.
- Support copying diagnostics and exporting selected/filtered failures or the full report.
- Include execution errors, skipped/canceled reasons, evaluation scope, and run identity in exports.
- State when details are truncated and distinguish total failures from retained examples.
- Keep example-row retrieval and export explicit; aggregate summaries should not require exporting source data.

Acceptance: a user can navigate from an exported rule ID back to the rule, and a
filtered export contains exactly the selected scope with its limitations recorded.

## 8. Execution controls and run history

- Show current member/table, completed versus expected work, elapsed time, and per-member durations.
- Provide cancellation, timeouts, run selected members, and rerun failed members.
- Retry transient execution errors under an explicit policy; do not retry assertions as though they were connectivity failures.
- Save optional local report snapshots with contract revision, baseline revision, scope, connection identity, and evaluation time.
- Compare newly failing, resolved, and unchanged checks using stable identities.
- Label partial reruns and avoid treating unexecuted members as newly passed.
- Compare runs cautiously when schema, rule definitions, scope, or target changed; show those differences alongside verdict changes.
- Provide retention controls and deletion for saved report details.

## 9. Reusable templates and cross-table validations

Templates can package common rule groups with named parameters, such as an audit
column set or a standard employee identifier policy. Start with inserting normal
rules; consider linked templates later with explicit versioning, update previews,
and per-contract parameters. Never silently change existing rules when a template changes.

Cross-table checks can cover orphan records, foreign-key relationships, matching
totals, and expected populations. Declare participating members and dependencies
explicitly so selective and live runs know what to invalidate. Define null handling,
key mappings, comparison scope, and connection boundaries. Start with compatible
SQL targets on the same connection; cross-connection comparisons need a separate
design for execution cost and data movement.

## 10. Coverage and rule troubleshooting

- Highlight members with no substantive validations or missing targets.
- Distinguish zero matching rows from a meaningful pass under the chosen rule semantics.
- Explain selectors, normalization, null treatment, and canonical-to-physical mappings.
- Identify rules blocked by missing columns or unsupported execution capabilities.
- Warn about client fallback, expensive unscoped queries, and truncated evidence.
- Detect duplicate or contradictory rules where this can be established reliably.

## Suggested delivery sequence

| Phase | Outcome |
| --- | --- |
| 1 | Shared editor components, stable rule navigation, unified results, and connection overview/preflight. |
| 2 | Schema baseline format, CSV/SQL/manual capture, and drift review. Treat this as a priority workstream alongside the editor foundation. |
| 3 | Common preset forms and executable live rule preview, using the shared evaluator. |
| 4 | Live test scheduling, external reload handling, cancellation, and selective reruns. |
| 5 | History comparisons, reusable templates, and explicitly scoped cross-table checks. |

Ship useful slices within each phase rather than delaying all capabilities until
the entire roadmap is complete. Preserve standalone contracts and both suite
representations throughout.

## Verification and decisions to settle during design

Use local synthetic CSV/SQL fixtures and a fake executor for scheduling tests.
Cover round trips, connection precedence, heterogeneous schemas, invalid drafts,
external file changes, result staleness, cancellation, and export completeness.
Exercise shared forms and live workflows in rendered UI and the real VS Code host.

Use the 23 McKee contracts for offline semantic acceptance. Actual remote database
preview or schema capture requires approval; the roadmap itself authorizes no
connection, data export, deployment, stored procedure change, or staging reload.

Decisions to resolve with concrete designs:

- Baseline storage: sidecar files, embedded definitions, or both with lossless conversion.
- Initial date formats, relative-date expressions, and evaluation time-zone behavior.
- Live-test debounce, concurrency, timeout defaults, and whether enabled state persists between sessions.
- Full-scope versus sampled preview defaults, especially for large tables and client fallback.
- Initial drift severity policies and which SQL metadata properties are required versus optional.
- Report-history retention and whether example values are retained by default.

## Related current documentation

- [Contract format](CSV-CONTRACT-FORMAT.md)
- [Compound suites](COMPOUND-SUITES.md)
- [SQL Server validation](SQL-SERVER-STAGING-VALIDATION.md)

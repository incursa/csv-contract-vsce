# Changelog

## 0.14.0

- Share the visual contract editor across standalone, referenced and inline suite members, preserving YAML nodes and supporting nested predicate edits.
- Add versioned CSV, SQL and manual schema baselines, sidecar dependencies, severity policies, drift review and explicit selective acceptance.
- Add validation presets, ISO date comparisons and executable full-scope conditional, row and group previews with real rule outcomes.
- Add opt-in debounced live tests, dependency watching, cancellation, stale-result protection, selected reruns and incomplete-work statuses.
- Add connection provenance, reviewed bulk editing, shared metadata preflight, searchable result grids, rule navigation, local history retention, parameterized templates and coverage diagnostics.
- Add same-connection foreign-key, population and decimal-total cross-table checks, plus bounded SQL timeouts and opt-in transient retries.
- Preserve SQL-only McKee combine/split semantics through offline acceptance; add mocked SQL, scheduler, rendered CSP and actual VS Code host regression tests. No remote database verification was performed.
- Document the remaining roadmap work explicitly, including relative/typed preset semantics, preview examples/sampling, per-issue export selection and scoped cross-table checks.

## 0.13.2

- Preserve structured SQL/ODBC execution error messages and diagnostic fields instead of displaying `[object Object]`.
- Add suite default and per-member/table connection editing, plus access to secret-backed profile configuration.
- Add CSV error export and JSON suite result export, including execution errors, member/table/rule identity and truncation indicators. Expand assertion details by default.
- Cover structured errors, connection scope preservation and the new Workbench actions with regression tests.

## 0.13.1

- Fixed suite files opening as plain YAML: registered both suite suffixes with the default Workbench editor and removed the text-editor redirect.
- Added a Suite Workbench with searchable members, schema/rule inspection, execution results, SQL generation, and referenced/inline editing links. Opening a suite never executes tests.
- Added rendered-control tests and real VS Code web-host checks for automatic suite editor selection.

## 0.13.0

- Added referenced and portable inline compound suites with independent member schemas, rules and SQL targets.
- Added lossless-semantic combine/split tooling, dependency reporting, safe output handling and explicit connection precedence.
- Added suite execution reports, collect-all/fail-fast behavior and complete isolated SQL batch generation.
- Integrated suites into YAML validation, Workspace Tests, Run Contract and existing reports.
- Treat missing SQL rule summaries as execution errors. Verified 23 local McKee contracts offline (1,303 equivalent generated checks); no database connection.

## 0.12.0

- Added self-contained Windows integrated authentication through the native `msnodesqlv8` driver.
- Added non-secret `integratedConnection` contract targets containing only the server, database, and ODBC connection options, so users can run database contracts without configuring a named profile.
- Preserved secret-backed connection profiles for SQL Server logins and custom connection strings.

## 0.11.0

- Added a Workbench **Add table or view** flow that browses objects from secret-backed SQL Server connection profiles and saves the selected target in contract YAML.
- Added table- and view-specific column mappings so canonical contract column names can validate differently named SQL Server columns without changing CSV behavior or report labels.
- Added conservative mapping suggestions for exact, case-insensitive, and standardized names such as `CustomerId` and `customer_id`, with unmatched and ambiguous names called out for review.
- Added SQL Server view discovery and validation while keeping database access read-only and preserving multiple connections and targets per contract.

## 0.10.0

- Added direct, read-only SQL Server table validation with the same `ValidationResult` and workspace report used for CSV targets.
- Added secret-backed VS Code connection profiles and environment-backed CLI profiles so credentials never need to appear in contract YAML.
- Added multiple SQL Server table and connection targets per contract.
- Added server-side translation for shared conditional rules, row counts, row tests, grouped completeness, and the existing column and uniqueness rules.
- Added exact client-side fallback for JavaScript regex semantics while keeping all database access read-only.
- Added the `dbtest` CLI command with repeated contracts, scoped parameter binding, JSON output, and CI-friendly exit codes.

## 0.9.0

- Added generic conditional CSV rules with nested predicates, cross-column checks, string matching, numeric comparisons, and error/warning severity.
- Added exact declared header ordering for fixed-layout receiving systems.
- Added cross-row group completeness rules with exact required values or required name fragments.
- Kept group validation order-independent and bounded-memory by spilling normalized group observations to hash-partitioned temporary files and reducing them after EOF.
- Added error and warning counts across CLI, Workbench, workspace reports, and JSON results.

## 0.8.0

- Added offline SQL Server table-schema import with a preview and explicit confirmation before contract changes.
- Added support for ordinary `CREATE TABLE` scripts, Database Tracking canonical `*.structure.json` models, and compact Database Knowledge snapshots.
- Added non-destructive merge behavior that preserves reviewed descriptions, allowed values, regexes, identities, conditional rules, scope, and manually chosen constraint values.
- Added imported SQL type, nullability, length, precision, scale, identity, computed-column, ordinal, table, and schema metadata to the YAML contract.
- Added safe creation of a new contract or update of an existing one from the Command Palette, visual Workbench, and bundled CLI.
- Kept identity and computed columns optional for CSV validation and avoided inferring a CSV identity from a generated identity primary key.

## 0.7.0

- Added deterministic, read-only SQL Server staging validation generation from reviewed CSV contracts.
- Translated null, length, allowed-value, uniqueness, and composite-identity constraints into failure counts and bounded diagnostic rows.
- Added SQL-only conditional rules for finite value sets, null and blank checks, column comparisons, and nested `all`/`any` logic.
- Added an optional required load/batch scope parameter without persisting the parameter value in the contract.
- Added Command Palette, visual Workbench, and bundled CLI entry points plus a documented staging contract example.
- Added strict SQL identifier/literal quoting, an allowlist for scope parameter types, and explicit warnings for non-equivalent regex and CSV row-test semantics.
- Fixed the release PowerShell harness so later web tests and VSIX packaging cannot be skipped, and verified it under Windows PowerShell 5.1 and PowerShell 7.

## 0.6.0

- Added canonical pure-TypeScript full-row multiset and explicit keyed semantic comparison.
- Added duplicate-key detection without arbitrary pairing, schema summaries, and added, removed, changed, unchanged, and duplicate counts.
- Added opt-in ignored columns, trimming, invariant case folding, blank/null equivalence, date normalization, and exact decimal normalization without business-key inference.
- Added bounded redacted diagnostics plus deterministic JSON, CSV, Markdown, schema, difference, and normalized evidence files.
- Added a responsive aggregate comparison result view and native VS Code normalized diff action.
- Added browser-host comparison through `vscode.workspace.fs` with explicit 20 MiB and 250,000-row portable limits.
- Added a separate Node desktop entry with exact 128-partition spill-to-disk comparison for large local files.
- Added PowerShell parity fixtures, spill tests, and a real headless VS Code web-extension-host workflow test.

## 0.5.0

- Added a dedicated workspace test report that opens automatically after selected contracts finish.
- Added aggregate contract, target, run, pass, failure, and duration metrics for the complete batch.
- Added expandable per-run results with rows, columns, test counts, durations, and full diagnostics.
- Changed successful and failed run nodes in the Activity Bar to open their result in the report instead of reopening the YAML Workbench.
- Made the **Last run** tree node reopen the complete report while contract nodes continue to open the editor.

## 0.4.1

- Added an immediate spinner and disabled state to the Workbench **Run tests** button.
- Added live per-target progress so long-running validations show which CSV is currently being tested.
- Ensured the running indicator clears after successful runs, validation errors, and missing-target warnings.

## 0.4.0

- Added **Open in VS Code** and **Open externally** actions for every configured CSV target in the Workbench.
- Added expandable target nodes with the same actions to the Workspace Tests Activity Bar view.
- Opened local files with the registered desktop application and remote URLs in the browser when using the external action.
- Opened URL targets as read-only CSV documents inside VS Code without requiring a local download.
- Moved the latest test results directly below the summary metrics so failures remain visible above long column lists.
- Improved responsive wrapping for target controls, results, and row/cell test editing at narrower editor widths.

## 0.3.0

- Added a native CSV Contract Activity Bar view that discovers contract files across every workspace folder.
- Added persistent checkboxes for selecting several contracts and a **Run Selected** workspace action.
- Grouped selected contracts by resolved target so shared CSV files are loaded once per workspace run.
- Added consolidated pass/fail reporting in the tree and CSV Contract output channel, including expandable diagnostics.
- Reported invalid contracts, missing configured targets, inaccessible files, and failed URL downloads alongside validation failures.
- Added installed-extension PowerShell usage to the end of the Marketplace README.

## 0.2.1

- Preserved an absolute Windows target path when a generated contract and its source CSV are on different drives.

## 0.2.0

- Added optional contract-level CSV targets using relative or absolute file paths and HTTP/HTTPS URLs.
- Added Workbench controls for saving multiple file paths or URLs, temporarily overriding them, and reviewing per-target results.
- Added automatic multi-file execution to the Command Palette, Node CLI, and PowerShell wrapper.
- Grouped contracts that reference the same CSV so compatible validations still share a streaming pass.
- Downloaded remote CSV targets incrementally to isolated temporary disk for bounded-memory batch validation.
- Updated contract generation to save the source CSV as a portable relative target.
- Added separate desktop and browser extension bundles so normal remote URLs are not constrained by browser CORS in VS Code desktop.

## 0.1.5

- Renamed the Workbench CSV picker to **Select test CSV** to make clear that selecting a validation target does not replace the existing contract or its tests.
- Updated the Marketplace instructions and screenshots to match the clearer workflow.

## 0.1.4

- Replaced low-contrast presence badges with readable required and optional labels.
- Added a bounded, sticky-header column scroller that preserves position for contracts with hundreds of columns.
- Kept the column inspector top aligned beside large column lists.
- Added complete visual editing for row selectors, match counts, and exact cell expectations.
- Added browser coverage for a 202-column contract, row/cell editing, and responsive overflow.

## 0.1.3

- Refined and enlarged the table-and-check mark for cleaner balance and stronger small-size legibility.
- Added deliberate negative space between the CSV grid and validation check across Marketplace, banner, wordmark, monochrome, and compact assets.
- Documented the approved refinement in the CSV Contract Figma design file and verified it at 256, 64, 32, and 16 pixels.

## 0.1.2

- Reworked the Marketplace overview around end-user workflows and validation capabilities.
- Added current workbench screenshots for column-rule authoring and validation-result review.
- Removed repository build, test, publishing, benchmark, and one-off batch details from the Marketplace README.

## 0.1.1

- Added the CSV table-and-check product mark in Marketplace, wordmark, README banner, monochrome, and compact icon variants.
- Added deterministic brand-asset rendering and verification scripts.
- Added separate Incursa brand asset and trademark terms.

## 0.1.0

- Added the visual CSV Contract Workbench custom editor.
- Added YAML JSON Schema IntelliSense.
- Added shared column, row, and cell validation.
- Added a single-pass streaming Node CLI and PowerShell validator with multiple-contract support, bounded diagnostics, progress reporting, and exact disk-backed uniqueness.
- Added a PowerShell contract-outline generator with safe overwrite handling and optional sample-bounded constraint inference.
- Added comprehensive positive and negative CSV fixtures, PowerShell 7 and Windows PowerShell 5.1 coverage, and large-file performance tooling.
- Added an AI-agent contract-authoring guide and reusable prompt.
- Added browser smoke tests, VSIX packaging, CI, and release automation.

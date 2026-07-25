# Semantic CSV comparison

CSV Contract Workbench includes a canonical TypeScript comparison engine derived from the established behavior of `Compare-CsvSemantic.ps1`. The engine itself has no Node or VS Code dependency and is used by the browser extension entry point.

## Modes

- **Full-row multiset** compares normalized rows independent of source order while preserving occurrence counts. One removed copy of a duplicate row is a difference.
- **Keyed** uses one or more explicit key columns. Records are compared cell by cell only when the key occurs exactly once on both sides. Every duplicate-key group is reported and no arbitrary row pairing occurs.

Business keys, dates, and decimals are never inferred. Leading zeroes and other raw string identifiers are preserved. Trimming, invariant case folding, blank/null equivalence, date normalization, decimal normalization, and ignored columns are individually opt-in.

Run **CSV Contract: Compare CSV Files Semantically** and choose the left and right CSVs. The aggregate result view shows added, removed, changed, unchanged, schema, and duplicate counts without exposing cell values. **Open normalized diff** opens deterministic normalized CSVs in the native VS Code diff editor. **Save JSON, CSV, and Markdown evidence** writes the canonical summary, redacted aggregate evidence, detailed local CSV review files, schema evidence, and normalized diff inputs.

Detailed CSV evidence can contain normalized key, context, and changed values. Save it only to an appropriate local workspace. The JSON summary, Markdown report, and result UI contain bounded aggregate diagnostics and do not include cell values.

## Portable and desktop limits

The web extension reads through `vscode.workspace.fs` and runs the complete comparison in the browser extension host. Portable comparisons are limited to 20 MiB and 250,000 data rows per input. These limits bound memory use in vscode.dev and remote web hosts.

VS Code desktop uses the same in-memory engine for normal-sized files. Larger local files are streamed into 128 deterministic temporary partitions. Counts and uniqueness checks remain exact while each partition is evaluated independently. Temporary partitions are removed after comparison. A large spill comparison returns complete aggregate evidence, bounds detailed review rows to the configured diagnostic limit, and intentionally omits complete normalized diff copies; use smaller extracts when complete detailed CSV evidence or an interactive line diff is required.

The browser bundle is built from `src/extension.ts`. The desktop bundle is built from `src/node/extension.ts`; only that entry imports Node streaming and temporary-file modules. The release gate scans both bundles through build and web-host execution.

## Evidence schema

`ComparisonSummary.json` uses `incursa.csv-semantic-comparison/v1`. It is deterministic for the same inputs and options and contains:

- mode, status, exit code, and semantic equality;
- all explicit comparison options;
- left, right, shared, ignored, and reordered schema facts;
- left and right row, distinct-row, duplicate-row, unique-key, and duplicate-key counts;
- added, removed, changed, unchanged, schema-change, duplicate, and per-column changed-cell counts;
- bounded redacted diagnostics with opaque key references.

`ComparisonEvidence.csv` and `ComparisonSummary.md` contain aggregate review evidence. Mode-specific CSVs follow the established PowerShell naming where applicable: `LeftOnly.csv`, `RightOnly.csv`, `KeysOnlyInLeft.csv`, `KeysOnlyInRight.csv`, `ChangedRows.csv`, `DuplicateKeysLeft.csv`, `DuplicateKeysRight.csv`, `ColumnChangeSummary.csv`, and `ColumnSummary.csv`.

## Parity and boundaries

`test/fixtures/semantic/manifest.json` records order, duplicate, keyed, normalization, schema, and error expectations. `npm test` runs them against the TypeScript engine. In the Incursa sibling-repository workspace, `pwsh -File scripts/Test-SemanticParity.ps1` also executes the fixtures through `powershell-tools/Tools/Compare-CsvSemantic.ps1`.

The SQL exporter remains separate from semantic comparison. The existing PowerShell Excel workbook is not bundled or invoked by the portable extension; Excel presentation is a remaining desktop enhancement, while JSON and CSV remain the authoritative evidence formats.

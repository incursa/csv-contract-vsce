# CSV contract format

Contracts use YAML and normally end in `.csvtest.yaml`. The bundled JSON Schema provides completion, hover help, enum suggestions, and structural validation in VS Code. Keep this modeline on the first line when contracts may be edited outside the extension:

```yaml
# yaml-language-server: $schema=../schemas/csvtest.schema.json
```

## Complete shape

```yaml
version: 1
targets:
  - path: ../exports/employees-east.csv
  - path: ../exports/employees-west.csv
  - url: https://example.com/exports/employees.csv
csv:
  delimiter: ","
  encoding: utf-8
  quote: '"'
  header: required
  nullValues: [""]
  trimValues: false
  caseSensitive: true
  allowBlankRows: false
  allowRaggedRows: false

identity:
  columns: [Company, EmployeeId]
  unique: true

schema:
  allowAdditionalColumns: true
  rowCount: { min: 1, max: 50000 }
  columnCount: { exact: 5 }
  columns:
    EmployeeId:
      presence: required
      constraints:
        notNull: true
        unique: true
        maxLength: 12
        matches: '^\d+$'
    OptionalComment:
      presence: optional
      constraints:
        maxLength: 250

rowTests:
  - id: expected-employee-exists
    name: Expected employee exists
    select:
      Company: "01"
      EmployeeId: "000123"
    expect:
      count: { exact: 1 }
      cells:
        Status:
          equals: Active
```

## Test targets

`targets` is optional. When present, **Run tests**, the Command Palette runner, the Node CLI, and the PowerShell wrapper validate every listed target without prompting for a CSV.

- `path` accepts a relative or absolute file path. Relative paths resolve from the `*.csvtest.yaml` file, not the current shell directory.
- `url` accepts an HTTP or HTTPS URL that returns CSV content.
- Paths and URLs can be mixed in one contract.
- **Select test CSV** remains a temporary Workbench override and does not modify `targets`.
- Explicit CLI `--csv` or PowerShell `-Csv` values override configured targets.
- Do not commit credentials or secret-bearing URLs. Use explicit runtime targets when authentication data should remain outside the contract.

The Workbench reads each target into memory one at a time. VS Code desktop can retrieve normal HTTP/HTTPS URLs; browser-hosted editors require the remote server to permit cross-origin access. For very large local or remote CSVs, use the PowerShell or Node runner. It streams local files and downloads URLs to temporary disk before running the bounded-memory validator.

## Comparison rules

- CSV cell values remain strings. `"000123"` is not converted to `123`.
- `trimValues` defaults to `false`.
- `caseSensitive` defaults to `true` and applies to selectors, exact cell values, null markers, allowed values, and uniqueness.
- Configured `nullValues` default to `[""]`.
- Length constraints count JavaScript string characters after optional trimming.
- Uniqueness ignores configured null values; use `notNull` when nulls must also fail.

## Column behavior

| Contract condition | Behavior |
| --- | --- |
| Required declared column is absent | Failure |
| Optional declared column is absent | Its column constraints are skipped |
| Optional declared column is present | Its constraints run normally |
| Undeclared extra column and `allowAdditionalColumns: true` | Accepted but not validated |
| Undeclared extra column and `allowAdditionalColumns: false` | Failure |
| Row selector references an undeclared column | Contract failure |
| Row selector references a declared optional column that is absent | Assertion failure, not a zero-match result |
| Cell assertion references a declared optional column that is absent | Assertion failure |

This means a test may target an optional column, but that test only applies to CSV files where the column actually exists.

## Identity and row selectors

`identity` is optional. It expresses a workbook-wide composite uniqueness rule and is not required for row tests. Row tests always use explicit `select` column/value pairs, so a contract can intentionally assert zero, one, or many matches even when the file has duplicate business keys.

If `expect.count` is omitted, the engine expects exactly one matching row.

## Count expectations

`rowCount`, `columnCount`, and row-test `count` accept:

```yaml
exact: 1
min: 1
max: 10
```

The fields may be combined. Each violated bound produces a separate diagnostic.

## Regex and allowed values

Regex patterns use JavaScript regular-expression syntax. They are applied to each non-null cell in the column. Invalid patterns are reported as contract diagnostics instead of crashing the run.

`allowedValues` is an exact string allow-list, subject to `trimValues` and `caseSensitive`.

## Multiple contracts

Use a broad schema contract for every file of one type and a second contract for date- or customer-specific spot checks. The CLI and PowerShell wrapper accept multiple contracts for the same CSV and return failure if any contract fails.

Contracts that reference the same target are grouped automatically. Contracts with the same physical CSV settings (`delimiter`, `quote`, and `allowBlankRows`) share one streaming pass through that file. A different physical setting requires another pass. The result includes `performance.passes`, so automated runs can detect an accidental extra scan.

## Bounded diagnostics

The streaming CLI and PowerShell wrapper report at most 1,000 issue records by default while continuing to count every failure. Use `--max-issues` or `-MaxIssues` to change that bound. The result distinguishes:

- `issues`: the retained issue records
- `issueCount`: the total number of detected issues
- `truncated`: whether additional issue records were omitted

This keeps a badly malformed multi-million-row file from exhausting memory just to describe repeated failures. See [PowerShell and large-file operation](POWERSHELL-AND-PERFORMANCE.md) for batch commands, progress, exact disk-backed uniqueness, and performance guidance.

## Deliberately deferred

Version 1 does not include cross-column expressions, foreign keys, typed numeric/date comparison, arbitrary query expressions, severities, JUnit, or SARIF. These can be added later without weakening the exact-string core.

![CSV Contract Workbench](images/csv-contract-readme-banner.png)

# CSV Contract Workbench

Define reusable YAML contracts for CSV files, edit them visually in VS Code, and run the same validations interactively or in unattended workflows.

## Build contracts visually

Create a contract from a CSV to start with its real column names, then set presence and data-quality rules from the workbench. Save one or more local paths or HTTP/HTTPS URLs as test targets when the same contract should run without prompting. Each configured target can be opened in VS Code or with its registered external application; URL targets open in a read-only VS Code document or in the browser. The YAML file remains the source of truth and can always be edited directly with schema-aware IntelliSense.

![Configure column rules in CSV Contract Workbench](images/workbench-column-rules.png)

*Configure required and optional columns, null handling, uniqueness, lengths, allowed values, and regular expressions.*

## See failures in context

Run a contract against a CSV and follow live per-target progress while large files are being checked. Review file, column, row, and cell failures directly below the run summary, before the column and row-test editors.

![Review CSV validation results in CSV Contract Workbench](images/workbench-results.png)

*Inspect the selected column and the latest validation result in one workspace.*

## Run workspace test suites

Open **CSV Contract** in the Activity Bar to see every `*.csvtest.yaml` and `*.csvtest.yml` file in the workspace. Expand a contract to inspect and open its local or URL targets. Check the contracts you want and select **Run Selected**. A dedicated report opens with totals for the complete test run and expandable results for every contract-target pair. Select **Last run** to reopen the aggregate report, or select an individual green or red run to open the report focused on that result. Contracts that share a target reuse the same loaded CSV, and the selection remains checked for the workspace.

## Compare CSV files semantically

Run **CSV Contract: Compare CSV Files Semantically** for an order-independent full-row multiset comparison or an explicit keyed comparison. Duplicate keys are surfaced without pairing ambiguous records. Trimming, case folding, blank/null equivalence, date and decimal normalization, ignored columns, keys, and context columns are all opt-in.

The aggregate result view keeps diagnostics redacted and bounded. Open complete normal-sized normalized results in the native VS Code diff editor, or save deterministic JSON, CSV, and Markdown evidence locally. The pure TypeScript engine runs in a real VS Code web host through `vscode.workspace.fs`; desktop automatically switches large local files to exact spill-to-disk comparison. See [Semantic CSV comparison](docs/SEMANTIC-COMPARISON.md) for limits, evidence files, and privacy guidance.

## What you can validate

- Expected and optional columns, with control over undeclared extras
- Row and column counts
- Null values, uniqueness, minimum and maximum lengths
- Allowed values and regular-expression matches
- Composite identities across multiple columns
- Required or forbidden rows selected by exact values
- Exact cell values for selected rows
- Raw string values such as identifiers with leading zeroes

## Generate SQL Server staging validation

Use the same reviewed contract to generate a read-only T-SQL validation script for a staging table. Add a `sqlServer` target with optional `conditionalRules`, then run **CSV Contract: Generate SQL Server Staging Validation** from the Command Palette or select **Generate staging SQL** in the workbench. The generator creates a rule summary plus bounded failing-row samples; it never connects to SQL Server or executes the script.

```yaml
sqlServer:
  schema: staging
  table: PayrollImport
  rowLocator: [LoadId, SourceRow]
  detailLimit: 100
  scope:
    column: LoadId
    parameter: LoadId
    sqlType: nvarchar(100)

  conditionalRules:
    - id: completed-requires-date
      name: Completed rows have a completion date
      when:
        column: Status
        operator: equals
        value: Complete
      expect:
        column: CompletionDate
        operator: notNull
    - id: employee-category
      when:
        column: SourceType
        operator: equals
        value: Employee
      expect:
        column: Category
        operator: equals
        value: Labor
```

The optional scope emits a required SQL variable initialized to `NULL`; set it before running the script so each check is limited to one load or batch. Supported predicates are exact equality/inequality, value lists, null/blank checks, column-to-column equality, and nested `all`/`any` groups. Column constraints translate to null, length, allowed-value, uniqueness, and composite-identity checks. JavaScript regular expressions and CSV `rowTests` are identified in comments as translation warnings because SQL Server has no exact equivalent for their current semantics.

The bundled CLI supports unattended generation without a database connection:

```powershell
node .\dist\cli\csv-contract.cjs sql `
  --spec .\payroll.csvtest.yaml `
  --out .\payroll.validation.sql
```

See [SQL Server staging validation](docs/SQL-SERVER-STAGING-VALIDATION.md) for the complete predicate reference and load-scoping behavior.

## Import a known staging schema

Run **CSV Contract: Import SQL Server Table Schema** or select **Import table schema** in the Workbench. Choose an offline `CREATE TABLE` script, a Database Tracking `*.structure.json` table model, or a compact Database Knowledge snapshot. If the source contains several tables, select the one you want before the preview.

The preview reports added and existing columns, contract-only columns that will remain in place, inferred technical constraints, preserved conflicts, table identity changes, and primary-key identity initialization. Nothing is written until **Import Schema** is confirmed. Existing descriptions, allowed values, regexes, conditional rules, load scope, detail limit, identities, and manually reviewed constraint values are preserved.

Imported SQL type, nullability, length, precision, scale, identity, computed-column, and ordinal metadata remains under `sqlServer.importedSchema`. Identity and computed columns are optional in CSV validation because they may be generated after loading.

The bundled CLI supports the same offline merge:

```powershell
node .\dist\cli\csv-contract.cjs schema `
  --source .\staging-table.sql `
  --spec .\payroll.csvtest.yaml `
  --out .\payroll.csvtest.yaml
```

Omit `--spec` to create a new contract. For a multi-table source, add `--table staging.PayrollImport`.

## Get started

1. Install **CSV Contract Workbench** from the VS Code Marketplace.
2. Run **CSV Contract: Create Contract from CSV** from the Command Palette.
3. Review the generated `*.csvtest.yaml` file in the visual workbench or YAML editor.
4. Use the saved target, add more file paths or URLs, or choose temporary targets with **Select test CSV**.
5. Select **Run tests** to validate every active target.

Generated contracts are deliberately conservative: they capture the observed columns and include sample row and cell assertions without guessing business rules. You decide which columns are required, unique, nullable, length-limited, or restricted to known values.

## Reuse the same contract

Contracts are plain YAML files designed to live beside the data workflow they protect. A broad schema contract and focused spot-check contracts can be applied to the same CSV.

The included Node CLI and PowerShell wrapper use a streaming validator for unattended runs. Compatible contracts share one CSV pass, diagnostics remain bounded, and exact uniqueness checks spill to temporary disk instead of retaining the entire CSV in memory.

## Local by design

CSV contents and contracts are processed locally. CSV Contract Workbench does not upload validation data to a hosted service.

## License

The extension code and documentation are licensed under Apache-2.0. CSV Contract Workbench and its product marks are Incursa brand assets and are not granted under that license.

## Run from PowerShell

The installed extension includes the PowerShell wrapper and its bundled validation engine. Node must be available on `PATH`, but no separate tooling download is required.

Locate the currently installed extension and run every target configured in a contract:

```powershell
$extensionRoot = (& code --locate-extension incursa.csv-contract-vsce).Trim()
$testScript = Join-Path $extensionRoot 'scripts\Test-CsvContract.ps1'

& $testScript `
  -Contract 'C:\path\to\customers.csvtest.yaml'
```

Run several contracts together:

```powershell
& $testScript `
  -Contract @(
    'C:\path\to\customers-general.csvtest.yaml',
    'C:\path\to\customers-spot-checks.csvtest.yaml'
  )
```

Configured file paths and URLs are used automatically. Supply `-Csv` only when you want to override them for a particular run.

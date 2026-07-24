![CSV Contract Workbench](images/csv-contract-readme-banner.png)

# CSV Contract Workbench

Define reusable YAML contracts for CSV files, edit them visually in VS Code, and run the same validations interactively or in unattended workflows.

## Build contracts visually

Create a contract from a CSV to start with its real column names, then set presence and data-quality rules from the workbench. Save one or more local paths or HTTP/HTTPS URLs as test targets when the same contract should run without prompting. Each configured target can be opened in VS Code or with its registered external application; URL targets open in a read-only VS Code document or in the browser. The YAML file remains the source of truth and can always be edited directly with schema-aware IntelliSense.

![Configure column rules in CSV Contract Workbench](images/workbench-column-rules.png)

*Configure required and optional columns, null handling, uniqueness, lengths, allowed values, and regular expressions.*

## See failures in context

Run a contract against a CSV and review file, column, row, and cell failures directly below the run summary, before the column and row-test editors.

![Review CSV validation results in CSV Contract Workbench](images/workbench-results.png)

*Inspect the selected column and the latest validation result in one workspace.*

## Run workspace test suites

Open **CSV Contract** in the Activity Bar to see every `*.csvtest.yaml` and `*.csvtest.yml` file in the workspace. Expand a contract to inspect and open its local or URL targets. Check the contracts you want, select **Run Selected**, and review the consolidated pass/fail report. Contracts that share a target reuse the same loaded CSV, and the selection remains checked for the workspace.

## What you can validate

- Expected and optional columns, with control over undeclared extras
- Row and column counts
- Null values, uniqueness, minimum and maximum lengths
- Allowed values and regular-expression matches
- Composite identities across multiple columns
- Required or forbidden rows selected by exact values
- Exact cell values for selected rows
- Raw string values such as identifiers with leading zeroes

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

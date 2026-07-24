![CSV Contract Workbench](images/csv-contract-readme-banner.png)

# CSV Contract Workbench

CSV Contract Workbench is a VS Code extension, Node CLI, and PowerShell wrapper for reusable CSV data-quality contracts. A YAML contract describes the expected file shape, column constraints, row selectors, and exact cell assertions. The same TypeScript engine runs in every surface.

## What it does

- Creates a starter `*.csvtest.yaml` contract from an existing CSV.
- Provides JSON Schema IntelliSense and validation for contract files.
- Opens contracts in a visual editor built with `@incursa/ui-kit`.
- Tests required and optional columns, extra columns, row and column counts, nulls, uniqueness, lengths, allowed values, and regex patterns.
- Selects rows by one or more exact string values and checks match counts or exact cell values.
- Runs one general contract plus any number of spot-check contracts against the same CSV.
- Preserves raw string semantics such as leading zeroes.
- Streams batch validation instead of loading the CSV into memory.
- Uses bounded diagnostics and disk-partitioned exact uniqueness checks for very large files.

## Quick start

```powershell
npm install
npm run test:all
npm run package:vsix
code --install-extension .\csv-contract-vsce.vsix
```

In VS Code:

1. Run **CSV Contract: Create Contract from CSV**.
2. Open the generated `*.csvtest.yaml` file in **CSV Contract Workbench**.
3. Mark columns required or optional and add constraints.
4. Import a CSV and run the contract.
5. Use **Open YAML** whenever direct editing is more convenient.

The complete format and edge-case behavior are documented in [CSV contract format](docs/CSV-CONTRACT-FORMAT.md). Batch usage and large-file guidance are in [PowerShell and performance](docs/POWERSHELL-AND-PERFORMANCE.md).

## CLI

Build once, then run:

```powershell
node .\dist\cli\csv-contract.cjs test `
  --csv .\examples\employees.csv `
  --spec .\examples\employees.csvtest.yaml
```

Multiple `--spec` arguments apply multiple contracts to the same CSV:

```powershell
node .\dist\cli\csv-contract.cjs test `
  --csv .\export\employees.csv `
  --spec .\contracts\employee-general.csvtest.yaml `
  --spec .\contracts\employee-spot-checks.csvtest.yaml `
  --format json
```

Exit codes are `0` for pass, `1` for test failures, and `2` for invalid arguments or runtime errors.

## PowerShell

```powershell
.\scripts\Test-CsvContract.ps1 `
  -Csv .\export\employees.csv `
  -Contract @(
    '.\contracts\employee-general.csvtest.yaml',
    '.\contracts\employee-spot-checks.csvtest.yaml'
  )
```

For a 30-file export, keep the file-to-contract mapping in your own orchestration script and call `Test-CsvContract.ps1` once per CSV. Construction stays visual; batch execution stays scriptable.

Generate a conservative outline from the CSV header:

```powershell
.\scripts\New-CsvContract.ps1 `
  -Csv .\export\employees.csv `
  -Output .\contracts\employees.csvtest.yaml
```

The outline includes every column, file-level counts, a sample row-existence test, and a sample exact-cell test. Data constraints are deliberately not guessed unless `-InferConstraints` is supplied.

Run the complete behavioral suite:

```powershell
npm run test:powershell
```

The suite exercises 24 command-level checks under PowerShell 7 and Windows PowerShell 5.1. It covers valid files, optional columns, quotes and multiline cells, nulls, duplicates, composite identity, lengths, regex, allowed values, required/additional columns, ragged records, row counts, cell mismatches, invalid contracts, multiple contracts, and safe generator behavior.

Run a generated large-file benchmark:

```powershell
npm run benchmark
```

See [PowerShell and performance](docs/POWERSHELL-AND-PERFORMANCE.md) for measured results and scaling guidance.

## AI-assisted contract authoring

[AI agent contract authoring](docs/AI-AGENT-CONTRACT-AUTHORING.md) explains how to turn source files, data dictionaries, specifications, sample CSVs, or business rules into reviewed contracts. A ready-to-paste agent prompt is available at [prompts/author-csv-contract.md](prompts/author-csv-contract.md).

## Design

The approved design source is [CSV Contract Workbench — VS Code](https://www.figma.com/design/342HejE612xMMeL30zAscf). Design renders are retained in `artifacts/design/`.

The product mark, compact icon exports, wordmark, README banner, monochrome asset, colors, and rebuild commands are documented in [Branding](docs/BRANDING.md).

## Publishing

See [Marketplace release runbook](runbooks/marketplace-release.md). `npm run release:check` runs tests, browser smoke validation, and creates the VSIX. Marketplace publishing requires `VSCE_PAT`; no secret is stored in this repository.

## License

Apache-2.0. See [LICENSE](LICENSE).

The extension code and documentation are licensed under Apache-2.0. The CSV Contract Workbench name and the files listed in [`BRAND-ASSET-LICENSE.md`](BRAND-ASSET-LICENSE.md) are separate brand assets governed by that policy and [`TRADEMARKS.md`](TRADEMARKS.md); they are not licensed under Apache-2.0.

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

The complete format and edge-case behavior are documented in [CSV contract format](docs/CSV-CONTRACT-FORMAT.md).

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

## Design

The approved design source is [CSV Contract Workbench — VS Code](https://www.figma.com/design/342HejE612xMMeL30zAscf). Design renders are retained in `artifacts/design/`.

## Publishing

See [Marketplace release runbook](runbooks/marketplace-release.md). `npm run release:check` runs tests, browser smoke validation, and creates the VSIX. Marketplace publishing requires `VSCE_PAT`; no secret is stored in this repository.

## License

Apache-2.0. See [LICENSE](LICENSE).

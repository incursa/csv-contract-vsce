# PowerShell and performance

## Ready-to-run validation

Build the bundled CLI once:

```powershell
npm ci
npm run build:production
```

Run one contract:

```powershell
.\scripts\Test-CsvContract.ps1 `
  -Csv .\exports\employees.csv `
  -Contract .\contracts\employees.csvtest.yaml
```

Run a general contract and a spot-check contract in the same CSV pass:

```powershell
.\scripts\Test-CsvContract.ps1 `
  -Csv .\exports\employees.csv `
  -Contract @(
    '.\contracts\employees-general.csvtest.yaml',
    '.\contracts\employees-spot-checks.csvtest.yaml'
  ) `
  -MaxIssues 1000 `
  -ProgressInterval 250000
```

Use `-Format json` for orchestration. Progress goes to stderr, leaving stdout as valid JSON. Exit codes are:

| Exit | Meaning |
| --- | --- |
| `0` | Every contract passed |
| `1` | At least one contract ran and failed |
| `2` | Arguments, contract parsing, file access, or another runtime operation failed |

## Contract outline generation

```powershell
.\scripts\New-CsvContract.ps1 `
  -Csv .\exports\employees.csv `
  -Output .\contracts\employees.csvtest.yaml
```

The default generator is conservative:

- reads only the header and first data row;
- declares observed columns as required;
- adds `rowCount.min: 1` and the exact column count;
- adds one sample row-existence assertion;
- adds one sample exact-cell assertion;
- does not guess nullability, uniqueness, regex, or business allow-lists.

`-InferConstraints -SampleRows 10000` opt-in inference records observed nullability, uniqueness, and maximum length from the bounded sample. Those values are evidence from a sample, not authoritative business rules, and the generated comments require review.

The generator refuses to overwrite a contract unless `-Force` is supplied.

## Large-file architecture

The PowerShell wrapper invokes the bundled Node CLI, which:

1. reads UTF-8 CSV data in 1 MiB chunks;
2. parses records incrementally, including quoted commas, escaped quotes, CRLF, and multiline quoted cells;
3. keeps only the current record and validation state;
4. evaluates compatible general and spot-check contracts in one pass;
5. stores at most `MaxIssues` diagnostic objects while still counting all failures;
6. handles exact uniqueness by hash-partitioning normalized values into temporary binary files;
7. reads one uniqueness partition at a time to find exact duplicates;
8. removes uniqueness temporary files on success or failure.

The entire CSV and its rows are never retained in memory by the batch validator.

## Measured baseline

The committed `artifacts/performance/latest.json` baseline was produced on the development Windows machine with:

- 500,000 rows;
- 100 columns;
- 396,939,555 CSV bytes;
- five declared columns evaluated while 95 allowed extra columns streamed past;
- exact uniqueness on a 12-character ID;
- regex, null, length, allowed-value, row-selector, and exact-cell checks.

Observed result:

| Metric | Result |
| --- | ---: |
| Duration | 16.928 seconds |
| Throughput | 29,537 rows/second |
| Data rate | 22.36 MiB/second |
| Peak RSS | 341.70 MiB |
| CSV passes | 1 |
| Validation | Pass |

This is a reproducible engineering baseline, not a universal service-level guarantee. Storage speed, average cell width, quoted-field frequency, number of contracts, regex complexity, and uniqueness rules all materially affect throughput.

At the measured average row width, an 18-million-row/100-column file would be roughly 13.3 GiB and would take about 10–12 minutes at the same sustained data rate. Real files may be much wider or slower. The important property is that validation remains streaming and memory does not scale with the full CSV size.

## Uniqueness and temporary disk

Exact uniqueness cannot be proven without retaining or externally sorting comparison keys. This implementation uses bounded-memory disk partitions. Approximate temporary disk for one unique column is:

```text
row count × (normalized key bytes + 14-byte record header)
```

For 18 million 12-byte IDs, that is approximately 446 MiB before filesystem overhead. Each additional unique column or composite identity adds another stream of keys. Use `-TempDirectory` to place this work on a fast disk with sufficient free space.

`-UniquePartitions` defaults to `128`. Increasing it reduces memory used while checking each partition but creates more temporary files; decreasing it does the reverse.

## Operational recommendations

- Put the CSV and uniqueness temporary directory on local SSD storage.
- Keep general and spot-check contracts on the same delimiter/quote settings so they share one pass.
- Keep `-MaxIssues` bounded; the default is `1000`.
- Use anchored regexes and avoid pathological backtracking expressions.
- Declare only meaningful uniqueness rules.
- Use `-ProgressInterval 250000` or larger for multi-million-row files.
- Use JSON output in batch scripts and archive the result with the export.
- Run `Test-PowerShellSuite.ps1` after changing the engine or wrappers.

## Reproduce the benchmark

```powershell
.\scripts\Test-CsvContractPerformance.ps1 `
  -Rows 500000 `
  -Columns 100
```

The generated CSV is removed by default. Add `-KeepCsv` only when the fixture itself is needed for investigation.

# Saved comparison setups

Use **Save comparison…** and **Load comparison…** at the top of Data Comparison.
The `.comparison.json` file stores sources, keys, column mappings, exclusions and
conversion choices. Saving before previews is supported for an unfinished setup.
Results and captures are separate; use **Export results** for evidence.

Loading does not read CSV files or execute SQL. Load each source's sample to apply
the saved mappings, then verify keys and capture current data before comparing.
New columns start excluded. Missing included columns clear the keys and require
mapping review. Existing results and verification are invalidated.

SQL sources retain password-free connection identity, table/schema or SELECT text.
The UI resolves one matching saved server/database using current local connection
settings. Missing or ambiguous matches require an explicit saved-connection choice;
loading never adds connections to the catalog. Files can contain private paths,
server names and query text, but no row data or credentials are serialized.

CSV paths are relative to the setup file when on the same filesystem volume.
Move the setup and CSV files together, or use **Choose CSV** after loading to point
at a different file. Saving again rebases the paths to the new setup location.

## CSV Contract Workbench interoperability

CSV Contract Workbench **0.15.3** adds **Save comparison setup** to comparison results
and **CSV Contract: Load Comparison Setup** to the Command Palette. Loading shows
the resolved paths and requires **Run comparison** before reading the CSV sources.

Both apps use `incursa.data-comparison/v1`. A common fixture is committed and
executed by both test suites, including renamed columns, keys, exclusions, exact
leading zeros, decimal values, dates and trimmed text.

The VS Code saved-setup runner currently supports CSV ↔ CSV with explicit keys and
Exact, Text, Trim text, Decimal, Date, Date/time, Boolean, GUID and Binary conversions.
It preserves blank rows and rejects duplicate converted keys. Its current read
limit is 20 MiB / 250,000 rows per CSV. It conservatively rejects unsupported scalar
spellings instead of inferring a conversion. Decimal input uses a point, no exponent
or grouping, and at most 38 digits. ISO and M/d/yyyy dates preserve seven fractional
second digits. SSMS supports additional sources/conversions and its existing limits.

SQL sources, Auto (SQL type), Time, Date/time offset and Floating point setups must
run in SSMS for now; VS Code gives an explicit unsupported-feature message.
Existing VS Code full-row multiset, context columns, case folding, blank/null,
legacy date/decimal normalization and asymmetric schemas are saved under
`vscodeOptions` and can be reopened in VS Code. SSMS rejects that marker to avoid
silently changing established legacy behavior. Earlier VS Code releases do not
understand reusable setup files. Result evidence JSON is not a setup file.

## Format

```json
{
  "schema": "incursa.data-comparison/v1",
  "name": "Payroll comparison",
  "left": { "kind": "CSV", "path": "before.csv" },
  "right": { "kind": "CSV", "path": "after.csv" },
  "mappings": [
    { "left": "Id", "right": "Id", "key": true, "include": true, "conversion": "Exact" },
    { "left": "Amount", "right": "Total", "key": false, "include": true, "conversion": "Decimal" }
  ]
}
```

Unknown top-level fields/versions fail explicitly. Setup files are limited to 2 MiB
and 256 column mappings. Writes use a temporary file followed by replacement.

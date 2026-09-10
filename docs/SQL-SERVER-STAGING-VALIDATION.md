# SQL Server staging validation

CSV Contract Workbench can apply the same reviewed contract to CSV files and SQL Server tables or views. Direct database runs are read-only and prefer server-side validation: aggregate rule queries execute in SQL Server and return the standard workbench report. Rules containing JavaScript regular expressions use an exact read-only client fallback because SQL Server does not provide identical JavaScript regex semantics. The report includes an `SQL_CLIENT_FALLBACK` warning when this happens; the fallback projects only declared columns, but it must hold the scoped result in extension memory, so avoid regex rules on unscoped very large objects.

## Use Windows integrated authentication without a profile

Windows integrated targets contain no credentials, so server and database names can safely live in the contract. The desktop extension and CLI authenticate as the current Windows user through `msnodesqlv8`:

```yaml
sqlServer:
  integratedConnection:
    server: sqlhost\\instance
    database: Warehouse
    trustServerCertificate: true
  schema: staging
  table: PayrollImport
  objectType: table
```

ODBC Driver 18 for SQL Server is used by default. Set `odbcDriver` to another installed driver name when necessary. `encrypt` defaults to `true`, and `trustServerCertificate` defaults to `false`.

## Configure a secret-backed profile

Use a named profile for a SQL login or custom connection string. Run **CSV Contract: Configure SQL Server Connection**, enter the profile name used by `connection`, and store the connection string in VS Code Secret Storage. In the Workbench, **Add table or view** can use that profile to browse objects. Use a login with `SELECT` access only; the validator issues metadata queries and `SELECT` statements and never generates data-changing SQL.

```yaml
sqlServer:
  connection: warehouse-readonly
  schema: staging
  table: PayrollImport
  objectType: table
  columnMap:
    EmployeeId: employee_id
```

`columnMap` translates canonical contract columns to target-specific physical names. The validator uses the physical identifiers in SQL while CSV validation and report labels retain the canonical contract names. Exact-name matches do not need entries. The add-target preview can suggest case-only and separator differences, but ambiguous and unmatched names remain explicit so they can be reviewed.

For the CLI, profile names map to environment variables. `warehouse-readonly` becomes `CSV_CONTRACT_SQLSERVER_WAREHOUSE_READONLY`:

```powershell
$env:CSV_CONTRACT_SQLSERVER_WAREHOUSE_READONLY = "Server=...;Database=...;User Id=...;Password=...;Encrypt=true"
npm run cli -- dbtest --spec ./examples/sql-server-staging.csvtest.yaml
```

The `dbtest` command supports repeated `--spec` arguments and emits text or JSON. Its exit code is `0` when every contract/table run passes, `1` for validation failures, and `2` for configuration or execution errors.

## Test multiple tables, views, and connections

Use `sqlServer.targets` when the same contract applies to several tables or views. Every target can use either `connection` or `integratedConnection`, plus its own column map and optional display name.

```yaml
sqlServer:
  detailLimit: 100
  rowLocator: [EmployeeId]
  targets:
    - name: integration employees
      connection: integration-readonly
      schema: dbo
      table: Employees
    - name: production employees
      connection: production-readonly
      schema: reporting
      table: EmployeeExport
      objectType: view
      columnMap:
        EmployeeId: employee_id
```

Workspace Tests treats each database object as a target and includes every run in the normal HTML and Output reports.

## Import the table definition first

Use **CSV Contract: Import SQL Server Table Schema** with an offline `CREATE TABLE` script, Database Tracking canonical `*.structure.json` model, or compact Database Knowledge snapshot. The import preview must be confirmed before changes are applied.

New physical columns and safe technical constraints are added. Existing reviewed rules and contract-only columns are preserved, including conflicts where the contract deliberately differs from the imported schema. SQL metadata is stored under `sqlServer.importedSchema`; the source file path and database credentials are not stored. Identity and computed columns are declared optional for CSV validation because SQL Server may generate them after the source file is loaded.

Start with [the staging example](../examples/sql-server-staging.csvtest.yaml), set `sqlServer.schema` and `sqlServer.table`, and declare every referenced staging column under `schema.columns`. `rowLocator` controls which identifying columns appear before `t.*` in each bounded failure sample.

## Limit validation to one load

Use `sqlServer.scope` when a staging table retains more than one load or batch. Generated scripts declare the configured parameter as `NULL` and throw before querying until you set it:

```sql
DECLARE @LoadId nvarchar(100) = NULL; -- REQUIRED: set the load/batch value.
```

For direct execution, set `valueEnvironment` so the value stays outside the contract, or pass `--scope LoadId=value` to `dbtest`. The extension securely prompts for a value when neither is configured. Scope values are bound query parameters, never interpolated into SQL.

```yaml
scope:
  column: LoadId
  parameter: LoadId
  sqlType: nvarchar(100)
  valueEnvironment: PAYROLL_LOAD_ID
```

Supported generated-script types are intentionally restricted to integers, `bit`, `uniqueidentifier`, `date`, `datetime2`, `varchar`, and `nvarchar` so contract text cannot inject arbitrary SQL.

## Conditional predicates

Each `conditionalRules` entry has an optional `when` predicate and a required `expect` predicate. A row fails when `when` is true and `expect` is false. Without `when`, the expectation applies to every in-scope row.

| Operator | Required field | Meaning |
| --- | --- | --- |
| `equals`, `notEquals` | `value` | Compare a column with an exact contract value. |
| `in`, `notIn` | `values` | Compare a column with a reviewed finite set. |
| `isNull`, `notNull` | none | Test SQL `NULL`. |
| `isBlank`, `notBlank` | none | Test an empty or whitespace-only non-null value. |
| `equalsColumn`, `notEqualsColumn` | `otherColumn` | Compare two declared columns. |
| `all`, `any` | nested predicate array | Combine conditions with AND or OR. |

String comparisons honor `csv.caseSensitive` and `csv.trimValues`. The generator bracket-quotes identifiers and emits Unicode SQL literals with embedded apostrophes escaped.

## Generated results

The first result set contains one row per rule with `RuleId`, `RuleName`, `Severity`, and `FailureCount`. A zero count passes. The remaining result sets return at most `detailLimit` failing rows per rule for diagnosis.

Translated rules include row counts, configured null markers, minimum and maximum lengths, allowed values, per-column and composite uniqueness, shared conditional rules, row-test counts and cell expectations, SQL-specific conditional rules, and grouped completeness rules. Generated scripts explicitly warn about JavaScript regular expressions; direct execution preserves their semantics with client fallback.

## Compound suites

Use an ordered `*.csvsuite.yaml` master to reference contracts with different schemas and tables, or combine them into a portable inline bundle. Both forms run through Workspace Tests and the CLI. See [Compound suites](COMPOUND-SUITES.md) for formats, connection precedence, combine/split commands, round-trip guarantees and execution reporting.

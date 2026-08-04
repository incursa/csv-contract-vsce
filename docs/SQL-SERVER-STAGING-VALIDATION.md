# SQL Server staging validation

CSV Contract Workbench can translate reviewed CSV contract constraints and SQL-specific conditional rules into a deterministic, read-only T-SQL script. Generation is offline: the extension and CLI do not connect to SQL Server or execute the generated code.

## Import the table definition first

Use **CSV Contract: Import SQL Server Table Schema** with an offline `CREATE TABLE` script, Database Tracking canonical `*.structure.json` model, or compact Database Knowledge snapshot. The import preview must be confirmed before changes are applied.

New physical columns and safe technical constraints are added. Existing reviewed rules and contract-only columns are preserved, including conflicts where the contract deliberately differs from the imported schema. SQL metadata is stored under `sqlServer.importedSchema`; the source file path and database credentials are not stored. Identity and computed columns are declared optional for CSV validation because SQL Server may generate them after the source file is loaded.

Start with [the staging example](../examples/sql-server-staging.csvtest.yaml), set `sqlServer.schema` and `sqlServer.table`, and declare every referenced staging column under `schema.columns`. `rowLocator` controls which identifying columns appear before `t.*` in each bounded failure sample.

## Limit validation to one load

Use `sqlServer.scope` when a staging table retains more than one load or batch. The generated script declares the configured parameter as `NULL` and throws before querying until you set it:

```sql
DECLARE @LoadId nvarchar(100) = NULL; -- REQUIRED: set the load/batch value.
```

The contract stores the parameter name and SQL type, not a load value. Supported types are intentionally restricted to integers, `bit`, `uniqueidentifier`, `date`, `datetime2`, `varchar`, and `nvarchar` so contract text cannot inject arbitrary SQL.

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

Translated column rules include configured null markers, minimum and maximum lengths, allowed values, per-column uniqueness, and composite identity uniqueness. Regular expressions and CSV `rowTests` are not silently approximated; the generated script contains explicit warning comments for them.

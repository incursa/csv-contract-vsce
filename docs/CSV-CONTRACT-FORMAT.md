# CSV contract format

Version 0.14 adds optional versioned `baseline` definitions/references and ISO date
predicates. See [Validator workflows](VALIDATOR-WORKFLOWS.md) for their complete
format, interpretation policies, presets, live execution and migration notes.

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
  columnOrder: exact
  rowCount: { min: 1, max: 50000 }
  columnCount: { exact: 5 }
  columns:
    Company:
      presence: required
      constraints: { notNull: true }
    EmployeeId:
      presence: required
      constraints:
        notNull: true
        unique: true
        maxLength: 12
        matches: '^\d+$'
    Status:
      presence: required
      constraints: { notNull: true, allowedValues: [Active, Complete] }
    CompletionDate:
      presence: required
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

rules:
  - id: completed-requires-date
    when: { column: Status, operator: equals, value: Complete }
    expect: { column: CompletionDate, operator: notBlank }
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

## SQL Server table and view targets

`sqlServer` applies the contract schema, row tests, conditional rules, and group rules to a table or view. The single-object form uses either a secret-backed `connection` profile or a non-secret Windows `integratedConnection`, plus `schema` and `table`. Use `sqlServer.targets` for multiple objects or connections:

```yaml
sqlServer:
  rowLocator: [EmployeeId]
  detailLimit: 100
  targets:
    - connection: test-readonly
      schema: dbo
      table: Employees
      objectType: table
    - connection: prod-readonly
      schema: reporting
      table: EmployeeExport
      objectType: view
      columnMap:
        EmployeeId: employee_id
        EmailAddress: email_address
```

VS Code connection profiles live in Secret Storage. CLI profile names map to `CSV_CONTRACT_SQLSERVER_<NORMALIZED_PROFILE>`. A scope can take its runtime value from `valueEnvironment`; `dbtest --scope Parameter=value` overrides it.

An integrated target needs no profile:

```yaml
sqlServer:
  integratedConnection:
    server: sqlhost\\instance
    database: Warehouse
    trustServerCertificate: true
  schema: dbo
  table: Employees
```

`columnMap` is specific to a target and maps canonical contract column names to physical SQL Server column names. Exact mappings can be omitted. The Workbench suggests case-insensitive and standardized matches, such as `EmployeeId` to `employee_id`, but leaves ambiguous or unmatched names unmapped for review. Contract rules, CSV headers, and report labels continue to use the canonical names.

Table or view metadata supplies the physical column names and order. Translatable validations run as aggregate `SELECT` queries in SQL Server. A contract that uses JavaScript regex rules is projected read-only and evaluated by the existing validator so its behavior stays exact.

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

## Conditional row rules

`rules` are evaluated independently for every record. `when` is optional; when present, the expectation applies only to matching records. Predicates may be nested with `all` and `any`.

Supported string predicates are `equals`, `notEquals`, `in`, `notIn`, `isNull`, `notNull`, `isBlank`, `notBlank`, `equalsColumn`, `notEqualsColumn`, `contains`, `notContains`, `startsWith`, `endsWith`, and `matches`. Numeric predicates are `greaterThan`, `greaterThanOrEqual`, `lessThan`, and `lessThanOrEqual`. Numeric comparisons require both operands to parse as finite invariant numbers; otherwise the predicate is false.

Rules default to `severity: error`. A failed warning is reported and counted but does not fail the contract.

## Group completeness rules

`groupRules` select records with an optional `when`, partition them by the exact `groupBy` columns, and inspect one `require.column`. Use `require.values` for exact required values and/or `require.contains` when balance names contain qualifiers such as `Resident` or `Nonresident`.

The streaming validator does not decide a group when it sees its first record because companion records may occur later. It writes normalized group observations to hash-partitioned temporary files during the CSV pass and evaluates each group after EOF, one partition at a time. This makes the result independent of input order without loading the CSV or all groups into memory.

```yaml
groupRules:
  - id: city-tax-family
    when: { column: BalanceName, operator: contains, value: City }
    groupBy: [EntityId, State, County, City]
    require:
      column: BalanceName
      contains: [Gross, Reduced Subject Withholdable, Withheld]
```

## Child contracts for each group

`groupTests` applies a version-1 child contract to each group selected by `groupBy`. Use `groupBy: []` to validate the entire input as one group, including an empty input. The child can be inline as `contract` or stored in a separate `.csvtest.yaml` file through `ref`. A reference resolves relative to its containing contract. The child inherits the input, SQL connection, scope, and column mapping; it cannot declare independent targets. Nesting is limited to four levels and reference cycles are rejected.

```yaml
groupTests:
  - id: events_by_entity
    groupBy: [EntityId]
    groupCount: { min: 1 }
    ref: ./event-group.csvtest.yaml
```

The child can use `schema.rowCount`, `rowTests`, `rules`, `groupRules`, and `orderedRules`. A child `rowTests` count can require exactly one row of a given kind in each group; the same test at the root applies to the whole input. An ordered rule declares `orderBy` keys with `type: date`, `number`, or `string`; date keys can use `format: yyyy/MM/dd` or `iso`, and numeric keys can require `integer: true` and a `minimum`. Tied and invalid order keys always fail. The default check IDs are `<rule-id>.duplicate_order` and `<rule-id>.invalid_order`; `duplicateOrder` and `invalidOrder` can set custom IDs and messages.

For direct row relationships, use `relations`. Each relation applies its `when` predicate to each sorted row and declares exactly one of `requirePrior`, `forbidPrior`, or `requireNext`. Prior means an earlier row in the same group; next means a later row. `requirePrior` searches any preceding row unless `maxGap` limits the number of intervening rows. `requireNext` defaults to the immediately following row; `maxGap` permits a bounded number of intervening rows, and `allowBetween` restricts those rows. `allowFinal: true` permits an unmatched trigger at the end. All checks restart at each group or `partitionBy` boundary. A rule can contain relations alone or alongside an event state machine.

```yaml
groupTests:
  - id: records_by_entity
    groupBy: [EntityId]
    contract:
      version: 1
      schema:
        columns:
          EntityId: { presence: required }
          Event: { presence: required }
          OccurredAt: { presence: required }
          Position: { presence: required }
      rowTests:
        - id: one_creation
          select: { Event: CREATED }
          expect: { count: { exact: 1 } }
      orderedRules:
        - id: lifecycle_order
          orderBy:
            - { column: OccurredAt, type: date, format: iso }
            - { column: Position, type: number, integer: true }
          relations:
            - id: note_after_creation
              message: Notes require a prior creation.
              when: { column: Event, operator: equals, value: NOTE }
              requirePrior: { column: Event, operator: equals, value: CREATED }
            - id: suspension_followed_by_restore
              message: A restore must follow a suspension within two rows.
              when: { column: Event, operator: equals, value: SUSPENDED }
              requireNext: { column: Event, operator: equals, value: RESTORED }
              maxGap: 1
              allowBetween: { column: Event, operator: equals, value: NOTE }
```

Event mappings, transitions, cardinality, final states, and adjacency checks remain available when every step of a sequence needs explicit states. Mappings are reviewed in declaration order; an unmatched action and reason pair is a finding.

When `reasonColumn` is declared, each event mapping must list `reasonCodes` or explicitly set `reasonPolicy: any`. `reservedReasonCodes` prevents a broad mapping from consuming a reason code reserved for a specific event pair. Unknown combinations fail the `unmapped` check.

Group findings carry the group key, child rule ID, source row, related rows when applicable, and actual values in the normal results JSON and Workbench. Failure details obey the usual `maxIssues` limit. CSV groups are sorted in temporary runs; small groups are checked in memory and large groups spill to temporary disk. SQL validation streams the ordered target once through the existing read-only session and requires `sqlServer.rowLocator` for stable source positions. Generated standalone SQL does not represent child or ordered rules; use normal `test` or `dbtest` execution for the complete contract.

## Exact header order

Set `schema.columnOrder: exact` when a receiving system requires the CSV headers to appear in the same order as `schema.columns`. Presence and additional-column rules still apply normally.

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

The streaming CLI and PowerShell wrapper report at most 1,000 issue records by default while continuing to count every error and warning. Use `--max-issues` or `-MaxIssues` to change that bound. The result distinguishes:

- `issues`: the retained issue records
- `issueCount`: the total number of detected issues
- `truncated`: whether additional issue records were omitted

This keeps a badly malformed multi-million-row file from exhausting memory just to describe repeated failures. See [PowerShell and large-file operation](POWERSHELL-AND-PERFORMANCE.md) for batch commands, progress, exact disk-backed uniqueness, and performance guidance.

## Deliberately deferred

Version 1 deliberately uses finite predicates instead of arbitrary expressions. It does not include foreign keys across files, general arithmetic expressions, typed date comparison, JUnit, or SARIF. These can be added later without weakening the exact-string core.

## Compound suites

Use an ordered `*.csvsuite.yaml` master to reference contracts with different schemas and tables, or combine them into a portable inline bundle. Both forms run through Workspace Tests and the CLI. See [Compound suites](COMPOUND-SUITES.md) for formats, connection precedence, combine/split commands, round-trip guarantees and execution reporting.

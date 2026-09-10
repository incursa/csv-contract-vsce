# Compound contract suites

Version 0.13 adds ordered, heterogeneous suites. Use `*.csvsuite.yaml` or
`*.csvsuite.yml` for schema completion and Workspace Tests discovery. A suite
does not change the meaning of an individual version-1 contract. In particular,
`sqlServer.targets` still applies **one** schema/rule set to equivalent objects;
suite members can have entirely different schemas, rules and tables.

## Referenced and inline forms

```yaml
suiteVersion: 1
id: hcm
name: HCM staging checks
defaults:
  connection: staging-readonly
members:
  - id: employees
    ref: ./contracts/employees.csvtest.yaml
  - id: departments
    ref: ./contracts/departments.csvtest.yaml
```

Each member has exactly one `ref` or `contract`. References resolve relative to
the containing suite, including when invoked from another working directory.
IDs use letters, digits, dots, underscores and hyphens, start with a letter or
digit, and must be unique (case-sensitive) within the suite. Order is significant
for execution and fail-fast. Missing files and cycles are errors. References
must name individual contracts: nested suites are detected and rejected.

The equivalent inline form embeds the full contract mapping:

```yaml
suiteVersion: 1
id: hcm
defaults:
  connection: staging-readonly
members:
  - id: employees
    contract:
      version: 1
      schema:
        columns:
          EmployeeId:
            presence: required
            constraints: {notNull: true, unique: true}
      sqlServer: {schema: staging, table: Employees}
  - id: departments
    contract:
      version: 1
      schema:
        columns:
          DepartmentCode:
            presence: required
            constraints: {notNull: true}
      sqlServer: {schema: staging, table: Departments}
```

These examples are database-only. No CSV input is required. Existing `csv`
normalization settings inside database contracts are retained because SQL
validation also uses them. `name`, `description`, and opaque object `metadata`
are supported on suites and members; contracts also support `metadata`.
Metadata never changes execution behavior.

## Connection precedence and secrets

From highest to lowest: explicit `sqlServer.targets[i]` connection settings,
contract `sqlServer` connection settings, suite `defaults`. Defaults contain
only `connection` or `integratedConnection`; they never merge schemas or rules.
Connection alternatives are atomic: a higher-priority profile replaces an
inherited integrated connection and vice versa. Integrated options are replaced
as a complete object, not merged field by field. A level cannot declare both.
Split retains defaults on the generated master; run that master to retain its
inherited configuration when a member lacks its own connection settings.

Use profile names, never connection strings in YAML. The CLI resolves profile
`staging-readonly` from `CSV_CONTRACT_SQLSERVER_STAGING_READONLY`. VS Code uses
Secret Storage with the existing environment fallback. Integrated connections
contain non-secret server/database names and use the current Windows identity.
The bundled integrated driver supports Windows x64; connection profiles and CSV
validation remain available on other desktop platforms. Database execution is
unavailable in the web extension host.

Do not place credentials in comments, metadata or literal assertion values.
Conversion rejects credential fields and connection strings, but cannot infer
whether an arbitrary business string is a secret. Credentials and runtime scope
values remain outside portable bundles. `--scope Parameter=value` overrides
the target's `scope.valueEnvironment` exactly as for individual contracts.

## Combine, split and round-trip guarantee

```powershell
node ./dist/cli/csv-contract.cjs combine --spec ./hcm.csvsuite.yaml --out ./hcm.portable.csvsuite.yaml
node ./dist/cli/csv-contract.cjs split --spec ./hcm.portable.csvsuite.yaml --out ./split-hcm
```

Combine accepts referenced, inline or mixed members and emits entirely inline
contracts. Split emits `member-<ordinal>-<id>.csvtest.yaml` files and an
`<suite-id>.csvsuite.yaml` master. Original filenames are not guaranteed; IDs,
member order, mapping order, supported metadata, literal values, schemas, rules,
table targets, configuration and **effective validation semantics** are preserved.
Split intentionally leaves inherited defaults on the master rather than writing
them into each contract. It does not deduplicate or reinterpret rules.

YAML nodes retain scalar styles and comments where feasible. Indentation, line
endings, whitespace, document-level comment placement and comments attached
specifically to a replaced `ref` field are not byte-for-byte guarantees. Schema
modelines are comments, not runtime dependencies. YAML anchors/aliases are
rejected during conversion; unknown tags, duplicate keys, non-finite or unsafe
integer literals, and unsupported contract/suite fields are rejected rather than
silently dropped. Quote large numeric identifiers. Use `metadata` for annotations.
Original contract files are never rewritten by combine.

Relative CSV target paths are rebased to retain their original location when
bundling or splitting. Local CSV files and HTTP URLs are external dependencies,
so combine refuses to call such a bundle portable. `--allow-external` explicitly
allows a nonportable inline bundle and prints its dependency list. It does not
copy data or download URLs. Authenticated/query-bearing URLs are rejected.
An inline bundle is portable with respect to contract files and data inputs;
database services, drivers, connection profiles and runtime scopes must still
be available where it is executed. McKee's bundle has no external file inputs.

Existing output files cause an error. `--force` explicitly permits replacement.
Split preflights all destinations before writing. Filesystem failures can still
leave partial new output; writes across multiple files are not transactional.

## Execute and report

```powershell
node ./dist/cli/csv-contract.cjs dbtest --spec ./hcm.csvsuite.yaml --format json
node ./dist/cli/csv-contract.cjs dbtest --spec ./hcm.portable.csvsuite.yaml --fail-fast
node ./dist/cli/csv-contract.cjs sql --spec ./hcm.csvsuite.yaml --out ./hcm.sql
```

`dbtest` applies each member's schema/rules to its database targets. A single
in-process session reuses connection pools across members. Collect-all is the
default: failed assertions and member execution errors do not prevent subsequent
members from running. `--fail-fast` stops after the first failure/error within
each suite and explicitly marks remaining expected work `SKIPPED`. Repeated
`--spec` inputs remain independent suites. A malformed master prevents its
execution entirely; a missing/invalid member becomes a member error.

JSON includes overall validity, suite reports, per-member runs and a flat `runs`
array. Each run identifies suite/member/table, status, and either a normal
`ValidationResult` with rule IDs or an execution error. Text includes suite totals,
per-member/table status and rule failure details. Rule diagnostics remain bounded
by `--max-issues`; total counts continue to include all failures.

| Outcome | Exit code |
| --- | --- |
| Every expected run passed (warnings allowed) | 0 |
| Assertion failure, including fail-fast skips after that failure | 1 |
| Configuration, parsing, connection, query or missing-result error | 2 |

Errors take precedence over assertion failures across repeated specs. An empty
suite, missing target, missing member or missing SQL rule summary cannot pass.
`SKIPPED` means work not executed after fail-fast, not a passing test. Optional
column constraints retain their existing single-contract behavior.

For CSV suites, `test --spec <suite>` expands members into the existing streaming
pipeline, retaining member IDs and sharing compatible file passes. Every member
must have CSV targets or an explicit `--csv`; this command retains the existing
CSV runner's fatal-error behavior and does not support database fail-fast reports.
Use `dbtest` for McKee: never supply `--csv` for its database contracts.

SQL generation includes all member/table checks, each in an isolated `GO` batch
with suite/member/table identification. It emits aggregate rule results, not
employee row samples. Review the connection and fill declared scope placeholders
before execution. It does not connect or run SQL. Existing generator translation
limitations still apply: warnings describe rules needing the runtime's exact
client fallback; generated SQL alone is not proof of complete validation when
warnings exist, and runtime metadata checks are additional to generated rules.

If targets use different connections, use `sql ... --format json --out batches.json`.
The manifest contains every batch and its declared connection; execute each on
that connection. A single text script across different connections is refused.
`GO` requires an SSMS/sqlcmd-compatible client; it is not a T-SQL statement.

## VS Code

Open a `*.csvsuite.yaml` or `*.csvsuite.yml` file in the Suite Workbench. The
overview lists every member and target; expand members to inspect their schemas
and rules. **Run suite** displays member results and failure details in the editor.
**Generate SQL** opens the generated script or connection-specific batch manifest.
**Open contract** opens referenced members in their existing Workbench; **Edit inline
contract** opens the embedded mapping in YAML beside the suite. **Edit suite YAML**
provides schema validation and completion. Opening a suite does not execute tests.

If VS Code kept an existing text-editor association, use **Reopen Editor With →
CSV Contract Workbench**, or **CSV Contract: Open Workbench**, after updating to
0.13.1 or later.
Reference diagnostics identify the failing member and path and refresh when YAML
files change. **Run Contract**, **Workspace Tests → Run Selected**, and
**Generate SQL Server Staging Validation** accept either suite representation.
Workspace Tests shows all suite tables and reports member/table results using the
existing report UI, distinguishing execution errors from assertion failures.
Desktop suite runs execute configured SQL and CSV targets; web runs report an
explicit error for database members. The single-contract visual form remains
unchanged; suite composition and inline contract edits use the YAML editor.

## Offline McKee acceptance

The local fixture contains 23 different table contracts. The generated master and
portable bundle produce the same 1,303 SQL rules with no translation warnings;
split/reload produces the same contracts and checks. Source hashes are recorded
in `mckee-hcm.acceptance.json` beside the fixture. Synthetic in-memory blank rows
produce identical outcomes (1 pass, 22 assertion failures, no errors or skips).
No employee records were read or exported, and no database was connected.

The acceptance test is opt-in to avoid publishing client contracts in this repo:

```powershell
$env:CSV_CONTRACT_ACCEPTANCE_DIR = 'C:\path\to\a\fresh\copy\of\the\23\contracts'
node --test ./dist/test/suite-acceptance.test.cjs
```

It creates the three suite/acceptance artifacts and refuses existing outputs.
Actual database verification requires a separately approved live run.

# Validation capability catalog

This catalog is the routing map for human and AI authors. Start with the business
statement, choose the smallest matching test scope, and use a suite only when the
rule genuinely spans independent contracts or sources.

All executable behavior must use a documented field. `metadata` is preserved but
never executed. A companion SQL path in metadata is therefore documentation, not
part of `test` or `dbtest`.

## Contract-level tests

| Business question | Contract feature | Scope and limits |
| --- | --- | --- |
| Does the file/table have the required shape? | `schema.columns`, `columnCount`, `rowCount`, `columnOrder`, `allowAdditionalColumns` | Whole target. Column constraints cover presence, nulls, uniqueness, lengths, allowed values, and regex. |
| Is the business key unique? | `identity` | Whole target; supports composite keys and explicit null handling. |
| Does an exact known row exist, or are there exactly N such rows? | `rowTests` | Exact-value selectors, count expectations, and exact cells. Prefer `rules` for predicates. |
| Does every selected row satisfy an expectation? | `rules` | Per row. Supports nested `all`/`any`, string, numeric, date, null/blank, regex, and same-row cross-column predicates. |
| Does every business group contain required values? | `groupRules` | Groups rows by exact key columns and checks required exact values or contained fragments in one column. |
| Should a full child contract run for every group? | `groupTests` | Applies inline or referenced version-1 contracts per group, or once for the whole target with `groupBy: []`. |
| Should a child contract run only for groups with a particular aggregate shape? | `groupTests[].select` | Selects groups with filtered `rowCount` or `distinctCount`; selectors compose with `all`/`any`. `groupCount` and group outcomes count selected groups. |
| Must rows occur in a typed order or relationship? | `orderedRules[].relations` | Per ordered partition. Requires/forbids prior rows or requires later rows with bounded gaps. Predicates inspect one candidate row at a time; they do not compare current and neighboring column values. |
| Must an event history obey explicit lifecycle states? | `orderedRules` with `event` and transitions | Per ordered partition. Supports mappings, initial/final states, transitions, cardinality, adjacency, and date relations. |
| Has the observed schema drifted from an accepted snapshot? | `baseline` | Compares the target schema with a reviewed baseline; accepting a baseline is a separate explicit action. |
| Is there a SQL-only condition that the portable predicate model cannot express? | `sqlServer.conditionalRules` | SQL-target-only compatibility feature with a smaller predicate set. Prefer portable `rules` when possible. |

## Aggregate-selected groups

Use aggregate group selection when the condition describes the collection before
it describes an individual row. The following selects person/date groups with two
or more distinct nonblank legal employers, then checks every transfer-family row
inside only those groups:

```yaml
groupTests:
  - id: same_day_cross_employer_transfer
    groupBy: [PERSONNUMBER, EFFECTIVESTARTDATE]
    select:
      distinctCount:
        column: LEGALEMPLOYERNAME
        where: { column: LEGALEMPLOYERNAME, operator: notBlank }
        count: { min: 2 }
    contract:
      version: 1
      schema:
        columns:
          ACTIONCODE: { presence: required }
          REASONCODE: { presence: required }
          EFFECTIVESEQUENCE: { presence: required }
      rules:
        - id: cross_employer_transfer_is_tro_sequence_one
          when:
            column: ACTIONCODE
            operator: in
            values: [TRANSFER, GLB_TRANSFER, TRANSFER_OUT, TRANSFEROUT, TRANSFER_IN, TRANSFERIN]
          expect:
            all:
              - { column: REASONCODE, operator: equals, value: TRO }
              - { column: EFFECTIVESEQUENCE, operator: equals, value: '1' }
```

`rowCount` selects by the number of rows matching an optional `where` predicate.
`distinctCount` counts normalized distinct values from one column after applying an
optional row predicate. Both use the normal `{ exact, min, max }` count shape.

```yaml
select:
  all:
    - rowCount:
        where: { column: ACTIONCODE, operator: in, values: [TRANSFER, GLB_TRANSFER] }
        count: { exact: 1 }
    - distinctCount:
        column: LEGALEMPLOYERNAME
        where: { column: LEGALEMPLOYERNAME, operator: notBlank }
        count: { min: 2 }
```

Use the group key and aggregates that define the business rule. Do not substitute
adjacent-row logic merely because an implementation happens to use `LAG` or `LEAD`.

## Suite-level tests

Suites combine independent contracts and add checks that require more than one
member. Suite cross-checks currently support:

- `foreignKey`: every selected key on one side must exist on the other;
- `equalPopulation`: selected row counts must agree;
- `equalTotal`: selected numeric totals must agree within a tolerance;
- `rowReconciliation`: keyed source rows must exist and preserve or transform declared values;
- `relationship`: a keyed row must satisfy a predicate against a deterministic ranked lookup row.

Selections can filter rows, rank one row per partition, require matches from another
member, and combine eligibility branches. Cross-checks can run over two CSV sources
or compatible SQL targets; mixed CSV/SQL execution is not supported. SQL participants
must meet the documented connection and target-count restrictions. A `targetMatrix`
reuses the same logical contracts and cross-checks across corresponding environments.

An individual SQL cross-check can explicitly enable `crossConnection` for bounded
portable evaluation across separate connections. This mode is also used when the
opted-in sources happen to share a connection, keeping comparison semantics stable.
It is not a distributed transaction or atomic snapshot. See
[controlled cross-connection checks](CROSS-CONNECTION-VALIDATION.md) for limits,
scoping, exact numeric behavior, and failure conditions.

## Reuse, execution, and review

| Need | Supported mechanism | Boundary |
| --- | --- | --- |
| Reuse a reviewed family of rules | Local, versioned `rulePacks` with pinned SHA-256 and explicit parameters | No remote fetching or arbitrary executable code; pin changes require review. |
| Prove a rule catches the intended cases | `*.validationfixtures.yaml`, CLI `fixtures`, and `explain` | Use invented data for passing, failing, zero-selected, and boundary cases. |
| Select SQL environments without editing every child | Suite `targetPolicy` and member `targetOverrides` | Stable target IDs; disabled work remains visibly skipped. |
| Detect FK or filtered-index drift | Optional SQL baseline metadata | Unavailable permissions mean unknown, not absent metadata. |
| Run without VS Code or Node.js installed | Windows standalone executable and local browser UI | Definition/data remain external inputs; native SQL environment acceptance is separate. |
| Share an understandable result | Offline HTML, review-package JSON, and Excel workbooks | Shared review defaults are aggregate-only; detailed compatibility exports can contain protected values. |
| Compare prior evidence without rerunning sources | Saved review packages and conservative diffs | Changed or missing definitions, scopes, or complete findings produce indeterminate comparisons. |
| Emphasize high-value rules visually | Optional `importance` from 0.1 to 10 | Affects only graded health; never changes severity, PASS/FAIL, or exit codes. |

Explicit check outcomes distinguish pass, fail, not-applicable, not-evaluated, and
unknown. A missing retained row is not a passed row. Evaluation completeness and
detail-retention completeness are separate, so a limited sample is never presented
as a full scan. Start AI authoring with
[the authoring guide](AI-AGENT-CONTRACT-AUTHORING.md) and
[rule packs and fixtures](RULE-PACKS-AND-FIXTURES.md).

## Choosing the scope

1. Use `schema`, `identity`, `rowTests`, or `rules` for whole-target and per-row facts.
2. Use `groupRules` for simple required-value completeness.
3. Use aggregate-selected `groupTests` when group composition decides whether a child rule applies.
4. Use ordered relations for temporal or positional requirements within one partition.
5. Use an event state machine only when explicit states and transitions are part of the policy.
6. Use suite cross-checks only when independent members or sources must be reconciled.
7. If none fits, document the gap before adding a one-off field or companion script.

## Authoring and execution boundaries

- Stable rule IDs are part of automation and history; do not rename them casually.
- Keep source-backed rules, observations, and unresolved assumptions distinct.
- Referenced child contracts are the preferred way to separate a large cohesive
  lifecycle or group policy without changing its executable semantics.
- The YAML is the executable source of truth. The Workbench is an editor and viewer
  over the same model, not a separate rule store.
- Generated standalone SQL does not include grouped child or ordered rules. Run the
  complete contract through `test` or `dbtest`.
- A passing suite covers only executed members and checks. Disabled, skipped,
  unsupported, companion, or metadata-only checks are not passes.
- Row-level findings can contain source values. Use aggregate evidence where data
  sensitivity or handoff requirements prohibit retained examples.

## Known gaps to evaluate deliberately

The current model does not provide arbitrary expressions, custom code, cross-row
column operands such as `current.Employer <> previous.Employer`, mixed CSV/SQL suite
joins, or automatic execution of companion SQL named in metadata. Add a typed,
portable construct only after at least two or three concrete rules demonstrate a
reusable semantic shape.

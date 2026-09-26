# Grouped child contracts: proposed version-1 extension

```yaml
version: 1
schema:
  columns:
    EntityId: { presence: required }
groupTests:
  - id: per_entity
    groupBy: [EntityId] # [] evaluates the entire input, including an empty input
    groupCount: { min: 1 }
    ref: ./event-group.csvtest.yaml # or `contract: { version: 1, schema: ..., orderedRules: ... }`
targets:
  - { path: ./events.csv }
sqlServer:
  targets:
    - { name: Region A, integratedConnection: { server: "server-a", database: Operations, trustServerCertificate: true }, schema: dbo, table: EventStaging }
    - { name: Region B, integratedConnection: { server: "server-b", database: Operations, trustServerCertificate: true }, schema: dbo, table: EventStaging }
    - { name: Region C, integratedConnection: { server: "server-c", database: Operations, trustServerCertificate: true }, schema: dbo, table: EventStaging }
```

The referenced child is a normal version-1 contract with `schema`, `rowTests`, `rules`, `groupRules`, and optional `orderedRules`. It has no independent targets: the parent passes each selected group as its input. Inline children have the same shape. A child may itself have `groupTests`, with a depth limit and cycle detection. References resolve relative to the containing contract, following suite reference conventions.

Implementation steps:

1. Rename the in-progress sequence rule to a generic ordered rule within a contract. Its evaluator handles typed order, duplicate keys, event mapping, transitions, cardinality, and adjacent date relations; group selection is separate.
2. Add `groupTests` to the model/schema/parser and resolve child references before execution. Reject child targets, cycles, excess depth, and missing referenced columns explicitly.
3. Feed CSV and SQL rows into one disk-backed group sorter. SQL reads bounded pages from one session per target. Process one group at a time through the existing CSV contract validator, without holding large groups in memory.
4. Prefix child issues with group identity, retain source positions, aggregate counts and bounded samples into normal results JSON and Workbench output.
5. Verify local CSV fixtures and mocked SQL parity, then package and release a VSIX.

Second-source comparisons are a future optional group lookup with declared join keys, an exact-match cardinality (normally one source row per group), and separate findings for missing and duplicate source matches. The lookup source would be resolved once per target, read without user-supplied SQL, and joined through a bounded disk-backed key index. Date equality would compare parsed dates rather than formatted strings. No source lookup is configured or executed by this release; source-date comparisons remain pending.

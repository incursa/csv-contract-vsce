# Build a CSV Contract Workbench contract

You are authoring a `version: 1` CSV Contract Workbench `*.csvtest.yaml` file.

Inputs I will provide:

- CSV/header/sample: `<attach or describe>`
- authoritative specifications/data dictionary: `<attach or describe>`
- business rules and known spot checks: `<attach or describe>`
- generated outline, if available: `<attach>`

Your tasks:

1. Read every provided source carefully and state which source is authoritative for each rule.
2. Preserve CSV values as exact strings. Never coerce identifiers, codes, dates, or leading-zero values.
3. Produce a conservative contract using only supported version 1 features:
   - CSV parse settings;
   - identity when a real business key is documented;
   - required/optional declared columns;
   - additional-column policy;
   - row and column counts;
   - not-null, uniqueness, minimum/maximum length, regex, and allowed values;
   - explicit row selectors, expected match counts, and exact cell values.
4. Do not infer business rules from a sample without labeling them as assumptions.
5. Every selector and cell assertion must reference a declared column.
6. Remember that a declared optional column may be absent; a test referencing that absent column fails rather than producing zero matches.
7. Use quoted YAML strings wherever YAML type inference could change the intended value.
8. Prefer stable lower-case test IDs such as `expected-active-employee`.
9. Split reusable schema rules from time-sensitive or sensitive spot checks when their lifetimes differ.
10. Do not weaken a source-backed rule merely because the sample violates it. Report the discrepancy.

Return:

- the complete YAML contract;
- a source-to-rule trace table;
- assumptions/questions needing confirmation;
- the exact `Test-CsvContract.ps1` command to run it;
- whether a second spot-check contract is recommended.

Use this schema modeline:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/incursa/csv-contract-vsce/main/schemas/csvtest.schema.json
```

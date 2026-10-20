# AI agent contract authoring

This guide is for using ChatGPT, Codex, or another capable agent to turn source material into a reviewed `*.validation.yaml` contract. The legacy `*.csvtest.yaml` name has identical semantics and remains supported.

## Good source material

Provide as much of the following as is available:

- a representative CSV or at least its header and a bounded sample;
- a data dictionary or interface specification;
- export SQL, report definitions, mapping workbooks, or vendor documentation;
- expected row counts or count ranges;
- known business keys;
- enumerated status/type values;
- field length limits;
- examples of rows that must or must not exist;
- exact spot-check values, including leading zeroes and whitespace significance.

Tell the agent which sources are authoritative when they disagree.

Before choosing YAML fields, read [Validation capability catalog](VALIDATION-CAPABILITY-CATALOG.md). It maps business questions to row, group, ordered, state-machine, and suite scopes and records current execution boundaries.

For complex rules, also read [Rule packs and fixtures](RULE-PACKS-AND-FIXTURES.md).
Keep dependencies local and SHA-256 pinned; never silently replace a pin. Deliver
small synthetic passing, failing, boundary, and zero-applicable examples with the
rule. Run them with `validation-runner fixtures --source <fixtures.yaml>` before
testing protected data. An expected failure is a successful fixture only when the
specified finding IDs/codes/counts match, not merely when some error occurs.

Use `validation-runner explain --spec <definition-or-suite.yaml>` to inspect the
resolved plan. Zero applicable groups are not proof that a business requirement
was exercised: add an explicit `groupCount` assertion when coverage is required.
Keep validation verdict, importance/health, and retained evidence separate. Share
aggregate review packages by default; raw CSV/JSON/Excel compatibility exports can
contain sensitive values. See [review packages](REVIEW-PACKAGES.md).

## Recommended workflow

1. Generate a mechanical outline from the real CSV:

   ```powershell
   .\scripts\New-CsvContract.ps1 `
     -Csv .\exports\employees.csv `
     -Output .\contracts\employees.csvtest.yaml
   ```

2. Give the generated outline and source material to the agent.
3. Ask the agent to separate source-backed rules, sample-derived observations, and assumptions requiring confirmation.
4. Require exact string semantics. IDs such as `"000123"` must remain strings.
5. Require every selector and cell assertion to use a declared column.
6. Prefer a reusable general contract plus a separate spot-check contract when the checks have different lifetimes.
7. Run the proposed contract:

   ```powershell
   .\scripts\Test-CsvContract.ps1 `
     -Contract .\contracts\employees.csvtest.yaml `
     -Format json
   ```

8. Give failures back to the agent with the relevant authoritative source. Do not let the agent weaken a rule merely to make a sample pass.
9. Review generated row assertions. The outline’s sample assertions are examples and may be replaced or removed.
10. Commit the contract with the source/provenance notes that explain why non-obvious rules exist.

## Decision rules for the agent

- A column is `required` only when the output interface guarantees it.
- An optional column’s constraints apply only when that column exists.
- `allowAdditionalColumns: true` accepts undeclared columns but does not validate them.
- `notNull`, `unique`, lengths, regex, and allow-lists require source evidence or explicit user approval.
- `identity` is optional and should represent a real composite business key.
- Row selectors are explicit and do not require `identity`.
- Use `expect.count.exact: 0` for rows that must not exist.
- Use quoted YAML strings for identifiers, codes, dates, and values where YAML might infer another type.
- Prefer anchored regexes such as `^\d{6}$`.
- Use finite `rules` predicates for conditional, cross-column, string, and numeric checks; do not invent arbitrary expression syntax.
- Use `groupRules` when every business grain must contain a required set of exact values or name fragments. Include every column that defines the grain in `groupBy`.
- Use `groupTests[].select` when a child contract applies only to groups with a filtered row count or distinct-value count. State the business grain first, then the aggregate condition, then the child row rules.
- Use ordered relations only when order is part of the policy. Do not turn a whole-group rule into preceding/following-row logic merely because relevant rows are often adjacent.
- Use a state machine only when the authoritative rule defines states and valid transitions. Do not use it as a generic container for unrelated complex checks.
- Use suite cross-checks when the rule compares independent contracts or sources. Keep a single-source group rule inside its contract.
- If the catalog has no matching scope, write the desired semantics and counterexamples before proposing a new field. Prefer a typed reusable capability over arbitrary expressions or embedded code.
- Prefer `severity: warning` only when the condition requires review but should not fail delivery.
- Never include sensitive production values in a committed spot-check contract without approval.
- Prefer relative `targets[].path` values for portable repositories. Use `targets[].url` only for stable HTTP or HTTPS CSV sources, and never embed credentials or secret-bearing URLs.

## Expected deliverables

Ask the agent to return:

1. the proposed YAML contract;
2. a short source-to-rule trace table;
3. assumptions and questions;
4. the exact PowerShell validation command;
5. a recommendation on whether general and spot-check rules should be split.

For a complex rule, also return a small decision table containing at least one passing case, one failing case, one boundary case, and any case intentionally left for review. This prevents an implementation detail such as adjacency from silently replacing the actual business condition.

The ready-to-paste prompt in `prompts/author-csv-contract.md` encodes this workflow.

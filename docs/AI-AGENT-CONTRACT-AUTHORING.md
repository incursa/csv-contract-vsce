# AI agent contract authoring

This guide is for using ChatGPT, Codex, or another capable agent to turn source material into a reviewed `*.csvtest.yaml` contract.

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
     -Csv .\exports\employees.csv `
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
- Avoid cross-column logic because version 1 does not support it.
- Never include sensitive production values in a committed spot-check contract without approval.

## Expected deliverables

Ask the agent to return:

1. the proposed YAML contract;
2. a short source-to-rule trace table;
3. assumptions and questions;
4. the exact PowerShell validation command;
5. a recommendation on whether general and spot-check rules should be split.

The ready-to-paste prompt in `prompts/author-csv-contract.md` encodes this workflow.

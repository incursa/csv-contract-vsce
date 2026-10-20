# Rule packs and synthetic validation fixtures

Rule packs make complex validation rules reusable without adding code execution, remote downloads, macros, or floating dependencies. Validation fixtures run small inline CSV examples through the same in-memory validator used by normal CSV validation. Together they provide a reviewable authoring loop: resolve, explain, exercise boundary cases, then deliberately adopt a changed pin.

## Pinned local reuse

A `*.rulepack.yaml` file is `version: 1` and contains named `definitions`. A definition may contain a rule `fragment`, ordered `uses`, or both. Each use names another definition in a relative local file and supplies its exact SHA-256 digest:

```yaml
uses:
  - id: shared-status
    ref: ./shared.rulepack.yaml
    sha256: 3f67fd1de13d028999c86697a3e426155a827ab4e669498806ba908e0dd5f865
    definition: required-status
    parameters:
      column: "${statusColumn}"
```

This is the only reuse mechanism: a small template is a definition, and a collection of definitions is a pack. Parameters are declared scalars substituted into declarative YAML values. They cannot invoke functions, evaluate expressions, read environment variables, or add keys dynamically.

Resolution is deterministic:

1. Resolve each `ref` relative to the file that contains it.
2. Reject URLs, absolute paths, workspace escapes (when a root is supplied), missing files, and hash mismatches.
3. Bind only declared parameters; reject missing and unknown parameters.
4. Resolve `uses` in listed order, then append the definition's local fragment.
5. Reject reference cycles and duplicate resolved IDs, including nested check IDs.
6. Return the fragment with source paths, hashes, definition IDs, use IDs, and bound parameter values as provenance.

This origin rule also applies to `groupTests[].ref` inside a pack fragment: the runtime loader retains the defining pack source so the child reference does not accidentally move when the fragment is merged into a consumer contract.

Nothing automatically follows a changed file. `previewRulePackPin` reports the pinned and current digest and returns a proposed use object; the caller must display and explicitly persist that update. `resolveRulePackDefinition` refuses to resolve a stale pin.

### Review and apply a changed pin

`previewRulePackUpdate` is the richer update planner. It reads but never edits the referenced pack and reports:

- the pinned and candidate SHA-256 values;
- candidate pack text for a read-only diff;
- every selected definition's proposed check IDs and stable content fingerprints;
- added, removed, and changed checks when prior pinned bytes are supplied and hash-verified;
- nested dependency paths, expected/current hashes, and resolved provenance.

A hash cannot reconstruct prior content. When prior pinned bytes are unavailable, the preview explicitly marks `semanticDiff.baselineAvailable: false`, leaves added/removed/changed empty, and lists the fully validated candidate checks separately. The user may deliberately accept that limited comparison, but the UI must not describe candidate checks as additions.

Invalid packs, missing definitions or parameters, stale nested pins, cycles, remote paths, and hash failures produce a non-applicable preview. There is no auto-accept, migration, remote fetch, macro, or custom-code path.

Candidate validity is checked in context, not only inside the pack. Preview clones the exact owning standalone contract or selected inline suite member, substitutes the proposed pin, expands every pack, resolves group children, and validates the merged checks against the consumer schema. Duplicate IDs with local rules and references to undeclared consumer columns therefore block Apply. The same full-consumer validation runs again immediately before edit preparation.

`prepareRulePackUpdateEdit` is allowed only after a successful preview and explicit confirmation. Immediately before returning an edit it rechecks the exact validation-document content hash and editor version, the complete binding, the referenced pack hash, nested provenance, and the fully merged consumer. Any change requires a fresh preview. Its result replaces only the existing `sha256` scalar by source offset, preserving comments, formatting, and unrelated edits byte-for-byte. It never edits a referenced pack. The VS Code caller also rechecks text and version immediately after asynchronous dependency validation, before calculating and applying the range edit.

The VS Code command handles bindings owned by a standalone contract or an inline suite member. A referenced suite member is a redirect: open the exact child definition and update it there. Parent suites never silently modify children.

The resolved fragment is deliberately separate from `CsvContract`. Integration code should merge its `rules`, `groupRules`, `orderedRules`, and `groupTests` into a contract and then use the existing contract parser/semantic validation. That keeps the current model backward compatible and gives callers a clear point to report duplicate or incompatible contract content.

## Safe explanation

`explainResolvedRulePack` summarizes resolved declarative content without evaluating predicates. It reports:

- provenance and hashes;
- kind-major application order (`rules`, `groupRules`, `orderedRules`, `groupTests`) while preserving order inside each array;
- group-by columns and the serialized group selector;
- ordered-rule partition columns, sort keys, and check IDs.

The summary does not claim a group will be selected for particular data and does not run arbitrary expressions. Data-dependent behavior belongs in fixtures.

## Synthetic fixtures

A `*.validationfixtures.yaml` document contains either an inline contract or a pinned relative contract, followed by inline synthetic CSV cases. It cannot reference production CSV data.

Every case must assert `valid` plus at least one concrete count, issue list, rule outcome, or group outcome. Lists of `issueCodes` and `issueRuleIds` are exact multisets. Outcome entries match by ID and compare every supplied field, so a no-application assertion is explicit rather than skipped:

```yaml
expect:
  valid: true
  issueCount: 0
  groupOutcomes:
    - id: boundary-groups
      groups: 0
      passed: 0
      failed: 0
```

`runValidationFixtures` calls `validateCsv` directly with a fixed evaluation timestamp. It reports total, passed, failed, and validation issue counts, plus a result for every declared case. A fixture whose expectation is wrong is a failed fixture, even if the validator itself returned a valid result.

The fixture harness currently covers deterministic in-memory contracts, including ordered rules. It resolves pinned rule packs and `groupTests[].ref` through the normal local contract loaders before calling the validator. It does not run suites, targets, SQL Server checks, or external baselines. Those require their normal loaders and connected acceptance checks; fixture success must not be presented as deployment or database validation.

## Authoring example

See `examples/validation-authoring/`:

- `shared.rulepack.yaml` declares a parameterized rule.
- `workforce.rulepack.yaml` consumes that rule by a pinned hash and adds a group-selection boundary.
- `group-selection.validation.yaml` is a standalone synthetic contract.
- `group-selection.validationfixtures.yaml` proves zero-applicable, selected/pass, and selected/fail boundary cases without production data.

The JSON Schemas are `schemas/rulepack.schema.json` and `schemas/validationfixtures.schema.json`.

## CLI integration contract

The CLI exposes two inspection commands without changing validation semantics:

- `fixtures --source <file.validationfixtures.yaml> [--format text|json]`
- `explain --spec <contract-or-suite.yaml> [--format text|json]`

For fixtures, return exit code `1` when any expectation fails and reserve malformed input or pin failures for the existing usage/error path. Text output should show case IDs, counts, and expectation mismatches without dumping row evidence. JSON output may expose the complete machine-readable run when explicitly requested.

For explain, load the contract or suite normally so rule packs, child contracts, group selection, and execution order are summarized from the same resolved definition used by validation.

## AI authoring acceptance checklist

An AI authoring change is ready for review only when it can show all of the following without production data:

1. The pack and every nested dependency are relative local files with exact SHA-256 pins.
2. Required and accepted parameters are explicit scalars; unknown or missing parameters fail.
3. Resolved rule IDs are unique and the explanation shows group selection and ordering without evaluating arbitrary expressions.
4. Synthetic fixtures cover a valid case, an expected rule failure with exact codes/IDs, a zero-applicable group case, and relevant lower/upper boundaries.
5. The fixture runner reports every declared case; a mismatched expectation is a failed fixture, never a skip.
6. A pin update has a saved preview. If prior bytes are unavailable, the review says semantic delta unavailable and reviews the full candidate inventory.
7. Apply changes only the owning document's hash scalar after document-version, content-hash, pack-hash, and nested-provenance rechecks.

For example, an agent adding a reusable lifecycle rule should place the declarative definition in a local pack, bind columns through declared scalar parameters, add fixtures whose CSV values are synthetic, and return aggregate case/check counts. It should not copy production rows into examples, fetch a pack URL, place executable expressions in YAML, or report fixture success as connected SQL/deployment acceptance.

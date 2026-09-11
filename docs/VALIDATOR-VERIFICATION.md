# Validator 0.15 verification

Local verification used Windows x64, Node 26.7.0, PowerShell Core 7.6.5,
Playwright Chromium and the actual stable VS Code web extension host.
The established tag release workflow repeats `npm run release:check` on Windows
with Node 22 before publishing to Marketplace.

Release [v0.15.0](https://github.com/incursa/csv-contract-vsce/releases/tag/v0.15.0)
passed in [workflow run 34644555030](https://github.com/incursa/csv-contract-vsce/actions/runs/34644555030)
from commit `81011a244f1f13854515c456cd9d73f3e1b1ae96`. The hosted gate repeated
108 passing regressions, 25 PowerShell checks, rendered and actual host tests,
and VSIX packaging. The Marketplace publish log confirms 0.15.0 was accepted.
An independent `vsce show incursa.csv-contract-vsce --json` query confirmed 0.15.0 as the newest public version, updated September 11, 2026 at 20:45:42 UTC.

## Local checks

- 108 regression tests passed; one opt-in acceptance test is skipped by default.
- All 25 PowerShell checks passed.
- Rendered desktop/narrow Workbench tests passed under production CSP, including
  nested branch creation/reordering, literal preservation, selected issue export,
  preset controls, inline member navigation and stale result navigation.
- Actual VS Code host tests passed: explicit initial live execution, undoable inline
  edits using nested typed predicates, coalesced save, invalid YAML suppression,
  external reload, pause, automatic suite editor selection and unavailable-member errors.
- `npm run release:check` passed, including branding and production VSIX packaging.
- After the final integration fixes, the production regression bundles were rerun.

Rendered screenshots are saved outside the repository in the system temporary
`csv-contract-webview-qa` directory. The nested rule editor and filtered selected
result screenshots were visually inspected. The two pre-existing modified images
under `images/` are preserved and excluded from the release commit.

## Offline SQL-only acceptance

The opt-in acceptance test uses a fresh temporary copy of exactly 23 McKee contract
definitions. It compares unchanged definitions, 1,303 generated SQL rules with no
translation warnings, synthetic verdict parity, heterogeneous combine/split
semantics and portable round trips. Per-run evaluation timestamps are verified
against each report's start time and excluded only from cross-run semantic equality.

Synthetic blank records intentionally fail most business assertions. They test
parity, not database contents. The original acceptance directory is untouched;
no CSV targets are introduced. No remote database, employee records, stored
procedures, staging reloads, imports or database deployments are involved.

Mocked SQL tests cover complete summaries, real selected/pass/fail counts, bounded
preview queries/examples, native date fallback, target baseline precedence,
cancellation and retries. Pure plan tests cover independent scoped participants,
identifier quoting, connection boundaries and decimal-total guards. Additional
regressions cover relative evaluation, typed/precision/identity streaming parity,
sampled incomplete status, history privacy and target baseline path round trips.
Actual SQL Server execution of the new queries remains unverified without approval.

[Roadmap status](VALIDATOR-ROADMAP.md) and [workflow documentation](VALIDATOR-WORKFLOWS.md)
record the remaining boundaries. Linked templates remain optional future work;
CSV targets share a contract baseline and cross-connection checks are unsupported.
# Validator 0.14 verification

Verification used Windows x64, Node 26.7.0, PowerShell Core 7.6.5, Playwright
Chromium and the actual stable VS Code web extension host. The release workflow
separately uses Node 22 on Windows and repeats `npm run release:check` before
Marketplace publication.

## Local checks

- 99 regression tests passed; the normal run skips the opt-in client acceptance test.
- All 25 PowerShell checks passed.
- Rendered Workbench tests passed at desktop and narrow widths with the production
  CSP restrictions, including both single and suite views.
- Actual VS Code host tests passed: explicit initial live execution, undoable inline
  edits, coalesced save, invalid YAML suppression, external reload, pause, automatic
  suite editor selection and unavailable-member execution errors.
- Branding verifies nine PNGs, Marketplace metadata, README and the theme-aware mark.
- The required gate is `npm run release:check`, including production VSIX packaging.
  Sandbox networking initially prevented the official host-runtime check; the gate
  was rerun with approved network access. This was not a database connection.

Rendered interaction checks include preset leading-zero preservation, nested rule
literal editing, explicit preview/live/baseline actions, filtered result navigation,
stale labels, inline member navigation, 202-column scrolling, and responsive layout.
Screenshots are written to the system temporary directory `csv-contract-webview-qa`:
`nested-rule-editor.png`, `filtered-stale-results.png`, `suite-workbench.png`,
`large-column-workbench.png`, and the existing Workbench scenarios. The nested rule
and filtered-result screenshots were visually inspected. The two pre-existing
modified screenshots under `images/` were not overwritten or included in the commit.

## Offline SQL-only acceptance

The opt-in `test/suite-acceptance.test.ts` runs against a temporary copy of exactly
23 McKee contract definitions, using `CSV_CONTRACT_ACCEPTANCE_DIR`. It checks
unchanged definitions, 1,303 generated SQL checks, no translation warnings,
synthetic verdict parity, heterogeneous combine/split semantics and portable
round trips. Synthetic blank records intentionally fail most business assertions;
those failures test parity and are not claims about database contents.

The original acceptance directory was not modified. No CSV targets were introduced
into these SQL-only contracts. No remote database, employee records, stored
procedures, staging reloads or database deployments were involved.

Mocked SQL-session tests verify metadata failure versus drift, missing summaries,
selected/pass/fail counts, native-date fallback without changing literal comparison,
cancellation and opt-in transient retries. SQL plan tests cover identifier quoting,
scope handling, connection boundaries and decimal-total guards. Actual SQL Server
execution of new queries remains unverified without an approved database fixture.

See [roadmap status](VALIDATOR-ROADMAP.md) and [workflow limits](VALIDATOR-WORKFLOWS.md)
for explicitly incomplete capabilities. Passing this gate does not mean the entire
roadmap is implemented.

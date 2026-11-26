# Validator verification guide

Use this guide to reproduce the repository's validation gates. Release-specific run links, test counts, package versions, timestamps, and Marketplace observations belong in release notes or workflow records rather than this durable guide.

## Required local checks

From a clean dependency install, run:

```powershell
npm ci
npm run release:check
```

The release check covers the maintained regression suites, PowerShell checks, rendered Workbench behavior, VS Code host integration, branding, and VSIX packaging. Consult `package.json` and the workflow definitions for the exact commands used by a particular revision.

## Optional acceptance checks

Offline SQL acceptance uses temporary copies of synthetic or approved contract definitions. It must not modify the source fixture directory, introduce CSV targets into SQL-only definitions, contact a remote database, or read protected records unless the operator explicitly selects and authorizes those resources.

Synthetic blank records exercise translation and verdict parity; they do not establish correctness against business data. Per-run timestamps may be excluded from cross-run semantic comparison only when the comparison records that exclusion.

## Database-backed validation

Mocked SQL tests cover planning, summaries, bounded previews, connection precedence, cancellation, retries, cleanup, quoting, and numeric guards without proving driver or database compatibility. Claims about SQL Server, ODBC, Windows authentication, stored procedures, or live data require an explicitly authorized run against the named environment.

Record database-backed evidence with the source definition revision, connection class, driver/authentication mode, scope, timestamps, redactions, and outcome. Never commit credentials or protected row data.

## Evidence interpretation

- A passing local gate proves only the checked revision and environment.
- A packaged VSIX check does not prove Marketplace publication.
- A Marketplace query does not prove a later release remains latest.
- Synthetic or mocked checks do not prove live database behavior.
- Skipped or unavailable checks must be reported as unverified, not passing.

See [Validator workflows](VALIDATOR-WORKFLOWS.md) for runtime semantics and [Validator design requirements](VALIDATOR-ROADMAP.md) for durable product rules.

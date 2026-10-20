# Standalone Windows validation runner

The standalone runner packages the local Validation Workbench interface and validation engine as one Windows executable. A recipient does not need Node.js, npm, this repository, or installed JavaScript packages to run file-based validations.

## Build requirements

- Windows x64 or arm64, matching the architecture of the intended executable.
- Node.js 25.5.0 or newer. The packaging script uses Node's built-in `--build-sea` support, so it does not require `postject` or another executable-injection dependency.
- The production standalone bundle at `dist/standalone/validation-runner.cjs`.

Build and package the production runner:

```powershell
npm run package:standalone
```

The package script runs the production build before invoking `scripts/package-standalone.mjs`.

The output name includes the extension version and build architecture:

```text
artifacts/validation-runner-<version>-win-<architecture>.exe
```

For example, version 0.27.0 built with Windows x64 Node produces `artifacts/validation-runner-0.27.0-win-x64.exe`.

The packager creates a same-directory temporary executable and verifies its authoritative Windows PE manifest resource before promotion. The manifest must request exactly `asInvoker` with UI access disabled; `requireAdministrator`, `highestAvailable`, duplicate execution-level declarations, and malformed or missing manifests fail packaging. It then runs help, native-driver, ordinary file-validation, loopback-UI, and inherited-token checks before promoting the executable into `artifacts` with rollback protection. A successful run prints the executable size and SHA-256 digest.

## Run file validations

Copy the executable, validation definition, and source data to the target Windows computer. Start the executable with the validation definition:

```powershell
.\validation-runner-0.27.0-win-x64.exe serve --open .\orders.validation.yaml
```

The runner opens a loopback-only local web interface in the default browser. Review and approve all allowed targets, and then start the run. The interface provides progress and cancellation while the validation is active and can export its result package when complete. Invoke the executable with `--help` for its command-line usage.

## Standard-user operation

The runner is designed to stay at the caller's privilege level. Its PE manifest uses `asInvoker`; it does not request a UAC elevation prompt. Ordinary CSV validation and the loopback interface require neither Node.js nor an installer. They do not create services, firewall rules, machine registry entries, or machine-wide files.

Embedded native SQL files are written only beneath a private, per-process directory in the current user's `TEMP`/`TMP` location. The runner makes a best-effort cleanup on exit. If that directory cannot be created, correct the current user's temporary-directory availability or permissions; do not elevate the runner as a workaround. Input definitions, CSV files, and output destinations must likewise be accessible to the current user.

Packaging records a standard-user runtime check for both the packaging process and the launched executable. It reads the Windows `TokenElevation`, `TokenElevationType`, `TokenIntegrityLevel`, and Administrators-group attributes without changing the token. A `PASS` requires a non-elevated medium-integrity desktop token with the Administrators SID absent or not enabled. An elevated packaging host produces `UNVERIFIED`, not a standard-user claim. This check proves the tested process/token on that host; it is not a substitute for testing the final executable on a representative clean computer.

The checks can also be run directly:

```powershell
node .\scripts\verify-windows-pe-manifest.mjs .\artifacts\validation-runner-0.27.0-win-x64.exe
node .\scripts\verify-windows-standard-user.mjs
```

## Optional SQL prerequisites

CSV validation and SQL profile connections that use the bundled JavaScript driver remain available without an ODBC installation. Windows integrated authentication is optional and uses the bundled `msnodesqlv8` native add-on, which in turn requires a compatible Microsoft ODBC Driver for SQL Server on the target computer. The runner only detects this prerequisite; it never installs a driver or Visual C++ runtime and never changes privileges. If it is absent, use file validation or a supported profile connection, or have the organization's normal software-management process install the approved prerequisite.

Microsoft documents that ODBC Driver 18.6 and earlier require the Microsoft Visual C++ Redistributable, while version 18.7 and later include the required runtime library. Confirm the exact target driver and operating-system support against Microsoft's current documentation before distribution:

- <https://learn.microsoft.com/en-us/sql/connect/odbc/download-odbc-driver-for-sql-server>
- <https://learn.microsoft.com/en-us/sql/connect/odbc/windows/system-requirements-installation-and-driver-files>

## Excel reports

After a completed run, **Download Excel (aggregate)** exports the retained results
without rerunning validation or opening source data. Source-row values and joined
evidence are removed. The server writes a complete workbook under the current
user's temporary directory, streams it to the browser, and removes it after the
download, disconnect, or shutdown. Only one Excel download is active at a time.

Browsers with a streaming save picker write directly to the destination you choose.
Other browsers use a bounded 64 MiB download fallback; larger downloads require
desktop VS Code or the CLI. Pick a folder writable by your normal account.

Saved review packages can also be exported offline:

```powershell
.\validation-runner-0.27.0-win-x64.exe export --source .\validation-review.json --out .\report.xlsx
```

The CLI refuses to replace an existing destination unless `--force` is supplied.
Detailed evidence requires `--include-details` and can only include detail that
the saved package retained; it cannot restore removed evidence. See
[scalable Excel exports](SCALABLE-EXCEL-EXPORT.md) for limits and memory behavior.

## Scope and limitations

- This is a Windows executable and is not portable to macOS or Linux. Build a separate SEA on each target operating system and architecture if those targets are added later.
- The repository does not sign this artifact. Apply the organization's separate signing process before distribution when policy requires it.
- File-based CSV validation, SQL Server profile connections, and the native `msnodesqlv8` runtime for Windows integrated authentication are bundled. The native add-on and its support files are extracted to a private per-process temporary directory and removed on normal exit. Packaging verifies that the add-on loads; connected Windows-auth database acceptance must still be performed in the target environment.
- The browser interface listens only on the local loopback adapter and uses a per-process bearer token. It is not a network service and must not be exposed through port forwarding or a reverse proxy.
- The validation definition and source data are runtime inputs; they are not embedded in the executable.
- Review-package comparisons are deliberately indeterminate when a definition depends on unresolved baseline sidecars, child contracts, or rule-pack bindings. The runner does not claim definition equivalence from a path reference alone.
- Node describes SEA as active development. Build and smoke-test release artifacts with the same approved Node version rather than assuming artifacts from different Node releases are byte-identical.

The implementation follows the Node.js single-executable application workflow documented at <https://nodejs.org/api/single-executable-applications.html>.

Windows execution-level behavior is documented at <https://learn.microsoft.com/en-us/windows/win32/sbscs/application-manifests>.

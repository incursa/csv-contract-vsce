# Marketplace release runbook

## Prerequisites

- Node.js 22 or newer
- An authenticated GitHub CLI session for GitHub release work
- A Visual Studio Marketplace personal access token in the process environment as `VSCE_PAT` only when publishing

Never commit a Marketplace token or pass it as a literal command-line argument.

## Verify and package

```powershell
npm ci
npm run release:check
```

This produces `csv-contract-vsce.vsix`.

## Local install

```powershell
code --install-extension .\csv-contract-vsce.vsix --force
```

## Publish through the wrapper

```powershell
$env:VSCE_PAT = '<set securely for this process>'
.\scripts\Publish-Extension.ps1 -Marketplace
Remove-Item Env:\VSCE_PAT
```

Without `-Marketplace`, the script only verifies and packages.

## Tag release

1. Update `CHANGELOG.md` and the version in `package.json`.
2. Run `npm run release:check`.
3. Commit the version change.
4. Create and push a tag such as `v0.1.0`.
5. The release workflow builds a VSIX and attaches it to a GitHub release.
6. If the private repository has a `VSCE_PAT` Actions secret, the workflow also publishes to Marketplace.

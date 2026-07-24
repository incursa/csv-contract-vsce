[CmdletBinding()]
param(
    [switch] $Marketplace,
    [switch] $SkipTests
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $repoRoot
try {
    if (-not $SkipTests) {
        & npm run test:all
        if ($LASTEXITCODE -ne 0) { throw "Validation failed." }
    }

    & npm run package:vsix
    if ($LASTEXITCODE -ne 0) { throw "VSIX packaging failed." }

    if ($Marketplace) {
        if ([string]::IsNullOrWhiteSpace($env:VSCE_PAT)) {
            throw "Set VSCE_PAT in the process environment before Marketplace publishing."
        }
        & npx vsce publish --pat $env:VSCE_PAT
        if ($LASTEXITCODE -ne 0) { throw "Marketplace publishing failed." }
    }
}
finally {
    Pop-Location
}

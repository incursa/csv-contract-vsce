[CmdletBinding()]
param(
    [switch] $Marketplace,
    [switch] $SkipTests
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $repoRoot
try {
    if ($Marketplace) {
        & node (Join-Path $repoRoot 'scripts/publication-hold.mjs')
        if ($LASTEXITCODE -ne 0) {
            throw "Marketplace publishing is blocked by the commercialization publication hold."
        }
    }

    if (-not $SkipTests) {
        & npm run test:all
        if ($LASTEXITCODE -ne 0) { throw "Validation failed." }
    }

    & npm run package:vsix
    if ($LASTEXITCODE -ne 0) { throw "VSIX packaging failed." }
}
finally {
    Pop-Location
}

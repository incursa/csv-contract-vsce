[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string] $Csv,

    [Parameter(Mandatory)]
    [string] $Output,

    [string] $NodeExecutable = 'node'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$cliPath = Join-Path $repoRoot 'dist\cli\csv-contract.cjs'
if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) {
    throw "CLI bundle not found at '$cliPath'. Run 'npm run build:production' first."
}

& $NodeExecutable $cliPath init --csv (Resolve-Path -LiteralPath $Csv).Path --out $Output
exit $LASTEXITCODE

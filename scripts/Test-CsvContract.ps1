[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string] $Csv,

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string[]] $Contract,

    [ValidateSet('text', 'json')]
    [string] $Format = 'text',

    [string] $NodeExecutable = 'node'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$cliPath = Join-Path $repoRoot 'dist\cli\csv-contract.cjs'

if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) {
    throw "CLI bundle not found at '$cliPath'. Run 'npm run build:production' first."
}

$arguments = @($cliPath, 'test', '--csv', (Resolve-Path -LiteralPath $Csv).Path)
foreach ($spec in $Contract) {
    if (-not (Test-Path -LiteralPath $spec -PathType Leaf)) {
        throw "Contract not found: $spec"
    }
    $arguments += @('--spec', (Resolve-Path -LiteralPath $spec).Path)
}
$arguments += @('--format', $Format)

& $NodeExecutable @arguments
exit $LASTEXITCODE

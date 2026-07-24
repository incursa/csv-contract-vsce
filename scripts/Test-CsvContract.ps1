[CmdletBinding()]
param(
    [Parameter(Mandatory, Position = 0)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string] $Csv,

    [Parameter(Mandatory, Position = 1, ValueFromRemainingArguments)]
    [ValidateNotNullOrEmpty()]
    [string[]] $Contract,

    [ValidateSet('text', 'json')]
    [string] $Format = 'text',

    [ValidateRange(1, 1000000)]
    [int] $MaxIssues = 1000,

    [ValidateRange(0, 2147483647)]
    [int] $ProgressInterval = 250000,

    [ValidateRange(8, 1024)]
    [int] $UniquePartitions = 128,

    [string] $TempDirectory,

    [string] $NodeExecutable = 'node'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$cliPath = Join-Path $repoRoot 'dist\cli\csv-contract.cjs'

if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) {
    throw "CLI bundle not found at '$cliPath'. Run 'npm run build:production' first."
}

$nodeCommand = Get-Command -Name $NodeExecutable -CommandType Application -ErrorAction Stop
$arguments = @(
    $cliPath,
    'test',
    '--csv', (Resolve-Path -LiteralPath $Csv).Path,
    '--format', $Format,
    '--max-issues', [string]$MaxIssues,
    '--progress-interval', [string]$ProgressInterval,
    '--unique-partitions', [string]$UniquePartitions
)

foreach ($spec in $Contract) {
    if (-not (Test-Path -LiteralPath $spec -PathType Leaf)) {
        throw "Contract not found: $spec"
    }
    $arguments += @('--spec', (Resolve-Path -LiteralPath $spec).Path)
}

if (-not [string]::IsNullOrWhiteSpace($TempDirectory)) {
    if (-not (Test-Path -LiteralPath $TempDirectory -PathType Container)) {
        New-Item -ItemType Directory -Path $TempDirectory -Force | Out-Null
    }
    $arguments += @('--temp-directory', (Resolve-Path -LiteralPath $TempDirectory).Path)
}

& $nodeCommand.Source @arguments
exit $LASTEXITCODE

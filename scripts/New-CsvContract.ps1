[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string] $Csv,

    [Parameter(Mandatory)]
    [string] $Output,

    [ValidateRange(1, 10000000)]
    [int] $SampleRows = 10000,

    [switch] $InferConstraints,

    [switch] $NoSampleTests,

    [switch] $Force,

    [string] $NodeExecutable = 'node'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$cliPath = Join-Path $repoRoot 'dist\cli\csv-contract.cjs'
if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) {
    throw "CLI bundle not found at '$cliPath'. Run 'npm run build:production' first."
}

$nodeCommand = Get-Command -Name $NodeExecutable -CommandType Application -ErrorAction Stop
$outputPath = [System.IO.Path]::GetFullPath($Output)
if ((Test-Path -LiteralPath $outputPath) -and -not $Force) {
    throw "Output already exists: $outputPath. Use -Force to replace it."
}
$outputDirectory = Split-Path -Parent $outputPath
if (-not (Test-Path -LiteralPath $outputDirectory -PathType Container)) {
    New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
}

$arguments = @(
    $cliPath,
    'init',
    '--csv', (Resolve-Path -LiteralPath $Csv).Path,
    '--out', $outputPath,
    '--sample-rows', [string]$SampleRows
)
if ($InferConstraints) { $arguments += '--infer-constraints' }
if ($NoSampleTests) { $arguments += '--no-sample-tests' }

& $nodeCommand.Source @arguments
exit $LASTEXITCODE

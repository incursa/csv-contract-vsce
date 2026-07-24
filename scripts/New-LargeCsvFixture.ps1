[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string] $Output,

    [ValidateRange(1, 100000000)]
    [long] $Rows = 100000,

    [ValidateRange(5, 10000)]
    [int] $Columns = 100,

    [switch] $Force,

    [string] $NodeExecutable = 'node'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$generator = Join-Path $PSScriptRoot 'generate-large-csv.mjs'
$nodeCommand = @(Get-Command -Name $NodeExecutable -CommandType Application -ErrorAction Stop)[0]
$outputPath = [System.IO.Path]::GetFullPath($Output)
if ((Test-Path -LiteralPath $outputPath) -and -not $Force) {
    throw "Output already exists: $outputPath. Use -Force to replace it."
}

& $nodeCommand.Source $generator --out $outputPath --rows ([string]$Rows) --columns ([string]$Columns)
if ($LASTEXITCODE -ne 0) {
    throw "Large CSV generation failed with exit code $LASTEXITCODE."
}
Get-Item -LiteralPath $outputPath

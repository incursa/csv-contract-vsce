[CmdletBinding()]
param(
    [ValidateRange(1, 100000000)]
    [long] $Rows = 100000,

    [ValidateRange(5, 10000)]
    [int] $Columns = 100,

    [ValidateRange(0, 86400)]
    [int] $MaxSeconds = 0,

    [string] $OutputDirectory,

    [switch] $KeepCsv,

    [string] $NodeExecutable = 'node'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $repoRoot 'artifacts\performance'
}
$outputRoot = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
$csvPath = Join-Path $outputRoot ("benchmark-{0}-rows-{1}-cols.csv" -f $Rows, $Columns)
$contractPath = Join-Path $repoRoot 'test\fixtures\powershell\contracts\performance.csvtest.yaml'
$generator = Join-Path $PSScriptRoot 'New-LargeCsvFixture.ps1'
$testScript = Join-Path $PSScriptRoot 'Test-CsvContract.ps1'
$nodeCommand = @(Get-Command -Name $NodeExecutable -CommandType Application -ErrorAction Stop)[0]
$hostExecutable = (Get-Process -Id $PID).Path
$errorFile = Join-Path $outputRoot 'benchmark.stderr.txt'

try {
    & $generator -Output $csvPath -Rows $Rows -Columns $Columns -Force -NodeExecutable $nodeCommand.Source | Out-Null
    $progressInterval = [Math]::Max(10000, [Math]::Floor($Rows / 10))
    $arguments = @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', $testScript,
        '-Csv', $csvPath,
        '-Contract', $contractPath,
        '-Format', 'json',
        '-MaxIssues', '100',
        '-ProgressInterval', [string]$progressInterval,
        '-UniquePartitions', '128',
        '-TempDirectory', (Join-Path $outputRoot 'unique-temp'),
        '-NodeExecutable', $nodeCommand.Source
    )
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $standardOutput = & $hostExecutable @arguments 2> $errorFile | Out-String
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($exitCode -ne 0) {
        $stderr = if (Test-Path -LiteralPath $errorFile) { Get-Content -Raw -LiteralPath $errorFile } else { '' }
        throw "Benchmark validation failed with exit code $exitCode. $stderr"
    }
    $result = $standardOutput | ConvertFrom-Json
    $csvBytes = (Get-Item -LiteralPath $csvPath).Length
    $seconds = [double]$result.performance.durationMs / 1000
    $report = [ordered]@{
        generatedAtUtc = [DateTime]::UtcNow.ToString('o')
        node = (& $nodeCommand.Source --version)
        powershell = [string]$PSVersionTable.PSVersion
        rows = [long]$Rows
        columns = $Columns
        csvBytes = $csvBytes
        durationSeconds = [Math]::Round($seconds, 3)
        rowsPerSecond = [long]$result.performance.rowsPerSecond
        mebibytesPerSecond = if ($seconds -gt 0) { [Math]::Round(($csvBytes / 1MB) / $seconds, 2) } else { 0 }
        maxRssMiB = [Math]::Round(([double]$result.performance.maxRssBytes / 1MB), 2)
        passes = [int]$result.performance.passes
        valid = [bool]$result.valid
    }
    $reportPath = Join-Path $outputRoot 'latest.json'
    $report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $reportPath -Encoding UTF8
    $report | Format-List
    Write-Host "Performance report: $reportPath"
    if ($MaxSeconds -gt 0 -and $seconds -gt $MaxSeconds) {
        throw "Benchmark took $([Math]::Round($seconds, 2)) seconds, exceeding MaxSeconds=$MaxSeconds."
    }
}
finally {
    if (-not $KeepCsv -and (Test-Path -LiteralPath $csvPath)) {
        Remove-Item -LiteralPath $csvPath -Force
    }
    $uniqueTemp = Join-Path $outputRoot 'unique-temp'
    if (Test-Path -LiteralPath $uniqueTemp) {
        Remove-Item -LiteralPath $uniqueTemp -Recurse -Force
    }
}

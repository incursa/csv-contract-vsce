[CmdletBinding()]
param(
    [string] $NodeExecutable = 'node',
    [switch] $KeepTemporaryFiles
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$fixtureRoot = Join-Path $repoRoot 'test\fixtures\powershell'
$manifestPath = Join-Path $fixtureRoot 'manifest.json'
$testScript = Join-Path $PSScriptRoot 'Test-CsvContract.ps1'
$newScript = Join-Path $PSScriptRoot 'New-CsvContract.ps1'
$cliPath = Join-Path $repoRoot 'dist\cli\csv-contract.cjs'

if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) {
    throw "CLI bundle not found. Run 'npm run build:production' before the PowerShell suite."
}

$nodeCommand = @(Get-Command -Name $NodeExecutable -CommandType Application -ErrorAction Stop)[0]
$hostExecutable = (Get-Process -Id $PID).Path
$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('csv-contract-powershell-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temporaryRoot -Force | Out-Null
$failures = New-Object System.Collections.Generic.List[string]
$passes = 0

function Invoke-ChildPowerShell {
    param(
        [Parameter(Mandatory)]
        [string[]] $Arguments,
        [Parameter(Mandatory)]
        [string] $ErrorFile
    )

    $previousPreference = $null
    $previousErrorActionPreference = $ErrorActionPreference
    if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
        $previousPreference = $PSNativeCommandUseErrorActionPreference
        $PSNativeCommandUseErrorActionPreference = $false
    }
    try {
        $ErrorActionPreference = 'Continue'
        $standardOutput = & $hostExecutable @Arguments 2> $ErrorFile | Out-String
        return [pscustomobject]@{
            ExitCode = $LASTEXITCODE
            StandardOutput = $standardOutput
            StandardError = if (Test-Path -LiteralPath $ErrorFile) { Get-Content -Raw -LiteralPath $ErrorFile } else { '' }
        }
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
        if ($null -ne $previousPreference) {
            $PSNativeCommandUseErrorActionPreference = $previousPreference
        }
    }
}

function ConvertTo-PowerShellLiteral {
    param([Parameter(Mandatory)][string] $Value)
    return "'" + $Value.Replace("'", "''") + "'"
}

try {
    $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    $caseNumber = 0
    foreach ($case in $manifest) {
        $caseNumber += 1
        $errorFile = Join-Path $temporaryRoot ("case-{0:D2}.stderr.txt" -f $caseNumber)
        $csvPath = Join-Path $fixtureRoot $case.csv
        $contractPaths = @($case.contracts | ForEach-Object { Join-Path $fixtureRoot $_ })
        $contractLiterals = @($contractPaths | ForEach-Object { ConvertTo-PowerShellLiteral $_ })
        $commandText = @(
            '& ' + (ConvertTo-PowerShellLiteral $testScript),
            '-Csv ' + (ConvertTo-PowerShellLiteral $csvPath),
            '-Contract @(' + ($contractLiterals -join ', ') + ')',
            '-Format json',
            '-MaxIssues 100',
            '-ProgressInterval 0',
            '-UniquePartitions 8',
            '-TempDirectory ' + (ConvertTo-PowerShellLiteral (Join-Path $temporaryRoot 'unique')),
            '-NodeExecutable ' + (ConvertTo-PowerShellLiteral $nodeCommand.Source),
            '; exit $LASTEXITCODE'
        ) -join ' '
        $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($commandText))
        $arguments = @('-NoProfile', '-EncodedCommand', $encodedCommand)
        $invocation = Invoke-ChildPowerShell -Arguments $arguments -ErrorFile $errorFile
        $problems = New-Object System.Collections.Generic.List[string]
        if ($invocation.ExitCode -ne [int]$case.expectedExit) {
            $problems.Add("exit $($invocation.ExitCode), expected $($case.expectedExit)")
        }
        $json = $null
        try {
            $json = $invocation.StandardOutput | ConvertFrom-Json
        }
        catch {
            $problems.Add("stdout was not valid JSON: $($_.Exception.Message)")
        }
        if ($null -ne $json) {
            $expectedValid = [int]$case.expectedExit -eq 0
            if ([bool]$json.valid -ne $expectedValid) {
                $problems.Add("valid=$($json.valid), expected $expectedValid")
            }
            $actualCodes = @($json.runs | ForEach-Object { @($_.result.issues) | ForEach-Object { $_.code } })
            foreach ($expectedCode in @($case.expectedCodes)) {
                if ($actualCodes -notcontains $expectedCode) {
                    $problems.Add("missing diagnostic $expectedCode (actual: $($actualCodes -join ', '))")
                }
            }
            if ($null -ne $case.expectedPasses -and [int]$json.performance.passes -ne [int]$case.expectedPasses) {
                $problems.Add("streaming passes=$($json.performance.passes), expected $($case.expectedPasses)")
            }
        }
        if ($problems.Count -eq 0) {
            $passes += 1
            Write-Host ("PASS [{0:D2}] {1}" -f $caseNumber, $case.name) -ForegroundColor Green
        }
        else {
            $failures.Add(("[{0:D2}] {1}: {2}`nSTDERR: {3}" -f $caseNumber, $case.name, ($problems -join '; '), $invocation.StandardError.Trim()))
            Write-Host ("FAIL [{0:D2}] {1}" -f $caseNumber, $case.name) -ForegroundColor Red
        }
    }

    $generatedPath = Join-Path $temporaryRoot 'generated.csvtest.yaml'
    $generationError = Join-Path $temporaryRoot 'generator.stderr.txt'
    $generationArguments = @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', $newScript,
        '-Csv', (Join-Path $fixtureRoot 'csv\pass.csv'),
        '-Output', $generatedPath,
        '-SampleRows', '2',
        '-NodeExecutable', $nodeCommand.Source
    )
    $generation = Invoke-ChildPowerShell -Arguments $generationArguments -ErrorFile $generationError
    if ($generation.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $generatedPath)) {
        $failures.Add("generator did not create an outline: exit $($generation.ExitCode), $($generation.StandardError.Trim())")
    }
    else {
        $generatedText = Get-Content -Raw -LiteralPath $generatedPath
        foreach ($expectedText in @('Company:', 'EmployeeId:', 'sample-row-exists', 'sample-cell-value')) {
            if ($generatedText -notmatch [regex]::Escape($expectedText)) {
                $failures.Add("generated outline is missing '$expectedText'")
            }
        }
        $validationError = Join-Path $temporaryRoot 'generated-validation.stderr.txt'
        $validationArguments = @(
            '-NoProfile',
            '-ExecutionPolicy', 'Bypass',
            '-File', $testScript,
            '-Csv', (Join-Path $fixtureRoot 'csv\pass.csv'),
            '-Contract', $generatedPath,
            '-Format', 'json',
            '-ProgressInterval', '0',
            '-UniquePartitions', '8',
            '-NodeExecutable', $nodeCommand.Source
        )
        $validation = Invoke-ChildPowerShell -Arguments $validationArguments -ErrorFile $validationError
        if ($validation.ExitCode -ne 0) {
            $failures.Add("generated outline did not validate its source CSV: $($validation.StandardError.Trim())")
        }
        else {
            $passes += 1
            Write-Host 'PASS [GEN] outline generation and validation' -ForegroundColor Green
        }
        $overwrite = Invoke-ChildPowerShell -Arguments $generationArguments -ErrorFile (Join-Path $temporaryRoot 'overwrite.stderr.txt')
        if ($overwrite.ExitCode -eq 0) {
            $failures.Add('generator overwrote an existing contract without -Force')
        }
        else {
            $passes += 1
            Write-Host 'PASS [GEN] safe overwrite refusal' -ForegroundColor Green
        }
    }

    if ($failures.Count -gt 0) {
        Write-Host ''
        $failures | ForEach-Object { Write-Host $_ -ForegroundColor Red }
        throw "PowerShell suite failed: $($failures.Count) failure(s), $passes pass(es)."
    }
    Write-Host ''
    Write-Host "PowerShell suite passed: $passes checks under $($PSVersionTable.PSEdition) $($PSVersionTable.PSVersion)." -ForegroundColor Green
}
finally {
    if ($KeepTemporaryFiles) {
        Write-Host "Temporary files retained at $temporaryRoot"
    }
    elseif (Test-Path -LiteralPath $temporaryRoot) {
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
    }
}

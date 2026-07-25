# Copyright 2026 Samuel McAravey
# Organizational owner and maintainer: Incursa
# SPDX-License-Identifier: Apache-2.0

[CmdletBinding()]
param(
    [string] $PowerShellToolsRoot = (Join-Path (Split-Path -Parent $PSScriptRoot) '..\powershell-tools')
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).ProviderPath
$sourceScript = Join-Path $PowerShellToolsRoot 'Tools\Compare-CsvSemantic.ps1'
if (-not (Test-Path -LiteralPath $sourceScript -PathType Leaf)) {
    Write-Host "Semantic parity source is not present; TypeScript fixture expectations remain covered by npm test."
    exit 0
}

$sourceScript = (Resolve-Path -LiteralPath $sourceScript).ProviderPath
$fixtureRoot = Join-Path $repositoryRoot 'test\fixtures\semantic'
$manifest = Get-Content -LiteralPath (Join-Path $fixtureRoot 'manifest.json') -Raw | ConvertFrom-Json
$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("csv-contract-parity-" + [guid]::NewGuid().ToString('N'))
[System.IO.Directory]::CreateDirectory($temporaryRoot) | Out-Null
$resolvedTemporaryRoot = (Resolve-Path -LiteralPath $temporaryRoot).ProviderPath
if (-not $resolvedTemporaryRoot.StartsWith([System.IO.Path]::GetTempPath(), [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to use unexpected temporary path '$resolvedTemporaryRoot'."
}

try {
    foreach ($case in $manifest.cases) {
        $output = Join-Path $resolvedTemporaryRoot $case.name
        $arguments = @(
            '-NoProfile', '-File', $sourceScript,
            '-LeftPath', (Join-Path $fixtureRoot $case.left),
            '-RightPath', (Join-Path $fixtureRoot $case.right),
            '-OutputDirectory', $output,
            '-ComparisonName', $case.name,
            '-NoProgress'
        )
        if ($case.options.PSObject.Properties['keyColumns'] -and $case.options.keyColumns) { $arguments += @('-KeyColumns') + @($case.options.keyColumns) }
        if ($case.options.PSObject.Properties['ignoredColumns'] -and $case.options.ignoredColumns) { $arguments += @('-IgnoreColumns') + @($case.options.ignoredColumns) }
        $normalization = if ($case.options.PSObject.Properties['normalization']) { $case.options.normalization } else { $null }
        if ($null -ne $normalization -and $normalization.PSObject.Properties['trim'] -and $normalization.trim) { $arguments += '-TrimValues' }
        if ($null -ne $normalization -and $normalization.PSObject.Properties['caseFold'] -and $normalization.caseFold) { $arguments += '-CaseInsensitive' }
        if ($null -ne $normalization -and $normalization.PSObject.Properties['blankNullEquivalent'] -and $normalization.blankNullEquivalent) { $arguments += '-TreatBlankAsNull' }
        if ($null -ne $normalization -and $normalization.PSObject.Properties['dateColumns'] -and $normalization.dateColumns) { $arguments += @('-DateColumns') + @($normalization.dateColumns) }
        if ($null -ne $normalization -and $normalization.PSObject.Properties['decimalColumns'] -and $normalization.decimalColumns) { $arguments += @('-DecimalColumns') + @($normalization.decimalColumns) }

        & pwsh @arguments
        $actualExitCode = $LASTEXITCODE
        if ($actualExitCode -ne [int] $case.exitCode) {
            throw "Parity case '$($case.name)' returned $actualExitCode; expected $($case.exitCode)."
        }
        if ([int] $case.exitCode -eq 2) {
            Write-Host "PASS $($case.name)"
            continue
        }
        $summary = Get-Content -LiteralPath (Join-Path $output 'ComparisonSummary.json') -Raw | ConvertFrom-Json
        if ($case.PSObject.Properties['removed'] -and [long] $summary.differences.rowsOnlyInLeft -ne [long] $case.removed) {
            throw "Parity case '$($case.name)' removed-row count differs."
        }
        if ($case.PSObject.Properties['changed'] -and [long] $summary.differences.changedKeys -ne [long] $case.changed) {
            throw "Parity case '$($case.name)' changed-key count differs."
        }
        if ($case.PSObject.Properties['duplicateKeysLeft'] -and [long] $summary.differences.duplicateKeysLeft -ne [long] $case.duplicateKeysLeft) {
            throw "Parity case '$($case.name)' duplicate-key count differs."
        }
        Write-Host "PASS $($case.name)"
    }
}
finally {
    if (Test-Path -LiteralPath $resolvedTemporaryRoot -PathType Container) {
        Remove-Item -LiteralPath $resolvedTemporaryRoot -Recurse -Force
    }
}

Write-Host "Semantic comparison fixtures agree with Compare-CsvSemantic.ps1."

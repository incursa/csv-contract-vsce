#!/usr/bin/env pwsh
[CmdletBinding()]
param(
    [string]$WorkerUser = 'samuel',
    [switch]$RunTests,
    [switch]$VerifyOnly,
    [switch]$SkipCodexUpdate
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$configPath = Join-Path $PSScriptRoot 'worker.json'
$config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
$workerEntry = (& getent passwd $WorkerUser 2>$null | Out-String).Trim()
if ([string]::IsNullOrWhiteSpace($workerEntry)) { throw "Worker user '$WorkerUser' does not exist." }
$workerHome = $workerEntry.Split(':')[5]
$workerPath = "$workerHome/.local/bin:$workerHome/bin:/usr/local/bin:/usr/bin:/bin"
$playwrightPath = [string]$config.dependencies.playwright.browserPath
$env:PLAYWRIGHT_BROWSERS_PATH = $playwrightPath
$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'

function Invoke-Checked {
    param(
        [Parameter(Mandatory)][string]$File,
        [string[]]$Arguments = @(),
        [switch]$AsWorker,
        [switch]$AsRoot,
        [string]$WorkingDirectory = $repositoryRoot
    )

    $currentUser = (& id -un | Out-String).Trim()
    $command = $File
    $commandArguments = $Arguments
    if ($AsWorker -and $currentUser -ne $WorkerUser) {
        if ((& id -u | Out-String).Trim() -ne '0') { throw "Root is required to run commands as '$WorkerUser'." }
        $command = 'runuser'
        $commandArguments = @('-u', $WorkerUser, '--', 'env', "HOME=$workerHome", "PATH=$workerPath", "PLAYWRIGHT_BROWSERS_PATH=$playwrightPath", 'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1', $File) + $Arguments
    }
    elseif ($AsRoot -and ((& id -u | Out-String).Trim() -ne '0')) {
        if (-not (Get-Command sudo -ErrorAction SilentlyContinue)) { throw 'Root privileges are required.' }
        $command = 'sudo'
        $commandArguments = @($File) + $Arguments
    }

    Push-Location -LiteralPath $WorkingDirectory
    try {
        & $command @commandArguments
        if ($LASTEXITCODE -ne 0) { throw "Command failed with exit code $LASTEXITCODE`: $File $($Arguments -join ' ')" }
    }
    finally { Pop-Location }
}

function Test-WorkerCommand([string]$Name) {
    $probe = "command -v -- '$Name' >/dev/null 2>&1"
    $currentUser = (& id -un | Out-String).Trim()
    if ($currentUser -eq $WorkerUser) {
        & env "HOME=$workerHome" "PATH=$workerPath" sh -lc $probe
    }
    elseif ((& id -u | Out-String).Trim() -eq '0') {
        & runuser -u $WorkerUser -- env "HOME=$workerHome" "PATH=$workerPath" sh -lc $probe
    }
    else { return $false }
    return $LASTEXITCODE -eq 0
}

function Get-NodeMajor {
    if (-not (Test-WorkerCommand 'node')) { return 0 }
    $value = (& env "PATH=$workerPath" node --version 2>$null | Out-String).Trim().TrimStart('v')
    $major = 0
    [void][int]::TryParse(($value -split '\.')[0], [ref]$major)
    return $major
}

function Install-Node22 {
    $temporary = Join-Path ([IO.Path]::GetTempPath()) "csv-contract-node-$([Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $temporary | Out-Null
    try {
        $releaseBase = 'https://nodejs.org/dist/latest-v22.x'
        $sums = Join-Path $temporary 'SHASUMS256.txt'
        Invoke-Checked curl @('--fail', '--silent', '--show-error', '--location', "$releaseBase/SHASUMS256.txt", '--output', $sums) -AsRoot -WorkingDirectory $temporary
        $match = Select-String -Path $sums -Pattern '^([0-9a-f]{64})  (node-v22\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz)$'
        if (@($match).Count -ne 1) { throw 'Could not resolve one official Node.js 22 amd64 archive.' }
        $expected, $archiveName = $match.Matches[0].Groups[1].Value, $match.Matches[0].Groups[2].Value
        $archive = Join-Path $temporary $archiveName
        Invoke-Checked curl @('--fail', '--silent', '--show-error', '--location', "$releaseBase/$archiveName", '--output', $archive) -AsRoot -WorkingDirectory $temporary
        $actual = ((& sha256sum $archive) -split '\s+')[0]
        if ($actual -ne $expected) { throw 'Node.js archive SHA-256 verification failed.' }
        $version = $archiveName -replace '-linux-x64\.tar\.xz$', ''
        $destination = "/opt/node/$version"
        if (-not (Test-Path -LiteralPath $destination)) {
            $extract = "/opt/node/.extract-$([Guid]::NewGuid().ToString('N'))"
            Invoke-Checked mkdir @('-p', '/opt/node', $extract) -AsRoot -WorkingDirectory $temporary
            Invoke-Checked tar @('-xJf', $archive, '-C', $extract, '--strip-components=1') -AsRoot -WorkingDirectory $temporary
            Invoke-Checked mv @('--', $extract, $destination) -AsRoot -WorkingDirectory $temporary
        }
        foreach ($name in @('node', 'npm', 'npx', 'corepack')) {
            Invoke-Checked ln @('-sfn', "$destination/bin/$name", "/usr/local/bin/$name") -AsRoot -WorkingDirectory $temporary
        }
    }
    finally { Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue }
}

$os = @{}
foreach ($line in Get-Content /etc/os-release) {
    if ($line -match '^(?<key>[A-Z0-9_]+)=(?<value>.*)$') { $os[$Matches.key] = $Matches.value.Trim().Trim('"').Trim("'") }
}
if ($os.ID -ne 'debian' -or ([string]$os.VERSION_ID).Split('.')[0] -ne '13') { throw 'This worker contract requires Debian 13.' }
if ([int]$config.schemaVersion -ne 1) { throw "Unsupported worker schemaVersion '$($config.schemaVersion)'." }

if (-not $VerifyOnly) {
    Invoke-Checked apt-get @('update') -AsRoot
    Invoke-Checked apt-get (@('install', '-y', '--no-install-recommends') + @($config.dependencies.aptPackages)) -AsRoot
    if ((Get-NodeMajor) -lt [int]$config.dependencies.node.minimumMajorVersion) { Install-Node22 }
    Invoke-Checked npm @('ci') -AsWorker
    Invoke-Checked env @('-u', 'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD', "PLAYWRIGHT_BROWSERS_PATH=$playwrightPath", 'npx', 'playwright', 'install', '--with-deps', [string]$config.dependencies.playwright.browser) -AsRoot
    Invoke-Checked chmod @('-R', 'a+rX', $playwrightPath) -AsRoot

    $codexInstalled = Test-WorkerCommand 'codex'
    if (-not $codexInstalled -or (-not $SkipCodexUpdate -and [bool]$config.dependencies.codexCli.updateOnBootstrap)) {
        $installer = Join-Path ([IO.Path]::GetTempPath()) "codex-install-$([Guid]::NewGuid().ToString('N')).sh"
        try {
            Invoke-Checked curl @('--fail', '--silent', '--show-error', '--location', 'https://chatgpt.com/codex/install.sh', '--output', $installer) -AsRoot
            Invoke-Checked chmod @('0755', $installer) -AsRoot
            Invoke-Checked sh @($installer) -AsWorker
        }
        finally { Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue }
    }
}

foreach ($tool in @($config.dependencies.requiredCommands)) {
    if (-not (Test-WorkerCommand ([string]$tool.file))) { throw "Required command '$($tool.file)' is unavailable for '$WorkerUser'." }
    Invoke-Checked ([string]$tool.file) @($tool.versionArgs | ForEach-Object { [string]$_ }) -AsWorker
}
if ((Get-NodeMajor) -lt [int]$config.dependencies.node.minimumMajorVersion) { throw 'The installed Node.js runtime is too old.' }
if (-not (Test-Path -LiteralPath $playwrightPath)) { throw "Playwright browser path is missing: $playwrightPath" }

if ($RunTests) { Invoke-Checked npm @('run', 'test:all') -AsWorker }

try {
    Invoke-Checked codex @('login', 'status') -AsWorker
    Write-Host 'CODEX_WORKER_STATUS=ready'
}
catch {
    Write-Host 'CODEX_WORKER_STATUS=ready-needs-codex-auth'
}

[CmdletBinding(SupportsShouldProcess)]
param(
    [ValidateNotNullOrEmpty()]
    [string] $OutputDirectory = 'C:\shared\incursa\Clients\mastec\07_Tickets\__unsorted',

    [PSCredential] $Credential,

    [switch] $Force,

    [switch] $DryRun
)

$ErrorActionPreference = 'Stop'

$tickets = @(
    'MTZ-33371'
    'MTZ-25322'
    'MTZ-30553'
    'MTZ-33373'
    'MTZ-25836'
    'MTZ-33374'
    'MTZ-25837'
    'MTZ-33545'
    'MTZ-25834'
    'MTZ-33443'
    'MTZ-29785'
    'MTZ-33541'
    'MTZ-25833'
    'MTZ-33444'
    'MTZ-29603'
)

if (-not (Test-Path -LiteralPath $OutputDirectory -PathType Container)) {
    New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
}

$resolvedOutputDirectory = (Resolve-Path -LiteralPath $OutputDirectory).Path

if (-not $DryRun -and -not $Credential) {
    $Credential = Get-Credential -Message 'Enter your Atlassian email and API token.'
}

$requestHeaders = @{}
if ($Credential) {
    $networkCredential = $Credential.GetNetworkCredential()
    $basicCredentials = '{0}:{1}' -f $networkCredential.UserName, $networkCredential.Password
    $encodedCredentials = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($basicCredentials))
    $requestHeaders['Authorization'] = "Basic $encodedCredentials"
}

foreach ($ticket in $tickets) {
    $url = "https://mastec.atlassian.net/si/jira.issueviews:issue-html/$ticket/$ticket.html"
    $outputPath = Join-Path $resolvedOutputDirectory "$ticket.html"

    if ((Test-Path -LiteralPath $outputPath -PathType Leaf) -and -not $Force) {
        Write-Host "Skipping existing file: $outputPath"
        continue
    }

    if ($DryRun) {
        Write-Host "Would download $url to $outputPath"
        continue
    }

    if ($PSCmdlet.ShouldProcess($outputPath, "Download $ticket from Jira")) {
        try {
            $response = Invoke-WebRequest -Uri $url -Headers $requestHeaders -MaximumRedirection 0
        }
        catch {
            if ($_.Exception.Message -match '302|redirect') {
                throw "Jira redirected the request for $ticket to login. The API token may be invalid, or this Jira site may require SSO/browser authentication."
            }
            throw
        }
        if ($response.StatusCode -ne 200 -or [string]::IsNullOrWhiteSpace($response.Content)) {
            throw "Jira did not return issue HTML for $ticket (HTTP $($response.StatusCode)). Check your Atlassian credentials and permissions."
        }
        [System.IO.File]::WriteAllText($outputPath, $response.Content)
        Write-Host "Downloaded $ticket to $outputPath"
    }
}
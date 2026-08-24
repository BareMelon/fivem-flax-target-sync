[CmdletBinding()]
param(
    [string]$ServiceUrl = $env:FIVEM_AUDITOR_SERVICE_URL,
    [string]$ResourceName = "flaxhosting_filer",
    [string]$CsvPath = (Join-Path $PSScriptRoot "..\danish_fivem_servers.csv"),
    [string]$NodePath = "node",
    [string]$NpmPath = "npm",
    [switch]$SkipPush,
    [switch]$AllowEmpty
)

$ErrorActionPreference = "Stop"

$scannerPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "scanner.cjs"))
$pushScriptPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "Push-Targets.ps1"))
$csvFullPath = [IO.Path]::GetFullPath($CsvPath)
$csvDirectory = Split-Path -Parent $csvFullPath
$stagingName = ".fivem-targets-$([Guid]::NewGuid().ToString('N')).staging.csv"
$stagingPath = [IO.Path]::GetFullPath((Join-Path $csvDirectory $stagingName))
$logPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "sync-targets.log"))

function Write-SyncLog {
    param([string]$Message)
    $timestamp = (Get-Date).ToString("o")
    Add-Content -LiteralPath $logPath -Value "$timestamp $Message" -Encoding UTF8
}

try {
    if (-not (Test-Path -LiteralPath $scannerPath -PathType Leaf)) {
        throw "Scanner not found: $scannerPath"
    }
    if (-not $SkipPush) {
        if (-not $ServiceUrl) {
            throw "Set FIVEM_AUDITOR_SERVICE_URL or pass -ServiceUrl."
        }
        if (-not $env:FIVEM_AUDITOR_ADMIN_KEY) {
            throw "Set FIVEM_AUDITOR_ADMIN_KEY before synchronizing targets."
        }
        if (-not (Test-Path -LiteralPath $pushScriptPath -PathType Leaf)) {
            throw "Push helper not found: $pushScriptPath"
        }
    }

    New-Item -ItemType Directory -Path $csvDirectory -Force | Out-Null

    $dependencyMarker = Join-Path $PSScriptRoot "node_modules\protobufjs\package.json"
    if (-not (Test-Path -LiteralPath $dependencyMarker -PathType Leaf)) {
        Write-Host "Installing the scanner dependency..."
        & $NpmPath ci --no-audit --no-fund --prefix $PSScriptRoot
        if ($LASTEXITCODE -ne 0) {
            throw "npm ci failed with exit code $LASTEXITCODE."
        }
    }

    Write-Host "Scanning Danish FiveM listings for exact resource: $ResourceName"
    & $NodePath $scannerPath `
        --resource $ResourceName `
        --output $stagingPath
    $scannerExitCode = $LASTEXITCODE
    if ($scannerExitCode -ne 0) {
        throw "The scanner failed with exit code $scannerExitCode."
    }
    if (-not (Test-Path -LiteralPath $stagingPath -PathType Leaf)) {
        throw "The scanner did not produce a staging CSV."
    }

    $header = (Get-Content -LiteralPath $stagingPath -TotalCount 1).TrimStart([char]0xFEFF)
    if ($header -ne "name,endpoint") {
        throw "Unexpected CSV header: $header"
    }

    $rows = @(Import-Csv -LiteralPath $stagingPath)
    $seenEndpoints = @{}
    foreach ($row in $rows) {
        $name = ([string]$row.name).Trim()
        $endpoint = ([string]$row.endpoint).Trim()
        if (-not $name -or -not $endpoint) {
            throw "Every generated CSV row must contain name and endpoint."
        }
        if ($endpoint -notmatch '^https?://') {
            throw "Unexpected endpoint format: $endpoint"
        }
        $endpointKey = $endpoint.ToLowerInvariant()
        if ($seenEndpoints.ContainsKey($endpointKey)) {
            throw "Duplicate generated endpoint: $endpoint"
        }
        $seenEndpoints[$endpointKey] = $true
    }

    if (-not $SkipPush -and $rows.Count -eq 0 -and -not $AllowEmpty) {
        throw "The verified result contains zero targets. Pass -AllowEmpty only when clearing stale inventory is intended."
    }

    if (-not $SkipPush) {
        & $pushScriptPath `
            -CsvPath $stagingPath `
            -ServiceUrl $ServiceUrl `
            -Confirm REPLACE_AUTHORIZED_TARGETS `
            -AllowEmpty:$AllowEmpty
    }

    Move-Item -LiteralPath $stagingPath -Destination $csvFullPath -Force
    Write-SyncLog "SUCCESS targets=$($rows.Count) resource=$ResourceName pushed=$(-not $SkipPush)"
    Write-Host "Synchronization completed with $($rows.Count) target(s)."
}
catch {
    Write-SyncLog "FAILED resource=$ResourceName message=$($_.Exception.Message)"
    throw
}
finally {
    if (Test-Path -LiteralPath $stagingPath -PathType Leaf) {
        Remove-Item -LiteralPath $stagingPath -Force
    }
}

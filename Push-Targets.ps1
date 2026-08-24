param(
    [Parameter(Mandatory = $true)]
    [string]$CsvPath,

    [Parameter(Mandatory = $true)]
    [string]$ServiceUrl,

    [string]$Confirm = "",

    [switch]$AllowEmpty
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $CsvPath -PathType Leaf)) {
    throw "CSV inventory not found: $CsvPath"
}
if (-not $env:FIVEM_AUDITOR_ADMIN_KEY) {
    throw "Set FIVEM_AUDITOR_ADMIN_KEY before updating the inventory."
}
if ($Confirm -ne "REPLACE_AUTHORIZED_TARGETS") {
    throw "Inventory replacement requires: -Confirm REPLACE_AUTHORIZED_TARGETS"
}

$rows = @(Import-Csv -LiteralPath $CsvPath)
if ($rows.Count -eq 0 -and -not $AllowEmpty) {
    throw "The CSV contains no server rows. Pass -AllowEmpty only when clearing stale inventory is intended."
}
if ($rows.Count -gt 1617) {
    throw "The Free-plan endpoint accepts at most 1617 rows per inventory."
}

$endpoints = @{}
$servers = foreach ($row in $rows) {
    $name = ([string]$row.name).Trim()
    $endpoint = ([string]$row.endpoint).Trim()
    if (-not $name -or -not $endpoint) {
        throw "Every CSV row must contain name and endpoint."
    }
    $endpointKey = $endpoint.ToLowerInvariant()
    if ($endpoints.ContainsKey($endpointKey)) {
        throw "Duplicate endpoint: $endpoint"
    }
    $endpoints[$endpointKey] = $true
    [PSCustomObject]@{
        name = $name
        endpoint = $endpoint
    }
}

$payload = @{ servers = @($servers) } | ConvertTo-Json -Depth 4
$headers = @{ Authorization = "Bearer $env:FIVEM_AUDITOR_ADMIN_KEY" }
if ($rows.Count -eq 0) {
    $headers["X-Confirm-Empty-Inventory"] = "REPLACE_WITH_EMPTY"
}
$uri = $ServiceUrl.TrimEnd("/") + "/api/v1/targets"
$result = Invoke-RestMethod `
    -Method Put `
    -Uri $uri `
    -Headers $headers `
    -ContentType "application/json" `
    -Body $payload

if (-not $result.updated -or [int]$result.count -ne $rows.Count) {
    throw "The management service did not confirm the complete replacement."
}

Write-Host "Inventory replaced with $($result.count) authorized server targets."

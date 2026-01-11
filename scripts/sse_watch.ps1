param(
    [string]$BaseUrl = "http://127.0.0.1:8001",
    [Parameter(Mandatory = $true)][string]$JobId
)

$ErrorActionPreference = "Stop"
$BaseUrl = $BaseUrl.TrimEnd('/')

$uri = "$BaseUrl/jobs/$JobId/events"
Write-Host "Connecting SSE: $uri"

curl.exe -N "$uri"

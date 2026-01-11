param(
    [string]$BaseUrl = "http://127.0.0.1:8001",
    [string]$OutDir = "artifacts",
    [int]$BackendStartTimeoutSeconds = 30,
    [switch]$KeepBackendRunning
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$BaseUrl = $BaseUrl.Trim().TrimEnd('/')

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$outDirAbs = (Resolve-Path -LiteralPath $OutDir).Path

function Save-Text($text, $path) {
    $text | Set-Content -Encoding utf8 -Path $path
}

function Assert($cond, $msg) {
    if (-not $cond) {
        throw "ASSERT FAILED: $msg"
    }
}

function Parse-JsonOrNull($text) {
    try {
        if (-not $text) { return $null }
        return ($text | ConvertFrom-Json)
    } catch {
        return $null
    }
}

function Normalize-Uri($uri) {
    $u = [string]$uri
    if (-not [System.Uri]::IsWellFormedUriString($u, [System.UriKind]::Absolute)) {
        throw "Invalid URI: '$u'"
    }
    return $u
}

function Invoke-Http($method, $uri, $bodyJson) {
    $u = Normalize-Uri $uri

    $iwrHasBasic = $false
    try {
        $iwrHasBasic = (Get-Command Invoke-WebRequest).Parameters.ContainsKey(
            "UseBasicParsing"
        )
    } catch {
        $iwrHasBasic = $false
    }

    $params = @{ Method = $method; Uri = $u }
    if ($iwrHasBasic) {
        $params["UseBasicParsing"] = $true
    }

    if ($bodyJson) {
        $params["ContentType"] = "application/json"
        $params["Body"] = $bodyJson
    }

    try {
        $resp = Invoke-WebRequest @params
        return @{
            StatusCode = [int]$resp.StatusCode
            Content = [string]$resp.Content
        }
    } catch {
        $err = $_
        $content = ""

        if ($err.ErrorDetails -and $err.ErrorDetails.Message) {
            $content = [string]$err.ErrorDetails.Message
        }

        $ex = $err.Exception
        if ($ex -is [System.Net.WebException] -and $ex.Response) {
            $r = $ex.Response
            $status = [int]$r.StatusCode

            if (-not $content) {
                try {
                    $stream = $r.GetResponseStream()
                    if ($stream) {
                        $sr = New-Object System.IO.StreamReader $stream
                        try {
                            $content = $sr.ReadToEnd()
                        } finally {
                            $sr.Dispose()
                        }
                    }
                } catch {
                }
            }

            return @{
                StatusCode = $status
                Content = [string]$content
            }
        }

        throw
    }
}

function Expect-ErrorDetail($label, $resp, $expectedStatus, $expectedDetail) {
    Assert ($resp.StatusCode -eq $expectedStatus) "$label expected status=$expectedStatus got=$($resp.StatusCode)"
    $json = Parse-JsonOrNull $resp.Content
    if ($null -eq $json) {
        $snippet = ([string]$resp.Content)
        if ($snippet.Length -gt 300) { $snippet = $snippet.Substring(0, 300) + "..." }
        throw "ASSERT FAILED: $label expected JSON error body but got: '$snippet'"
    }
    Assert ("$($json.detail)" -eq $expectedDetail) "$label expected detail=$expectedDetail got=$($json.detail)"
}

function Wait-Health($timeoutSeconds) {
    $deadline = (Get-Date).AddSeconds($timeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $resp = Invoke-Http "GET" "$BaseUrl/health" $null
            if ($resp.StatusCode -eq 200) {
                $json = Parse-JsonOrNull $resp.Content
                if ($json -and "$($json.status)" -eq "ok") {
                    return $json
                }
            }
        } catch {
        }
        Start-Sleep -Milliseconds 200
    }
    throw "Timeout waiting for /health"
}

function Start-Backend($label, $enableCloudSummary) {
    $uri = [System.Uri]$BaseUrl
    $bindHost = $uri.Host
    $port = $uri.Port

    $env:KMP_DUPLICATE_LIB_OK = "TRUE"

    $root = $PSScriptRoot
    if (-not $root) {
        $root = Split-Path -Parent $MyInvocation.MyCommand.Path
    }
    if (-not $root) {
        $root = (Get-Location).Path
    }
    $backend = Join-Path $root "..\backend"

    $stdout = Join-Path $OutDir "cloud_toggle_backend_${label}_stdout.log"
    $stderr = Join-Path $OutDir "cloud_toggle_backend_${label}_stderr.log"

    $oldEnable = $env:ENABLE_CLOUD_SUMMARY
    $oldKey = $env:DASHSCOPE_API_KEY

    if ($enableCloudSummary) {
        $env:ENABLE_CLOUD_SUMMARY = "1"
        $env:DASHSCOPE_API_KEY = ""
    } else {
        $env:ENABLE_CLOUD_SUMMARY = "0"
        $env:DASHSCOPE_API_KEY = ""
    }

    try {
        $args = @(
            "-m", "uvicorn",
            "app.main:app",
            "--host", $bindHost,
            "--port", $port
        )

        $spArgs = @{
            FilePath = "python"
            ArgumentList = $args
            WorkingDirectory = $backend
            RedirectStandardOutput = $stdout
            RedirectStandardError = $stderr
            PassThru = $true
        }

        return Start-Process @spArgs
    } finally {
        $env:ENABLE_CLOUD_SUMMARY = $oldEnable
        $env:DASHSCOPE_API_KEY = $oldKey
    }
}

function Stop-Backend($proc) {
    if ($null -eq $proc) {
        return
    }
    try {
        if (-not $proc.HasExited) {
            Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        }
    } catch {
    }
    try {
        Wait-Process -Id $proc.Id -Timeout 10 -ErrorAction SilentlyContinue
    } catch {
    }
}

Write-Host "BaseUrl: $BaseUrl"
Write-Host "OutDir: $outDirAbs"

# Ensure no backend is currently running at BaseUrl, to avoid killing unknown processes.
try {
    $existing = $null
    try {
        $existingResp = Invoke-Http "GET" "$BaseUrl/health" $null
        if ($existingResp.StatusCode -eq 200) {
            $existing = Parse-JsonOrNull $existingResp.Content
        }
    } catch {
        $existing = $null
    }

    if ($null -ne $existing -and "$($existing.status)" -eq "ok") {
        throw "Backend already running at $BaseUrl. Please stop it first, or use a different -BaseUrl port for this test."
    }

    $p0 = $null
    $p1 = $null

    # ----------------------
    # Case 1: ENABLE_CLOUD_SUMMARY=0
    # ----------------------
    $p0 = Start-Backend "disabled" $false
    Write-Host "Backend started (cloud disabled) pid=$($p0.Id)"
    $health0 = Wait-Health $BackendStartTimeoutSeconds
    Save-Text ($health0 | ConvertTo-Json -Depth 10) (Join-Path $OutDir "cloud_toggle_health_disabled.json")
    Assert ([bool]$health0.cloud_summary_default -eq $false) "health.cloud_summary_default must be false when disabled"

    $body = @{ text = "this is a sufficiently long text for summary"; confirm_send = $false } | ConvertTo-Json -Compress
    $resp = Invoke-Http "POST" "$BaseUrl/summaries/cloud" $body
    Save-Text $resp.Content (Join-Path $OutDir "cloud_toggle_disabled_confirm_required.json")
    Expect-ErrorDetail "disabled confirm required" $resp 400 "CONFIRM_SEND_REQUIRED"

    $body = @{ text = "this is a sufficiently long text for summary"; confirm_send = $true } | ConvertTo-Json -Compress
    $resp = Invoke-Http "POST" "$BaseUrl/summaries/cloud" $body
    Save-Text $resp.Content (Join-Path $OutDir "cloud_toggle_disabled_cloud_disabled.json")
    Expect-ErrorDetail "disabled cloud" $resp 400 "CLOUD_SUMMARY_DISABLED"

    Stop-Backend $p0
    $p0 = $null

    # ----------------------
    # Case 2: ENABLE_CLOUD_SUMMARY=1 but no key
    # ----------------------
    $p1 = Start-Backend "enabled" $true
    Write-Host "Backend started (cloud enabled) pid=$($p1.Id)"
    $health1 = Wait-Health $BackendStartTimeoutSeconds
    Save-Text ($health1 | ConvertTo-Json -Depth 10) (Join-Path $OutDir "cloud_toggle_health_enabled.json")
    Assert ([bool]$health1.cloud_summary_default -eq $true) "health.cloud_summary_default must be true when enabled"

    $body = @{ text = "this is a sufficiently long text for summary"; confirm_send = $false } | ConvertTo-Json -Compress
    $resp = Invoke-Http "POST" "$BaseUrl/summaries/cloud" $body
    Save-Text $resp.Content (Join-Path $OutDir "cloud_toggle_enabled_confirm_required.json")
    Expect-ErrorDetail "enabled confirm required" $resp 400 "CONFIRM_SEND_REQUIRED"

    $body = @{ text = "this is a sufficiently long text for summary"; confirm_send = $true } | ConvertTo-Json -Compress
    $resp = Invoke-Http "POST" "$BaseUrl/summaries/cloud" $body
    Save-Text $resp.Content (Join-Path $OutDir "cloud_toggle_enabled_missing_key.json")
    Expect-ErrorDetail "enabled missing key" $resp 400 "MISSING_DASHSCOPE_API_KEY"

    $body = @{ text = "short"; confirm_send = $true; api_key = "dummy" } | ConvertTo-Json -Compress
    $resp = Invoke-Http "POST" "$BaseUrl/summaries/cloud" $body
    Save-Text $resp.Content (Join-Path $OutDir "cloud_toggle_enabled_text_too_short.json")
    Expect-ErrorDetail "enabled text too short" $resp 400 "TEXT_TOO_SHORT"

    if (-not $KeepBackendRunning) {
        Stop-Backend $p1
        $p1 = $null
    }

    Write-Host "OK"
} finally {
    if (-not $KeepBackendRunning) {
        try { Stop-Backend $p0 } catch { }
        try { Stop-Backend $p1 } catch { }
    }
}

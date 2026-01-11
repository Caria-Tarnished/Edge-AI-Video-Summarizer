param(
    [string]$BaseUrl = "http://127.0.0.1:8001",
    [Parameter(Mandatory = $true)][string]$VideoPath,
    [string]$OutDir = "artifacts",
    [int]$TimeoutSeconds = 60,
    [switch]$AllowSubtitleWhenNoTranscript
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$BaseUrl = $BaseUrl.Trim().TrimEnd('/')

if (-not (Test-Path -LiteralPath $VideoPath)) {
    throw "VideoPath not found: $VideoPath"
}
$resolvedVideoPath = (Resolve-Path -LiteralPath $VideoPath).Path

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$outDirAbs = (Resolve-Path -LiteralPath $OutDir).Path

function Save-Text($text, $path) {
    $text | Set-Content -Encoding utf8 -Path $path
}

function Save-Json($obj, $path) {
    $obj | ConvertTo-Json -Depth 50 | Set-Content -Encoding utf8 -Path $path
}

function Assert($cond, $msg) {
    if (-not $cond) {
        throw "ASSERT FAILED: $msg"
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
                    # ignore stream read errors; we'll return what we have
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

function Parse-JsonOrNull($text) {
    try {
        if (-not $text) { return $null }
        return ($text | ConvertFrom-Json)
    } catch {
        return $null
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

function Expect-Status($label, $resp, $expectedStatus) {
    Assert ($resp.StatusCode -eq $expectedStatus) "$label expected status=$expectedStatus got=$($resp.StatusCode)"
}

Write-Host "BaseUrl: $BaseUrl"
Write-Host "VideoPath: $resolvedVideoPath"
Write-Host "OutDir: $outDirAbs"

# ----------------------
# Sanity: /health
# ----------------------
$healthResp = Invoke-Http "GET" "$BaseUrl/health" $null
Save-Text $healthResp.Content (Join-Path $OutDir "export_error_health.json")
Expect-Status "health" $healthResp 200
$health = Parse-JsonOrNull $healthResp.Content
Assert ("$($health.status)" -eq "ok") "health.status != ok"

# ----------------------
# /videos/import FILE_NOT_FOUND
# ----------------------
$badPath = Join-Path $env:TEMP ("__edge_no_such__\\{0}.mp4" -f [guid]::NewGuid().ToString())
$body = @{ file_path = $badPath } | ConvertTo-Json -Compress
$resp = Invoke-Http "POST" "$BaseUrl/videos/import" $body
Save-Text $resp.Content (Join-Path $OutDir "export_error_import_file_not_found.json")
Expect-ErrorDetail "videos/import file not found" $resp 400 "FILE_NOT_FOUND"

# ----------------------
# /videos/{id} VIDEO_NOT_FOUND
# ----------------------
$fakeVideoId = [guid]::NewGuid().ToString()
$resp = Invoke-Http "GET" "$BaseUrl/videos/$fakeVideoId" $null
Save-Text $resp.Content (Join-Path $OutDir "export_error_get_video_not_found.json")
Expect-ErrorDetail "get video not found" $resp 404 "VIDEO_NOT_FOUND"

# Import a real video (may be reused by hash)
$body = @{ file_path = $resolvedVideoPath } | ConvertTo-Json -Compress
$importResp = Invoke-Http "POST" "$BaseUrl/videos/import" $body
Save-Text $importResp.Content (Join-Path $OutDir "export_error_import_primary.json")
Expect-Status "videos/import" $importResp 200
$import = Parse-JsonOrNull $importResp.Content
Assert ($import -and $import.id) "videos/import missing id"
$videoId = [string]$import.id
Write-Host "Imported video_id: $videoId"

# ----------------------
# /videos/{id}/subtitles/{fmt} UNSUPPORTED_SUBTITLE_FORMAT
# ----------------------
$resp = Invoke-Http "GET" "$BaseUrl/videos/$videoId/subtitles/ass" $null
Save-Text $resp.Content (Join-Path $OutDir "export_error_subtitles_unsupported.json")
Expect-ErrorDetail "unsupported subtitle fmt" $resp 400 "UNSUPPORTED_SUBTITLE_FORMAT"

# ----------------------
# /jobs/{id} JOB_NOT_FOUND
# ----------------------
$fakeJobId = [guid]::NewGuid().ToString()
$resp = Invoke-Http "GET" "$BaseUrl/jobs/$fakeJobId" $null
Save-Text $resp.Content (Join-Path $OutDir "export_error_get_job_not_found.json")
Expect-ErrorDetail "get job not found" $resp 404 "JOB_NOT_FOUND"

# /jobs/{id}/cancel JOB_NOT_FOUND
$resp = Invoke-Http "POST" "$BaseUrl/jobs/$fakeJobId/cancel" $null
Save-Text $resp.Content (Join-Path $OutDir "export_error_cancel_job_not_found.json")
Expect-ErrorDetail "cancel job not found" $resp 404 "JOB_NOT_FOUND"

# /jobs/{id}/retry JOB_NOT_FOUND
$body = @{ from_scratch = $false } | ConvertTo-Json -Compress
$resp = Invoke-Http "POST" "$BaseUrl/jobs/$fakeJobId/retry" $body
Save-Text $resp.Content (Join-Path $OutDir "export_error_retry_job_not_found.json")
Expect-ErrorDetail "retry job not found" $resp 404 "JOB_NOT_FOUND"

# /jobs/transcribe VIDEO_NOT_FOUND
$body = @{ video_id = $fakeVideoId; segment_seconds = 60 } | ConvertTo-Json -Compress
$resp = Invoke-Http "POST" "$BaseUrl/jobs/transcribe" $body
Save-Text $resp.Content (Join-Path $OutDir "export_error_create_job_video_not_found.json")
Expect-ErrorDetail "create job video not found" $resp 404 "VIDEO_NOT_FOUND"

# ----------------------
# Job state errors: JOB_NOT_RETRIABLE / JOB_NOT_CANCELLABLE
# ----------------------
$body = @{ video_id = $videoId; segment_seconds = 60; from_scratch = $true } | ConvertTo-Json -Compress
$createJobResp = Invoke-Http "POST" "$BaseUrl/jobs/transcribe" $body
Save-Text $createJobResp.Content (Join-Path $OutDir "export_error_job_created.json")
Expect-Status "create job" $createJobResp 200
$job = Parse-JsonOrNull $createJobResp.Content
Assert ($job -and $job.id) "create job missing id"
$jobId = [string]$job.id
Write-Host "Created job_id: $jobId"

# retry while pending/running -> JOB_NOT_RETRIABLE
$body = @{ from_scratch = $false } | ConvertTo-Json -Compress
$resp = Invoke-Http "POST" "$BaseUrl/jobs/$jobId/retry" $body
Save-Text $resp.Content (Join-Path $OutDir "export_error_retry_not_retriable.json")
Expect-ErrorDetail "retry not retriable" $resp 400 "JOB_NOT_RETRIABLE"

# cancel should succeed
$resp = Invoke-Http "POST" "$BaseUrl/jobs/$jobId/cancel" $null
Save-Text $resp.Content (Join-Path $OutDir "export_error_cancel_ok.json")
Expect-Status "cancel ok" $resp 200
$cancelObj = Parse-JsonOrNull $resp.Content
Assert ("$($cancelObj.status)" -eq "cancelled") "cancel ok expected status=cancelled"

# cancel again -> JOB_NOT_CANCELLABLE
$resp = Invoke-Http "POST" "$BaseUrl/jobs/$jobId/cancel" $null
Save-Text $resp.Content (Join-Path $OutDir "export_error_cancel_not_cancellable.json")
Expect-ErrorDetail "cancel not cancellable" $resp 400 "JOB_NOT_CANCELLABLE"

# retry after cancelled should succeed (reset)
$body = @{ from_scratch = $false } | ConvertTo-Json -Compress
$resp = Invoke-Http "POST" "$BaseUrl/jobs/$jobId/retry" $body
Save-Text $resp.Content (Join-Path $OutDir "export_error_retry_ok.json")
Expect-Status "retry ok" $resp 200
$retryObj = Parse-JsonOrNull $resp.Content
Assert ("$($retryObj.status)" -eq "pending") "retry ok expected status=pending"

# ----------------------
# Export when no transcript exists (new video variant)
# ----------------------
$tmpDir = Join-Path $outDirAbs "tmp_videos"
New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
$dst = Join-Path $tmpDir "no_transcript_variant.mp4"
Copy-Item -LiteralPath $resolvedVideoPath -Destination $dst -Force
$b = [byte](Get-Random -Minimum 0 -Maximum 256)
$fs = [System.IO.File]::Open(
    $dst,
    [System.IO.FileMode]::Append,
    [System.IO.FileAccess]::Write,
    [System.IO.FileShare]::Read
)
try {
    $fs.WriteByte($b)
} finally {
    $fs.Dispose()
}
$dstAbs = (Resolve-Path -LiteralPath $dst).Path
$body = @{ file_path = $dstAbs } | ConvertTo-Json -Compress
$importResp = Invoke-Http "POST" "$BaseUrl/videos/import" $body
Save-Text $importResp.Content (Join-Path $OutDir "export_error_import_no_transcript_video.json")
Expect-Status "import no transcript variant" $importResp 200
$v2 = Parse-JsonOrNull $importResp.Content
Assert ($v2 -and $v2.id) "import variant missing id"
$videoNoTxId = [string]$v2.id
Write-Host "Imported no-transcript video_id: $videoNoTxId"

$txResp = Invoke-Http "GET" "$BaseUrl/videos/$videoNoTxId/transcript" $null
Save-Text $txResp.Content (Join-Path $OutDir "export_error_transcript_no_transcript_video.json")
Expect-Status "get transcript" $txResp 200

if ($AllowSubtitleWhenNoTranscript) {
    $resp = Invoke-Http "GET" "$BaseUrl/videos/$videoNoTxId/subtitles/vtt" $null
    Save-Text $resp.Content (Join-Path $OutDir "export_error_subtitles_no_transcript_allow.vtt")
    Expect-Status "subtitles vtt no transcript (allow)" $resp 200
} else {
    $resp = Invoke-Http "GET" "$BaseUrl/videos/$videoNoTxId/subtitles/vtt" $null
    Save-Text $resp.Content (Join-Path $OutDir "export_error_subtitles_no_transcript_vtt_error.json")
    Expect-ErrorDetail "subtitles vtt requires transcript" $resp 404 "TRANSCRIPT_NOT_FOUND"
}

# ----------------------
# /summaries/cloud CONFIRM_SEND_REQUIRED
# ----------------------
$body = @{ text = "hello"; confirm_send = $false } | ConvertTo-Json -Compress
$resp = Invoke-Http "POST" "$BaseUrl/summaries/cloud" $body
Save-Text $resp.Content (Join-Path $OutDir "export_error_cloud_confirm_required.json")
Expect-ErrorDetail "cloud confirm required" $resp 400 "CONFIRM_SEND_REQUIRED"

Write-Host "OK"

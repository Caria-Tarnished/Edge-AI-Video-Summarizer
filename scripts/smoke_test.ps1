param(
    [string]$BaseUrl = "http://127.0.0.1:8001",
    [Parameter(Mandatory = $true)][string]$VideoPath,
    [int]$SegmentSeconds = 0,
    [int]$OverlapSeconds = 0,
    [switch]$FromScratch,
    [switch]$AutoSse,
    [switch]$AutoWs,
    [int]$PollIntervalMs = 500,
    [int]$TimeoutSeconds = 1800,
    [string]$OutDir = "artifacts"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$BaseUrl = $BaseUrl.TrimEnd('/')

if (-not (Test-Path -LiteralPath $VideoPath)) {
    throw "VideoPath not found: $VideoPath"
}

$resolvedVideoPath = (Resolve-Path -LiteralPath $VideoPath).Path

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

Write-Host "BaseUrl: $BaseUrl"
Write-Host "VideoPath: $resolvedVideoPath"

$health = Invoke-RestMethod -Method Get -Uri "$BaseUrl/health"
Write-Host "Health: $($health.status)"

$importBody = @{ file_path = $resolvedVideoPath } | ConvertTo-Json -Compress
$video = Invoke-RestMethod -Method Post -Uri "$BaseUrl/videos/import" -ContentType "application/json" -Body $importBody
$videoId = $video.id
Write-Host "Imported video_id: $videoId"

$jobReq = @{ video_id = $videoId }
if ($SegmentSeconds -gt 0) {
    $jobReq.segment_seconds = $SegmentSeconds
}
if ($OverlapSeconds -gt 0) {
    $jobReq.overlap_seconds = $OverlapSeconds
}
if ($FromScratch) {
    $jobReq.from_scratch = $true
}

$jobBody = $jobReq | ConvertTo-Json -Compress
$job = Invoke-RestMethod -Method Post -Uri "$BaseUrl/jobs/transcribe" -ContentType "application/json" -Body $jobBody
$jobId = $job.id
Write-Host "Created job_id: $jobId"
Write-Host "SSE: curl.exe -N $BaseUrl/jobs/$jobId/events"
Write-Host "WS:  node .\\scripts\\ws_watch.js $jobId ws://127.0.0.1:8001"

if ($AutoSse) {
    $root = Split-Path -Parent $MyInvocation.MyCommand.Path
    $sse = Join-Path $root "sse_watch.ps1"
    Start-Process powershell -ArgumentList @(
        "-NoExit",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        $sse,
        "-BaseUrl",
        $BaseUrl,
        "-JobId",
        $jobId
    ) | Out-Null
}

if ($AutoWs) {
    $root = Split-Path -Parent $MyInvocation.MyCommand.Path
    $ws = Join-Path $root "ws_watch.ps1"
    $wsBase = $BaseUrl -replace "^http", "ws"
    Start-Process powershell -ArgumentList @(
        "-NoExit",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        $ws,
        "-JobId",
        $jobId,
        "-WsBase",
        $wsBase
    ) | Out-Null
}

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$final = $null

while ($true) {
    if ((Get-Date) -gt $deadline) {
        throw "Timeout waiting for job completion (job_id=$jobId)"
    }

    $j = Invoke-RestMethod -Method Get -Uri "$BaseUrl/jobs/$jobId"
    $status = "$($j.status)"
    $progress = $j.progress
    $message = "$($j.message)"

    Write-Host ("{0} status={1} progress={2} message={3}" -f (Get-Date).ToString("HH:mm:ss"), $status, $progress, $message)

    if ($status -in @("completed", "failed", "cancelled")) {
        $final = $j
        break
    }

    Start-Sleep -Milliseconds $PollIntervalMs
}

$finalPath = Join-Path $OutDir "job_$jobId.json"
$final | ConvertTo-Json -Depth 50 | Set-Content -Encoding utf8 -Path $finalPath
Write-Host "Saved: $finalPath"

if ($final.status -ne "completed") {
    Write-Host "Job not completed. status=$($final.status)"
    exit 1
}

$transcript = Invoke-RestMethod -Method Get -Uri "$BaseUrl/videos/$videoId/transcript"
$transcriptPath = Join-Path $OutDir "transcript_$videoId.json"
$transcript | ConvertTo-Json -Depth 50 | Set-Content -Encoding utf8 -Path $transcriptPath
Write-Host "Saved: $transcriptPath"

$iwrHasBasic = $false
try {
    $iwrHasBasic = (Get-Command Invoke-WebRequest).Parameters.ContainsKey(
        "UseBasicParsing"
    )
} catch {
    $iwrHasBasic = $false
}

$iwrArgs = @{ Method = "Get"; Uri = "$BaseUrl/videos/$videoId/subtitles/vtt" }
if ($iwrHasBasic) {
    $iwrArgs["UseBasicParsing"] = $true
}
$vtt = (Invoke-WebRequest @iwrArgs).Content
$vttPath = Join-Path $OutDir "subtitles_$videoId.vtt"
$vtt | Set-Content -Encoding utf8 -Path $vttPath
Write-Host "Saved: $vttPath"

$iwrArgs = @{ Method = "Get"; Uri = "$BaseUrl/videos/$videoId/subtitles/srt" }
if ($iwrHasBasic) {
    $iwrArgs["UseBasicParsing"] = $true
}
$srt = (Invoke-WebRequest @iwrArgs).Content
$srtPath = Join-Path $OutDir "subtitles_$videoId.srt"
$srt | Set-Content -Encoding utf8 -Path $srtPath
Write-Host "Saved: $srtPath"

Write-Host "OK"

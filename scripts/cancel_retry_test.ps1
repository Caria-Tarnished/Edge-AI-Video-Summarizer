param(
    [string]$BaseUrl = "http://127.0.0.1:8001",
    [Parameter(Mandatory = $true)][string]$VideoPath,
    [int]$SegmentSeconds = 60,
    [int]$OverlapSeconds = 0,
    [switch]$FromScratch,
    [switch]$RetryFromScratch,
    [int]$PollIntervalMs = 200,
    [int]$TimeoutSeconds = 1800,
    [int]$WaitRunningTimeoutSeconds = 60,
    [int]$CancelConfirmTimeoutSeconds = 30,
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

function Save-Json($obj, $path) {
    $obj | ConvertTo-Json -Depth 50 | Set-Content -Encoding utf8 -Path $path
}

function Get-Job($jobId) {
    return Invoke-RestMethod -Method Get -Uri "$BaseUrl/jobs/$jobId"
}

function Wait-JobStatus($jobId, $desired, $timeoutSeconds) {
    $deadline = (Get-Date).AddSeconds($timeoutSeconds)
    while ($true) {
        if ((Get-Date) -gt $deadline) {
            throw "Timeout waiting for status '$desired' (job_id=$jobId)"
        }
        $j = Get-Job $jobId
        $status = "$($j.status)"
        $progress = $j.progress
        $message = "$($j.message)"
        Write-Host ("{0} status={1} progress={2} message={3}" -f (Get-Date).ToString("HH:mm:ss"), $status, $progress, $message)
        if ($status -eq $desired) {
            return $j
        }
        if ($status -in @("failed", "completed", "cancelled") -and $status -ne $desired) {
            return $j
        }
        Start-Sleep -Milliseconds $PollIntervalMs
    }
}

function Wait-JobTerminal($jobId, $timeoutSeconds) {
    $deadline = (Get-Date).AddSeconds($timeoutSeconds)
    while ($true) {
        if ((Get-Date) -gt $deadline) {
            throw "Timeout waiting for terminal status (job_id=$jobId)"
        }
        $j = Get-Job $jobId
        $status = "$($j.status)"
        $progress = $j.progress
        $message = "$($j.message)"
        Write-Host ("{0} status={1} progress={2} message={3}" -f (Get-Date).ToString("HH:mm:ss"), $status, $progress, $message)
        if ($status -in @("completed", "failed", "cancelled")) {
            return $j
        }
        Start-Sleep -Milliseconds $PollIntervalMs
    }
}

Write-Host "BaseUrl: $BaseUrl"
Write-Host "VideoPath: $resolvedVideoPath"

$health = Invoke-RestMethod -Method Get -Uri "$BaseUrl/health"
Write-Host "Health: $($health.status)"

$importBody = @{ file_path = $resolvedVideoPath } | ConvertTo-Json -Compress
$video = Invoke-RestMethod -Method Post -Uri "$BaseUrl/videos/import" -ContentType "application/json" -Body $importBody
$videoId = $video.id
Write-Host "Imported video_id: $videoId"

$jobReq = @{ video_id = $videoId }
if ($SegmentSeconds -gt 0) { $jobReq.segment_seconds = $SegmentSeconds }
if ($OverlapSeconds -gt 0) { $jobReq.overlap_seconds = $OverlapSeconds }
if ($FromScratch) { $jobReq.from_scratch = $true }

$jobBody = $jobReq | ConvertTo-Json -Compress
$job = Invoke-RestMethod -Method Post -Uri "$BaseUrl/jobs/transcribe" -ContentType "application/json" -Body $jobBody
$jobId = $job.id
Write-Host "Created job_id: $jobId"

$createdPath = Join-Path $OutDir "cancel_retry_created_$jobId.json"
Save-Json $job $createdPath
Write-Host "Saved: $createdPath"

Write-Host "Waiting for running..."
$jRunning = Wait-JobStatus $jobId "running" $WaitRunningTimeoutSeconds
$runningPath = Join-Path $OutDir "cancel_retry_running_$jobId.json"
Save-Json $jRunning $runningPath
Write-Host "Saved: $runningPath"

Write-Host "Cancelling..."
$cancel = Invoke-RestMethod -Method Post -Uri "$BaseUrl/jobs/$jobId/cancel"
$cancelPath = Join-Path $OutDir "cancel_retry_cancel_response_$jobId.json"
Save-Json $cancel $cancelPath
Write-Host "Saved: $cancelPath"

Write-Host "Confirm cancelled..."
$jCancelled = Wait-JobStatus $jobId "cancelled" $CancelConfirmTimeoutSeconds
$cancelledPath = Join-Path $OutDir "cancel_retry_cancelled_$jobId.json"
Save-Json $jCancelled $cancelledPath
Write-Host "Saved: $cancelledPath"

$videoAfterCancel = Invoke-RestMethod -Method Get -Uri "$BaseUrl/videos/$videoId"
$videoCancelPath = Join-Path $OutDir "cancel_retry_video_after_cancel_$videoId.json"
Save-Json $videoAfterCancel $videoCancelPath
Write-Host "Saved: $videoCancelPath"

Write-Host "Retrying (from_scratch=$($RetryFromScratch.IsPresent))..."
$retryBody = @{ from_scratch = [bool]$RetryFromScratch } | ConvertTo-Json -Compress
$retry = Invoke-RestMethod -Method Post -Uri "$BaseUrl/jobs/$jobId/retry" -ContentType "application/json" -Body $retryBody
$retryPath = Join-Path $OutDir "cancel_retry_retry_response_$jobId.json"
Save-Json $retry $retryPath
Write-Host "Saved: $retryPath"

Write-Host "Waiting job to finish after retry..."
$final = Wait-JobTerminal $jobId $TimeoutSeconds
$finalPath = Join-Path $OutDir "cancel_retry_final_$jobId.json"
Save-Json $final $finalPath
Write-Host "Saved: $finalPath"

if ($final.status -ne "completed") {
    Write-Host "Job not completed after retry. status=$($final.status)"
    exit 1
}

$transcript = Invoke-RestMethod -Method Get -Uri "$BaseUrl/videos/$videoId/transcript"
$transcriptPath = Join-Path $OutDir "cancel_retry_transcript_$videoId.json"
Save-Json $transcript $transcriptPath
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
if ($iwrHasBasic) { $iwrArgs["UseBasicParsing"] = $true }
$vtt = (Invoke-WebRequest @iwrArgs).Content
$vttPath = Join-Path $OutDir "cancel_retry_subtitles_$videoId.vtt"
$vtt | Set-Content -Encoding utf8 -Path $vttPath
Write-Host "Saved: $vttPath"

$iwrArgs = @{ Method = "Get"; Uri = "$BaseUrl/videos/$videoId/subtitles/srt" }
if ($iwrHasBasic) { $iwrArgs["UseBasicParsing"] = $true }
$srt = (Invoke-WebRequest @iwrArgs).Content
$srtPath = Join-Path $OutDir "cancel_retry_subtitles_$videoId.srt"
$srt | Set-Content -Encoding utf8 -Path $srtPath
Write-Host "Saved: $srtPath"

Write-Host "OK"

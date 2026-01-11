param(
    [string]$BaseUrl = "http://127.0.0.1:8001",
    [Parameter(Mandatory = $true)][string]$VideoPath,
    [int]$SegmentSeconds = 60,
    [int]$OverlapSeconds = 0,
    [switch]$FromScratch,
    [int]$PollIntervalMs = 200,
    [int]$TimeoutSeconds = 1800,
    [int]$WaitRunningTimeoutSeconds = 60,
    [int]$BackendStartTimeoutSeconds = 60,
    [int]$RestartGraceMs = 800,
    [string]$OutDir = "artifacts",
    [switch]$KeepBackendRunning
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

function Wait-Health($timeoutSeconds) {
    $deadline = (Get-Date).AddSeconds($timeoutSeconds)
    while ($true) {
        if ((Get-Date) -gt $deadline) {
            throw "Timeout waiting for backend health ($BaseUrl/health)"
        }
        try {
            $h = Invoke-RestMethod -Method Get -Uri "$BaseUrl/health"
            if ("$($h.status)" -eq "ok") {
                return $h
            }
        } catch {
        }
        Start-Sleep -Milliseconds 300
    }
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
        Write-Host (
            "{0} status={1} progress={2} message={3}" -f (Get-Date).ToString(
                "HH:mm:ss"
            ), $status, $progress, $message
        )
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
        Write-Host (
            "{0} status={1} progress={2} message={3}" -f (Get-Date).ToString(
                "HH:mm:ss"
            ), $status, $progress, $message
        )
        if ($status -in @("completed", "failed", "cancelled")) {
            return $j
        }
        Start-Sleep -Milliseconds $PollIntervalMs
    }
}

function Start-Backend($label) {
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

    $stdout = Join-Path $OutDir "restart_recovery_backend_${label}_stdout.log"
    $stderr = Join-Path $OutDir "restart_recovery_backend_${label}_stderr.log"

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
Write-Host "VideoPath: $resolvedVideoPath"

try {
    $existing = $null
    try {
        $existing = Invoke-RestMethod -Method Get -Uri "$BaseUrl/health"
    } catch {
        $existing = $null
    }
    if ($null -ne $existing -and "$($existing.status)" -eq "ok") {
        throw "Backend already running at $BaseUrl. Please stop it first, or use a different -BaseUrl port for this test."
    }

    $p1 = Start-Backend "run1"
    Write-Host "Backend started (run1) pid=$($p1.Id)"
    $health = Wait-Health $BackendStartTimeoutSeconds
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

    $createdPath = Join-Path $OutDir "restart_recovery_created_$jobId.json"
    Save-Json $job $createdPath
    Write-Host "Saved: $createdPath"

    Write-Host "Waiting for running (before restart)..."
    $jRunning1 = Wait-JobStatus $jobId "running" $WaitRunningTimeoutSeconds
    $running1Path = Join-Path $OutDir "restart_recovery_running_before_restart_$jobId.json"
    Save-Json $jRunning1 $running1Path
    Write-Host "Saved: $running1Path"

    $oldStartedAt = "$($jRunning1.started_at)"

    Write-Host "Killing backend to simulate crash/restart..."
    Stop-Backend $p1
    Start-Sleep -Milliseconds $RestartGraceMs

    $p2 = Start-Backend "run2"
    Write-Host "Backend started (run2) pid=$($p2.Id)"
    $health2 = Wait-Health $BackendStartTimeoutSeconds
    Write-Host "Health(after restart): $($health2.status)"

    $afterRestart = Get-Job $jobId
    $afterRestartPath = Join-Path $OutDir "restart_recovery_after_restart_$jobId.json"
    Save-Json $afterRestart $afterRestartPath
    Write-Host "Saved: $afterRestartPath"

    Write-Host "Waiting for running (after restart recovery)..."
    $jRunning2 = Wait-JobStatus $jobId "running" $WaitRunningTimeoutSeconds
    $running2Path = Join-Path $OutDir "restart_recovery_running_after_restart_$jobId.json"
    Save-Json $jRunning2 $running2Path
    Write-Host "Saved: $running2Path"

    Write-Host "Waiting job to finish after restart..."
    $final = Wait-JobTerminal $jobId $TimeoutSeconds
    $finalPath = Join-Path $OutDir "restart_recovery_final_$jobId.json"
    Save-Json $final $finalPath
    Write-Host "Saved: $finalPath"

    if ($final.status -ne "completed") {
        Write-Host "Job not completed. status=$($final.status)"
        exit 1
    }

    $newStartedAt = "$($final.started_at)"
    if ($oldStartedAt -and $newStartedAt -and $oldStartedAt -eq $newStartedAt) {
        throw "started_at did not change after restart (job_id=$jobId). old=$oldStartedAt new=$newStartedAt"
    }

    $transcript = Invoke-RestMethod -Method Get -Uri "$BaseUrl/videos/$videoId/transcript"
    $transcriptPath = Join-Path $OutDir "restart_recovery_transcript_$videoId.json"
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
    $vttPath = Join-Path $OutDir "restart_recovery_subtitles_$videoId.vtt"
    $vtt | Set-Content -Encoding utf8 -Path $vttPath
    Write-Host "Saved: $vttPath"

    $iwrArgs = @{ Method = "Get"; Uri = "$BaseUrl/videos/$videoId/subtitles/srt" }
    if ($iwrHasBasic) { $iwrArgs["UseBasicParsing"] = $true }
    $srt = (Invoke-WebRequest @iwrArgs).Content
    $srtPath = Join-Path $OutDir "restart_recovery_subtitles_$videoId.srt"
    $srt | Set-Content -Encoding utf8 -Path $srtPath
    Write-Host "Saved: $srtPath"

    if (-not $KeepBackendRunning) {
        Stop-Backend $p2
    }

    Write-Host "OK"
} catch {
    throw
}

param(
    [string]$BaseUrl = "http://127.0.0.1:8001",
    [string]$LocalLLMBaseUrl = "http://127.0.0.1:8080/v1",
    [string]$VideoId = "",
    [string]$VideoPath = "",
    [switch]$ForceReindex,
    [string]$Provider = "openai_local",
    [string]$Model = "llama",
    [double]$Temperature = 0.2,
    [int]$MaxTokens = 128,
    [string]$QueryNonStream = "",
    [string]$QueryStream = "",
    [int]$TopK = 5,
    [int]$PollIntervalMs = 500,
    [int]$TimeoutSeconds = 1800,
    [string]$OutDir = "artifacts"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if (-not $QueryNonStream) {
    $QueryNonStream = "Summarize the video in 3 sentences and include key timestamps."
}
if (-not $QueryStream) {
    $QueryStream = "Create a bullet-point outline and include referenced time ranges."
}

$BaseUrl = $BaseUrl.TrimEnd('/')
$LocalLLMBaseUrl = $LocalLLMBaseUrl.TrimEnd('/')

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function Save-Text($text, $path) {
    $text | Set-Content -Encoding utf8 -Path $path
}

function Save-Json($obj, $path) {
    $obj | ConvertTo-Json -Depth 50 | Set-Content -Encoding utf8 -Path $path
}

$iwrHasBasic = $false
try {
    $iwrHasBasic = (Get-Command Invoke-WebRequest).Parameters.ContainsKey(
        "UseBasicParsing"
    )
} catch {
    $iwrHasBasic = $false
}

function Invoke-WebRaw {
    param(
        [Parameter(Mandatory = $true)][string]$Method,
        [Parameter(Mandatory = $true)][string]$Uri,
        [object]$Body = $null,
        [string]$ContentType = ""
    )

    $args = @{ Method = $Method; Uri = $Uri }
    if ($iwrHasBasic) {
        $args["UseBasicParsing"] = $true
    }

    if ($Body -ne $null) {
        $args["Body"] = ($Body | ConvertTo-Json -Compress)
        $args["ContentType"] = $ContentType
    }

    $resp = Invoke-WebRequest @args
    return [PSCustomObject]@{
        StatusCode = [int]$resp.StatusCode
        Content = $resp.Content
        Raw = $resp
    }
}

function Invoke-WebJson {
    param(
        [Parameter(Mandatory = $true)][string]$Method,
        [Parameter(Mandatory = $true)][string]$Uri,
        [object]$Body = $null
    )

    $resp = Invoke-WebRaw -Method $Method -Uri $Uri -Body $Body -ContentType "application/json; charset=utf-8"
    $json = $null
    if ($resp.Content) {
        $json = $resp.Content | ConvertFrom-Json
    }

    return [PSCustomObject]@{
        StatusCode = $resp.StatusCode
        Json = $json
        Raw = $resp.Raw
    }
}

function Wait-Health($timeoutSeconds) {
    $deadline = (Get-Date).AddSeconds($timeoutSeconds)
    while ($true) {
        try {
            $h = Invoke-RestMethod -Method Get -Uri "$BaseUrl/health"
            if ($h -and "$($h.status)" -eq "ok") {
                return $h
            }
        } catch {
        }

        if ((Get-Date) -gt $deadline) {
            throw "Backend not healthy at $BaseUrl (timeout ${timeoutSeconds}s)"
        }
        Start-Sleep -Milliseconds 500
    }
}

function Get-Job($jobId) {
    return Invoke-RestMethod -Method Get -Uri "$BaseUrl/jobs/$jobId"
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
Write-Host "LocalLLMBaseUrl: $LocalLLMBaseUrl"

$health = Wait-Health 60
Write-Host "Backend health: $($health.status)"

Write-Host "Checking llama-server: GET $LocalLLMBaseUrl/models"
$llmModelsRaw = Invoke-WebRaw -Method Get -Uri "$LocalLLMBaseUrl/models" -Body $null -ContentType ""
Save-Text $llmModelsRaw.Content (Join-Path $OutDir "local_llm_models.json")

Write-Host "Setting backend LLM preferences (provider=$Provider model=$Model max_tokens=$MaxTokens)"
$prefsBody = @{ provider = $Provider; model = $Model; temperature = $Temperature; max_tokens = $MaxTokens }
$prefsResp = Invoke-WebJson -Method Put -Uri "$BaseUrl/llm/preferences/default" -Body $prefsBody
if ($prefsResp.StatusCode -ne 200) {
    throw "Failed to set LLM preferences. status=$($prefsResp.StatusCode)"
}
Save-Json $prefsResp.Json (Join-Path $OutDir "local_llm_prefs_set.json")

if (-not $VideoId) {
    if (-not $VideoPath) {
        throw "Must provide -VideoId or -VideoPath"
    }
    if (-not (Test-Path -LiteralPath $VideoPath)) {
        throw "VideoPath not found: $VideoPath"
    }

    $resolvedVideoPath = ""
    if (Test-Path -LiteralPath $VideoPath -PathType Leaf) {
        $resolvedVideoPath = (Resolve-Path -LiteralPath $VideoPath).Path
    } elseif (Test-Path -LiteralPath $VideoPath -PathType Container) {
        $resolvedDir = (Resolve-Path -LiteralPath $VideoPath).Path
        $candidate = Get-ChildItem -LiteralPath $resolvedDir -File -Recurse -ErrorAction Stop |
            Where-Object {
                $ext = [string]$_.Extension
                if (-not $ext) {
                    $ext = ""
                }
                $ext = $ext.ToLowerInvariant()
                $ext -in @(".mp4", ".mkv", ".webm", ".avi", ".mov", ".m4v")
            } |
            Select-Object -First 1

        if (-not $candidate) {
            throw "VideoPath is a directory but no supported video file was found inside: $resolvedDir"
        }
        $resolvedVideoPath = $candidate.FullName
    } else {
        throw "VideoPath must be a file or directory: $VideoPath"
    }

    Write-Host "Importing video: $resolvedVideoPath"

    $import = Invoke-WebJson -Method Post -Uri "$BaseUrl/videos/import" -Body @{ file_path = $resolvedVideoPath }
    if ($import.StatusCode -ne 200) {
        throw "Import failed. status=$($import.StatusCode)"
    }
    $VideoId = $import.Json.id
    Save-Json $import.Json (Join-Path $OutDir "local_llm_import_$VideoId.json")
}

Write-Host "Using video_id: $VideoId"

$transcriptCheck = Invoke-WebJson -Method Get -Uri "$BaseUrl/videos/$VideoId/transcript?limit=1"
if ($transcriptCheck.StatusCode -ne 200) {
    throw "TRANSCRIPT_NOT_FOUND for video_id=$VideoId. Create a transcribe job first."
}

$indexStatus = Invoke-RestMethod -Method Get -Uri "$BaseUrl/videos/$VideoId/index"
Save-Json $indexStatus (Join-Path $OutDir "local_llm_index_status_before_$VideoId.json")

$needIndex = $ForceReindex -or ("$($indexStatus.status)" -ne "completed")
if ($needIndex) {
    $fromScratch = $true
    Write-Host "Starting index job: POST /videos/{video_id}/index (from_scratch=$fromScratch)"
    $idxReq = Invoke-WebJson -Method Post -Uri "$BaseUrl/videos/$VideoId/index" -Body @{ from_scratch = $fromScratch }
    if ($idxReq.StatusCode -ne 202) {
        throw "Expected 202 from /videos/{video_id}/index, got $($idxReq.StatusCode)"
    }
    $jobId = $idxReq.Json.job_id
    Save-Json $idxReq.Json (Join-Path $OutDir "local_llm_index_job_started_$jobId.json")

    Write-Host "Waiting for index job completion... job_id=$jobId"
    $final = Wait-JobTerminal $jobId $TimeoutSeconds
    Save-Json $final (Join-Path $OutDir "local_llm_index_final_$jobId.json")
    if ("$($final.status)" -ne "completed") {
        throw "Index job not completed. status=$($final.status) error=$($final.error_message)"
    }
}

$indexAfter = Invoke-RestMethod -Method Get -Uri "$BaseUrl/videos/$VideoId/index"
Save-Json $indexAfter (Join-Path $OutDir "local_llm_index_status_after_$VideoId.json")

Write-Host "Calling /chat (non-stream, should be 200)..."
$chatReq = Invoke-WebJson -Method Post -Uri "$BaseUrl/chat" -Body @{ video_id = $VideoId; query = $QueryNonStream; top_k = $TopK; stream = $false }
if ($chatReq.StatusCode -ne 200) {
    throw "Expected 200 from /chat, got $($chatReq.StatusCode)"
}
Save-Json $chatReq.Json (Join-Path $OutDir "local_llm_chat_200.json")

Write-Host "Calling /chat (stream=true; response is SSE text)..."
$chatStreamRaw = Invoke-WebRaw -Method Post -Uri "$BaseUrl/chat" -Body @{ video_id = $VideoId; query = $QueryStream; top_k = $TopK; stream = $true } -ContentType "application/json; charset=utf-8"
if ($chatStreamRaw.StatusCode -ne 200) {
    throw "Expected 200 from /chat (stream), got $($chatStreamRaw.StatusCode)"
}
Save-Text $chatStreamRaw.Content (Join-Path $OutDir "local_llm_chat_stream_sse.txt")

if ($chatStreamRaw.Content -notmatch "event:\s*done") {
    throw "Stream response did not contain 'event: done'"
}

Write-Host "OK"

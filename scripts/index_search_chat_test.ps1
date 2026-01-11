param(
    [string]$BaseUrl = "http://127.0.0.1:8001",
    [string]$VideoId = "",
    [string]$VideoPath = "",
    [switch]$ForceReindex,
    [string]$Query = "What is this video about?",
    [int]$TopK = 5,
    [int]$PollIntervalMs = 500,
    [int]$TimeoutSeconds = 1800,
    [string]$OutDir = "artifacts"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$BaseUrl = $BaseUrl.TrimEnd('/')

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

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

function Invoke-WebJson {
    param(
        [Parameter(Mandatory = $true)][string]$Method,
        [Parameter(Mandatory = $true)][string]$Uri,
        [object]$Body = $null
    )

    $args = @{ Method = $Method; Uri = $Uri }
    if ($iwrHasBasic) {
        $args["UseBasicParsing"] = $true
    }

    if ($Body -ne $null) {
        $args["ContentType"] = "application/json; charset=utf-8"
        $args["Body"] = ($Body | ConvertTo-Json -Compress)
    }

    $resp = Invoke-WebRequest @args
    $json = $null
    if ($resp.Content) {
        $json = $resp.Content | ConvertFrom-Json
    }

    return [PSCustomObject]@{
        StatusCode = [int]$resp.StatusCode
        Json = $json
        Raw = $resp
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

Write-Host "BaseUrl: $BaseUrl"

$health = Wait-Health 60
Write-Host "Health: $($health.status)"

if (-not $VideoId) {
    if (-not $VideoPath) {
        throw "Must provide -VideoId or -VideoPath"
    }
    if (-not (Test-Path -LiteralPath $VideoPath)) {
        throw "VideoPath not found: $VideoPath"
    }
    $resolvedVideoPath = (Resolve-Path -LiteralPath $VideoPath).Path
    Write-Host "VideoPath: $resolvedVideoPath"

    $importBody = @{ file_path = $resolvedVideoPath }
    $import = Invoke-WebJson -Method Post -Uri "$BaseUrl/videos/import" -Body $importBody
    if ($import.StatusCode -ne 200) {
        throw "Import failed. status=$($import.StatusCode)"
    }
    $VideoId = $import.Json.id
    Save-Json $import.Json (Join-Path $OutDir "index_chat_import_$VideoId.json")
}

Write-Host "Using video_id: $VideoId"

$video = Invoke-RestMethod -Method Get -Uri "$BaseUrl/videos/$VideoId"
Save-Json $video (Join-Path $OutDir "index_chat_video_$VideoId.json")

$transcriptCheck = Invoke-WebJson -Method Get -Uri "$BaseUrl/videos/$VideoId/transcript?limit=1"
if ($transcriptCheck.StatusCode -ne 200) {
    throw "TRANSCRIPT_NOT_FOUND for video_id=$VideoId. Run smoke_test.ps1 first or create a transcribe job."
}

$indexStatus = Invoke-RestMethod -Method Get -Uri "$BaseUrl/videos/$VideoId/index"
Save-Json $indexStatus (Join-Path $OutDir "index_chat_index_status_before_$VideoId.json")

$jobId = $null

if ($ForceReindex) {
    Write-Host "Force reindex: starting /videos/{video_id}/index (from_scratch=true)"
    $idxReq = Invoke-WebJson -Method Post -Uri "$BaseUrl/videos/$VideoId/index" -Body @{ from_scratch = $true }
    if ($idxReq.StatusCode -ne 202) {
        throw "Expected 202 from /videos/{video_id}/index, got $($idxReq.StatusCode)"
    }
    $jobId = $idxReq.Json.job_id
    Save-Json $idxReq.Json (Join-Path $OutDir "index_chat_index_job_started_$jobId.json")
} else {
    Write-Host "Calling /chat to verify auto-indexing and citations..."
    $chatReq = Invoke-WebJson -Method Post -Uri "$BaseUrl/chat" -Body @{ video_id = $VideoId; query = $Query; top_k = $TopK }

    if ($chatReq.StatusCode -eq 202) {
        $jobId = $chatReq.Json.job_id
        Save-Json $chatReq.Json (Join-Path $OutDir "index_chat_chat_202_$jobId.json")
    } elseif ($chatReq.StatusCode -eq 200) {
        Save-Json $chatReq.Json (Join-Path $OutDir "index_chat_chat_200.json")
        Write-Host "Index already completed; /chat returned 200. Use -ForceReindex to exercise 202+dedupe path."
    } else {
        throw "Unexpected /chat status: $($chatReq.StatusCode)"
    }
}

if ($jobId) {
    Write-Host "Index job_id: $jobId"

    $qEsc = [Uri]::EscapeDataString($Query)
    $vidEsc = [Uri]::EscapeDataString($VideoId)

    Write-Host "Calling /search while indexing (should reuse same job_id)..."
    $search = Invoke-WebJson -Method Get -Uri "$BaseUrl/search?query=$qEsc&video_id=$vidEsc&top_k=$TopK"
    if ($search.StatusCode -eq 202) {
        if ($search.Json.job_id -ne $jobId) {
            $prev = Get-Job $jobId
            if ("$($prev.status)" -in @("pending", "running")) {
                throw "Expected /search job_id == $jobId (active), got $($search.Json.job_id)"
            }
            Write-Host "Note: /search returned a new job_id because previous job is not active."
            $jobId = $search.Json.job_id
        }
        Save-Json $search.Json (Join-Path $OutDir "index_chat_search_202_$jobId.json")
    } elseif ($search.StatusCode -eq 200) {
        Save-Json $search.Json (Join-Path $OutDir "index_chat_search_200_during.json")
        Write-Host "Note: /search returned 200; indexing may have completed before this check."
    } else {
        throw "Unexpected /search status while indexing: $($search.StatusCode)"
    }

    Write-Host "Calling /chat while indexing (should reuse same job_id)..."
    $chat2 = Invoke-WebJson -Method Post -Uri "$BaseUrl/chat" -Body @{ video_id = $VideoId; query = $Query; top_k = $TopK }
    if ($chat2.StatusCode -eq 202) {
        if ($chat2.Json.job_id -ne $jobId) {
            $prev = Get-Job $jobId
            if ("$($prev.status)" -in @("pending", "running")) {
                throw "Expected /chat job_id == $jobId (active), got $($chat2.Json.job_id)"
            }
            Write-Host "Note: /chat returned a new job_id because previous job is not active."
            $jobId = $chat2.Json.job_id
        }
        Save-Json $chat2.Json (Join-Path $OutDir "index_chat_chat_202_confirm_$jobId.json")
    } elseif ($chat2.StatusCode -eq 200) {
        Save-Json $chat2.Json (Join-Path $OutDir "index_chat_chat_200_during.json")
        Write-Host "Note: /chat returned 200; indexing may have completed before this check."
    } else {
        throw "Unexpected /chat status while indexing: $($chat2.StatusCode)"
    }

    Write-Host "Waiting for index job completion..."
    $final = Wait-JobTerminal $jobId $TimeoutSeconds
    Save-Json $final (Join-Path $OutDir "index_chat_index_final_$jobId.json")
    if ($final.status -ne "completed") {
        throw "Index job not completed. status=$($final.status)"
    }
}

$indexAfter = Invoke-RestMethod -Method Get -Uri "$BaseUrl/videos/$VideoId/index"
Save-Json $indexAfter (Join-Path $OutDir "index_chat_index_status_after_$VideoId.json")

$qEsc = [Uri]::EscapeDataString($Query)
$vidEsc = [Uri]::EscapeDataString($VideoId)

Write-Host "Calling /chunks (limit=5)..."
$chunks = Invoke-RestMethod -Method Get -Uri "$BaseUrl/videos/$VideoId/chunks?limit=5"
Save-Json $chunks (Join-Path $OutDir "index_chat_chunks_$VideoId.json")

Write-Host "Calling /search (should be 200)..."
$searchOk = Invoke-WebJson -Method Get -Uri "$BaseUrl/search?query=$qEsc&video_id=$vidEsc&top_k=$TopK"
if ($searchOk.StatusCode -ne 200) {
    throw "Expected 200 from /search, got $($searchOk.StatusCode)"
}
Save-Json $searchOk.Json (Join-Path $OutDir "index_chat_search_200.json")

Write-Host "Calling /chat (should be 200 with citations)..."
$chatOk = Invoke-WebJson -Method Post -Uri "$BaseUrl/chat" -Body @{ video_id = $VideoId; query = $Query; top_k = $TopK }
if ($chatOk.StatusCode -ne 200) {
    throw "Expected 200 from /chat, got $($chatOk.StatusCode)"
}
Save-Json $chatOk.Json (Join-Path $OutDir "index_chat_chat_200_after.json")

Write-Host "OK"

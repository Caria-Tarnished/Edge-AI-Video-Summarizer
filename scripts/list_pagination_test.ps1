param(
    [string]$BaseUrl = "http://127.0.0.1:8001",
    [Parameter(Mandatory = $true)][string]$VideoPath,
    [int]$JobsToCreate = 6,
    [int]$PollIntervalMs = 200,
    [int]$TimeoutSeconds = 60,
    [string]$OutDir = "artifacts",
    [int]$ExtraVideosCount = 0
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$BaseUrl = $BaseUrl.Trim().TrimEnd('/')

if (-not (Test-Path -LiteralPath $VideoPath)) {
    throw "VideoPath not found: $VideoPath"
}
$resolvedVideoPath = (Resolve-Path -LiteralPath $VideoPath).Path

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function Save-Json($obj, $path) {
    $obj | ConvertTo-Json -Depth 50 | Set-Content -Encoding utf8 -Path $path
}

function Assert($cond, $msg) {
    if (-not $cond) {
        throw "ASSERT FAILED: $msg"
    }
}

function Normalize-Uri($uri, $label) {
    if ($null -eq $uri) {
        throw "Invalid URI ($label): null"
    }

    if ($uri -is [System.Collections.IDictionary]) {
        throw "Invalid URI ($label): got hashtable/dictionary"
    }

    if ($uri -is [System.Array]) {
        $uri = ($uri | ForEach-Object { [string]$_ }) -join ""
    }

    $u = [string]$uri
    if (-not [System.Uri]::IsWellFormedUriString($u, [System.UriKind]::Absolute)) {
        $t = $uri.GetType().FullName
        throw "Invalid URI ($label): '$u' (type=$t)"
    }

    try {
        $tmp = New-Object System.Uri $u
        if (-not $tmp.Host) {
            throw "empty host"
        }
    } catch {
        $t = $uri.GetType().FullName
        throw "Invalid URI ($label): '$u' (type=$t) parse_error=$($_.Exception.Message)"
    }

    return $u
}

function Get-Json($uri) {
    $u = Normalize-Uri $uri "GET"
    return Invoke-RestMethod -Method Get -Uri $u
}

function Post-Json($uri, $bodyObj) {
    $body = $bodyObj | ConvertTo-Json -Compress
    $u = Normalize-Uri $uri "POST"
    return Invoke-RestMethod -Method Post -Uri $u -ContentType "application/json" -Body $body
}

function Require-Fields($obj, $fields, $label) {
    foreach ($f in $fields) {
        Assert ($null -ne $obj.$f) ("$label missing field '$f'")
    }
}

function Check-ListResponse($resp, $limit, $offset, $label) {
    Require-Fields $resp @("total", "items") $label
    Assert ($resp.items -is [System.Collections.IEnumerable]) ("$label items must be an array")

    $total = [int]$resp.total
    $count = @($resp.items).Count

    Assert ($total -ge 0) ("$label total must be >=0")
    Assert ($offset -ge 0) ("$label offset must be >=0")
    Assert ($limit -ge 1) ("$label limit must be >=1")

    Assert ($count -le $limit) ("$label items.Count ($count) must be <= limit ($limit)")
    Assert ($total -ge $count) ("$label total ($total) must be >= items.Count ($count)")

    if ($offset -ge $total) {
        Assert ($count -eq 0) ("$label expected empty page when offset>=total")
    }

    if ($offset -eq 0 -and $total -le $limit) {
        Assert ($count -eq $total) ("$label expected items.Count==total when total<=limit")
    }
}

function Build-Query($base, $params) {
    $b = [string]$base
    if (-not $params -or $params.Count -eq 0) {
        return $b
    }

    $pairs = @()
    foreach ($kv in ($params.GetEnumerator() | Sort-Object -Property Key)) {
        $ek = [System.Uri]::EscapeDataString([string]$kv.Key)
        $ev = [System.Uri]::EscapeDataString([string]$kv.Value)
        $pairs += "$ek=$ev"
    }

    $sep = "?"
    if ($b -match "\?") {
        $sep = "&"
    }

    return "$b$sep" + ($pairs -join "&")
}

Write-Host "BaseUrl: $BaseUrl"
Write-Host "VideoPath: $resolvedVideoPath"

$health = Get-Json "$BaseUrl/health"
Assert ("$($health.status)" -eq "ok") "Backend health != ok"

$import = Post-Json "$BaseUrl/videos/import" @{ file_path = $resolvedVideoPath }
$videoId = $import.id
Assert ($videoId) "import did not return video id"
Write-Host "Imported video_id: $videoId"
Save-Json $import (Join-Path $OutDir "list_pagination_import_primary_$videoId.json")

# Optional: generate extra video copies (strict /videos pagination is more meaningful with >1 video)
$extraVideoIds = @()
if ($ExtraVideosCount -gt 0) {
    $outDirAbs = (Resolve-Path -LiteralPath $OutDir).Path
    $tmpDir = Join-Path $outDirAbs "tmp_videos"
    New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null

    for ($i = 1; $i -le $ExtraVideosCount; $i++) {
        $dst = Join-Path $tmpDir ("test_variant_{0}.mp4" -f $i)
        Copy-Item -LiteralPath $resolvedVideoPath -Destination $dst -Force
        # Append one random byte to change file hash. Trailing bytes are usually ignored by mp4 parsers.
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
        $v = Post-Json "$BaseUrl/videos/import" @{ file_path = $dstAbs }
        $extraVideoIds += $v.id
        Save-Json $v (Join-Path $OutDir "list_pagination_import_extra_${i}_$($v.id).json")
        Write-Host "Imported extra video_id[$i]: $($v.id)"
    }
}

# ----------------------
# /videos strict checks
# ----------------------
$videosAllUri = Build-Query "$BaseUrl/videos" @{ limit = 200; offset = 0 }
$videosAll = Get-Json $videosAllUri
Save-Json $videosAll (Join-Path $OutDir "list_pagination_videos_all.json")
Check-ListResponse $videosAll 200 0 "/videos(all)"

$videoFields = @(
    "id", "file_path", "file_hash", "title", "duration", "file_size",
    "status", "created_at", "updated_at"
)
foreach ($v in @($videosAll.items)) {
    Require-Fields $v $videoFields "video"
}

# Sorting check (created_at desc) when we have at least 2
$itemsAll = @($videosAll.items)
if ($itemsAll.Count -ge 2) {
    for ($i = 0; $i -lt $itemsAll.Count - 1; $i++) {
        $a = [datetime]::Parse([string]$itemsAll[$i].created_at)
        $b = [datetime]::Parse([string]$itemsAll[$i + 1].created_at)
        Assert ($a -ge $b) "/videos not sorted by created_at desc"
    }
}

$videoFullIds = @($itemsAll | ForEach-Object { $_.id })

# Limit/offset behavior
$videoTotal = [int]$videosAll.total
foreach ($limit in @(1, 2, 5)) {
    $uri = Build-Query "$BaseUrl/videos" @{ limit = $limit; offset = 0 }
    $resp = Get-Json $uri
    Save-Json $resp (Join-Path $OutDir "list_pagination_videos_limit_${limit}.json")
    Check-ListResponse $resp $limit 0 ("/videos(limit=$limit)")

    $pageIds = @($resp.items | ForEach-Object { $_.id })
    $expected = @(
        $videoFullIds[0..([Math]::Min($videoFullIds.Count - 1, $limit - 1))]
    )
    Assert ($pageIds.Count -eq $expected.Count) "/videos page size mismatch"
    for ($i = 0; $i -lt $pageIds.Count; $i++) {
        Assert ($pageIds[$i] -eq $expected[$i]) "/videos pagination mismatch"
    }
}

foreach ($offset in @(0, 1, 2, 10)) {
    $uri = Build-Query "$BaseUrl/videos" @{ limit = 1; offset = $offset }
    $resp = Get-Json $uri
    Save-Json $resp (Join-Path $OutDir "list_pagination_videos_offset_${offset}.json")
    Check-ListResponse $resp 1 $offset ("/videos(offset=$offset)")

    $pageIds = @($resp.items | ForEach-Object { $_.id })
    if ($offset -lt $videoFullIds.Count) {
        Assert ($pageIds.Count -eq 1) "/videos expected 1 item"
        Assert ($pageIds[0] -eq $videoFullIds[$offset]) "/videos offset mismatch"
    } else {
        Assert ($pageIds.Count -eq 0) "/videos expected empty page"
    }
}

# Status filter: strict on content validity
$countsByStatus = @{}
foreach ($v in $itemsAll) {
    $s = [string]$v.status
    if (-not $countsByStatus.ContainsKey($s)) { $countsByStatus[$s] = 0 }
    $countsByStatus[$s] = [int]$countsByStatus[$s] + 1
}

foreach ($s in $countsByStatus.Keys) {
    $uri = Build-Query "$BaseUrl/videos" @{ status = $s; limit = 200; offset = 0 }
    $resp = Get-Json $uri
    Save-Json $resp (Join-Path $OutDir "list_pagination_videos_status_${s}.json")
    Check-ListResponse $resp 200 0 ("/videos(status=$s)")
    foreach ($v in @($resp.items)) {
        Assert ("$($v.status)" -eq $s) ("/videos(status=$s) returned item with status=$($v.status)")
    }
}

$resp = Get-Json (Build-Query "$BaseUrl/videos" @{ status = "__no_such_status__"; limit = 50; offset = 0 })
Save-Json $resp (Join-Path $OutDir "list_pagination_videos_status_fake.json")
Check-ListResponse $resp 50 0 "/videos(fake status)"
Assert ([int]$resp.total -eq 0) "/videos(fake status) total must be 0"
Assert (@($resp.items).Count -eq 0) "/videos(fake status) items must be empty"

# ----------------------
# /jobs strict checks
# ----------------------
Assert ($JobsToCreate -ge 1) "JobsToCreate must be >=1"

$createdJobIds = @()
for ($i = 1; $i -le $JobsToCreate; $i++) {
    $seg = 30 + ($i * 5)
    $job = Post-Json "$BaseUrl/jobs/transcribe" @{ video_id = $videoId; segment_seconds = $seg; from_scratch = $true }
    $jid = $job.id
    Assert ($jid) "job create returned empty id"
    $createdJobIds += $jid
    Save-Json $job (Join-Path $OutDir "list_pagination_job_created_${i}_$jid.json")
    Write-Host "Created job[$i]: $jid"
    Start-Sleep -Milliseconds 1100
}

# Cancel all created jobs to stabilize status (terminal). Some may complete too fast; that's OK.
$terminal = @{}
foreach ($jid in $createdJobIds) {
    try {
        $cancel = Invoke-RestMethod -Method Post -Uri "$BaseUrl/jobs/$jid/cancel"
        Save-Json $cancel (Join-Path $OutDir "list_pagination_job_cancel_response_$jid.json")
    } catch {
        # Not cancellable if already completed/failed.
        Save-Json @{ error = "cancel_failed"; job_id = $jid; detail = $_.Exception.Message } (Join-Path $OutDir "list_pagination_job_cancel_error_$jid.json")
    }

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ($true) {
        $j = Get-Json "$BaseUrl/jobs/$jid"
        $st = [string]$j.status
        if ($st -in @("cancelled", "completed", "failed")) {
            $terminal[$jid] = $st
            Save-Json $j (Join-Path $OutDir "list_pagination_job_terminal_$jid.json")
            break
        }
        if ((Get-Date) -gt $deadline) {
            throw "Timeout waiting for job to reach terminal status (job_id=$jid)"
        }
        Start-Sleep -Milliseconds $PollIntervalMs
    }
}

# Baseline query without status filter (stable ordering by created_at)
$jobsBaseParams = @{ video_id = $videoId; job_type = "transcribe"; limit = 200; offset = 0 }
$jobsAllUri = Build-Query "$BaseUrl/jobs" $jobsBaseParams
$jobsAll = Get-Json $jobsAllUri
Save-Json $jobsAll (Join-Path $OutDir "list_pagination_jobs_all_for_video.json")
Check-ListResponse $jobsAll 200 0 "/jobs(video_id,job_type)"

$jobsAllTotal = [int]$jobsAll.total
$jobsAllNotTruncated = ($jobsAllTotal -le 200)

$jobFields = @(
    "id", "video_id", "job_type", "status", "progress", "message",
    "created_at", "updated_at"
)
foreach ($j in @($jobsAll.items)) {
    Require-Fields $j $jobFields "job"
    Assert ("$($j.video_id)" -eq $videoId) "/jobs(video_id=...) returned different video_id"
    Assert ("$($j.job_type)" -eq "transcribe") "/jobs(job_type=transcribe) returned different job_type"
}

# Ensure our created job ids are included
$idsAll = @($jobsAll.items | ForEach-Object { $_.id })
foreach ($jid in $createdJobIds) {
    Assert ($idsAll -contains $jid) ("Created job missing from /jobs list: $jid")
}

# Strict pagination: pages must match slices of the full list.
$fullIds = @($idsAll)
$limit = 2
$offset = 0
while ($offset -lt [Math]::Min($fullIds.Count, 10)) {
    $uri = Build-Query "$BaseUrl/jobs" @{ video_id = $videoId; job_type = "transcribe"; limit = $limit; offset = $offset }
    $page = Get-Json $uri
    Save-Json $page (Join-Path $OutDir "list_pagination_jobs_page_limit_${limit}_offset_${offset}.json")
    Check-ListResponse $page $limit $offset ("/jobs page limit=$limit offset=$offset")

    $pageIds = @($page.items | ForEach-Object { $_.id })
    $expected = @($fullIds[$offset..([Math]::Min($fullIds.Count - 1, $offset + $limit - 1))])

    Assert ($pageIds.Count -eq $expected.Count) "Page size mismatch"
    for ($i = 0; $i -lt $pageIds.Count; $i++) {
        Assert ($pageIds[$i] -eq $expected[$i]) ("Pagination order mismatch at offset=$offset idx=$i")
    }

    $offset += $limit
}

# Filter sanity: status filter returns only that status
$uniqueStatuses = @($jobsAll.items | ForEach-Object { [string]$_.status } | Sort-Object -Unique)
foreach ($s in $uniqueStatuses) {
    $uri = Build-Query "$BaseUrl/jobs" @{ video_id = $videoId; status = $s; limit = 200; offset = 0 }
    $resp = Get-Json $uri
    Save-Json $resp (Join-Path $OutDir "list_pagination_jobs_status_${s}.json")
    Check-ListResponse $resp 200 0 ("/jobs(status=$s)")

     if ($jobsAllNotTruncated) {
         $expectedTotal = @($jobsAll.items | Where-Object { "$($_.status)" -eq $s }).Count
         Assert ([int]$resp.total -eq $expectedTotal) "/jobs(status=$s) total mismatch"
     }

    foreach ($j in @($resp.items)) {
        Assert ("$($j.status)" -eq $s) ("/jobs(status=$s) returned status=$($j.status)")
        Assert ("$($j.video_id)" -eq $videoId) "/jobs(video_id,status) returned different video_id"
    }
}

# Nonexistent video_id should return empty list
$fakeVideoId = [guid]::NewGuid().ToString()
$resp = Get-Json (Build-Query "$BaseUrl/jobs" @{ video_id = $fakeVideoId; limit = 50; offset = 0 })
Save-Json $resp (Join-Path $OutDir "list_pagination_jobs_fake_video.json")
Check-ListResponse $resp 50 0 "/jobs(fake video_id)"
Assert ([int]$resp.total -eq 0) "/jobs(fake video_id) total must be 0"
Assert (@($resp.items).Count -eq 0) "/jobs(fake video_id) items must be empty"

Write-Host "OK"

param(
    [string]$LlamaServerExe = "F:\LLAMA\bin\llama-server.exe",
    [string]$ModelPath = "F:\LLAMA\models\Qwen2.5-7B-Instruct\qwen2.5-7b-instruct-q4_k_m.gguf",
    [string]$BackendBaseUrl = "http://127.0.0.1:8001",
    [string]$LocalLLMBaseUrl = "http://127.0.0.1:8080/v1",
    [int]$BackendPort = 8001,
    [int]$LlamaPort = 8080,
    [int]$LlamaCtxSize = 4096,
    [int]$LlamaThreads = 0,
    [int]$LlamaGpuLayers = -1,
    [int]$LLMTimeoutSeconds = 600,
    [string]$LLMModelId = "llama",
    [int]$LLMMaxTokens = 128,
    [switch]$RunE2E,
    [switch]$ForceReindex,
    [string]$VideoId = "",
    [string]$VideoPath = "",
    [string]$OutDir = "artifacts",
    [string[]]$LlamaExtraArgs = @()
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$BackendBaseUrl = $BackendBaseUrl.TrimEnd('/')
$LocalLLMBaseUrl = $LocalLLMBaseUrl.TrimEnd('/')

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$logDir = Join-Path $OutDir "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$iwrHasBasic = $false
try {
    $iwrHasBasic = (Get-Command Invoke-WebRequest).Parameters.ContainsKey("UseBasicParsing")
} catch {
    $iwrHasBasic = $false
}

function Find-ListeningPid([int]$port) {
    if (-not $port -or $port -le 0) {
        return $null
    }
    try {
        $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop
        $pids = $conns | Select-Object -ExpandProperty OwningProcess -Unique
        if ($pids -and $pids.Count -ge 1) {
            return [int]$pids[0]
        }
    } catch {
        return $null
    }
    return $null
}

function Try-HttpOk([string]$url, [int]$timeoutSeconds) {
    try {
        Wait-HttpOk $url $timeoutSeconds | Out-Null
        return $true
    } catch {
        return $false
    }
}

function Save-Json($obj, $path) {
    $obj | ConvertTo-Json -Depth 10 | Set-Content -Encoding utf8 -Path $path
}

function Wait-HttpOk([string]$url, [int]$timeoutSeconds) {
    $deadline = (Get-Date).AddSeconds($timeoutSeconds)
    while ($true) {
        try {
            $args = @{ Uri = $url; Method = "Get" }
            if ($iwrHasBasic) {
                $args["UseBasicParsing"] = $true
            }
            $resp = Invoke-WebRequest @args
            if ([int]$resp.StatusCode -eq 200) {
                return $resp.Content
            }
        } catch {
        }

        if ((Get-Date) -gt $deadline) {
            throw "Not ready at $url (timeout ${timeoutSeconds}s)"
        }
        Start-Sleep -Milliseconds 500
    }
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

Write-Host "OutDir: $OutDir"

$pidRecordPath = Join-Path $OutDir "local_stack_pids.json"
$llamaPidPath = Join-Path $OutDir "llama_server.pid"
$backendPidPath = Join-Path $OutDir "backend.pid"
$llamaPid = $null
$backendPid = $null
$llamaStarted = $false
$backendStarted = $false

Write-Host "1) Starting llama-server (if paths provided)..."
$llamaModelsUrl = "$LocalLLMBaseUrl/models"
if (Try-HttpOk $llamaModelsUrl 2) {
    Write-Host "llama-server already running: $LocalLLMBaseUrl"
    $portPid = Find-ListeningPid $LlamaPort
    if ($portPid) {
        $llamaPid = [int]$portPid
        "$llamaPid" | Set-Content -Encoding ascii -Path $llamaPidPath
    }
} elseif ($LlamaServerExe -and $ModelPath) {
    $startLlama = Join-Path $PSScriptRoot "run_llama_server.ps1"
    if (-not (Test-Path -LiteralPath $startLlama)) {
        throw "Missing script: $startLlama"
    }

    $llamaInfo = & $startLlama `
        -LlamaServerExe $LlamaServerExe `
        -ModelPath $ModelPath `
        -ListenHost "127.0.0.1" `
        -Port $LlamaPort `
        -CtxSize $LlamaCtxSize `
        -Threads $LlamaThreads `
        -GpuLayers $LlamaGpuLayers `
        -ApiBaseUrl $LocalLLMBaseUrl `
        -OutDir $OutDir `
        -ExtraArgs $LlamaExtraArgs

    if ($llamaInfo -and $llamaInfo.pid) {
        $llamaPid = [int]$llamaInfo.pid
        $llamaStarted = $true
    } elseif (Test-Path -LiteralPath $llamaPidPath -PathType Leaf) {
        $llamaPid = [int](Get-Content -LiteralPath $llamaPidPath -ErrorAction Stop | Select-Object -First 1)
        $llamaStarted = $true
    }
} else {
    Write-Host "Skipping llama-server start (provide -LlamaServerExe and -ModelPath to auto-start)."
    Write-Host "Checking existing llama-server: $llamaModelsUrl"
    Wait-HttpOk $llamaModelsUrl 10 | Out-Null
}

Write-Host "2) Starting backend (uvicorn)..."
$env:LLM_LOCAL_BASE_URL = $LocalLLMBaseUrl
$env:LLM_LOCAL_MODEL = $LLMModelId
$env:LLM_REQUEST_TIMEOUT_SECONDS = "$LLMTimeoutSeconds"

$env:KMP_DUPLICATE_LIB_OK = "TRUE"
$backendDir = Join-Path $PSScriptRoot "..\backend"
$pythonExe = Join-Path $backendDir ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $pythonExe)) {
    $pythonExe = "python"
}

$ts = (Get-Date).ToString("yyyyMMdd_HHmmss")
$backendStdout = Join-Path $logDir "backend_${ts}.stdout.log"
$backendStderr = Join-Path $logDir "backend_${ts}.stderr.log"

$backendHealthUrl = "$BackendBaseUrl/health"
if (Try-HttpOk $backendHealthUrl 2) {
    Write-Host "backend already running: $BackendBaseUrl"
    $portPid = Find-ListeningPid $BackendPort
    if ($portPid) {
        $backendPid = [int]$portPid
        "$backendPid" | Set-Content -Encoding ascii -Path $backendPidPath
    }
} else {
    $backendProc = Start-Process -FilePath $pythonExe -ArgumentList @(
        "-m",
        "uvicorn",
        "app.main:app",
        "--host",
        "127.0.0.1",
        "--port",
        "$BackendPort"
    ) -WorkingDirectory $backendDir -PassThru -RedirectStandardOutput $backendStdout -RedirectStandardError $backendStderr

    $backendPid = [int]$backendProc.Id
    $backendStarted = $true
    "$backendPid" | Set-Content -Encoding ascii -Path $backendPidPath

    Write-Host "backend pid: $($backendProc.Id)"
    Write-Host "backend stdout: $backendStdout"
    Write-Host "backend stderr: $backendStderr"
}

Wait-HttpOk $backendHealthUrl 60 | Out-Null
Write-Host "backend ready: $BackendBaseUrl"

$portPid = Find-ListeningPid $BackendPort
if ($portPid) {
    $startedPid = $backendPid
    $backendPid = [int]$portPid
    "$backendPid" | Set-Content -Encoding ascii -Path $backendPidPath

    if ($startedPid -and $backendPid -ne $startedPid) {
        Write-Host "backend listening pid: $backendPid (started pid was $startedPid)"
    } else {
        Write-Host "backend listening pid: $backendPid"
    }
}

Write-Host "3) Setting backend LLM preferences..."
$prefs = @{ provider = "openai_local"; model = $LLMModelId; temperature = 0.2; max_tokens = $LLMMaxTokens }
$prefsResp = Invoke-WebJson -Method Put -Uri "$BackendBaseUrl/llm/preferences/default" -Body $prefs
if ($prefsResp.StatusCode -ne 200) {
    throw "Failed to set LLM preferences. status=$($prefsResp.StatusCode)"
}

if ($llamaPid -ne $null) {
    "$llamaPid" | Set-Content -Encoding ascii -Path $llamaPidPath
}

$pidRecord = @{
    started_at = (Get-Date).ToString("o")
    out_dir = $OutDir
    llama_server_pid = $llamaPid
    backend_pid = $backendPid
    llama_server_started_by_script = $llamaStarted
    backend_started_by_script = $backendStarted
    local_llm_base_url = $LocalLLMBaseUrl
    backend_base_url = $BackendBaseUrl
}
Save-Json $pidRecord $pidRecordPath

if ($RunE2E) {
    Write-Host "4) Running local LLM E2E test..."
    $e2e = Join-Path $PSScriptRoot "local_llm_e2e_test.ps1"
    if (-not (Test-Path -LiteralPath $e2e)) {
        throw "Missing script: $e2e"
    }

    $e2eParams = @{
        BaseUrl = $BackendBaseUrl
        LocalLLMBaseUrl = $LocalLLMBaseUrl
        Model = $LLMModelId
        MaxTokens = [int]$LLMMaxTokens
        OutDir = $OutDir
    }
    if ($VideoId) {
        $e2eParams["VideoId"] = $VideoId
    }
    if ($VideoPath) {
        $e2eParams["VideoPath"] = $VideoPath
    }

    if ($ForceReindex) {
        $e2eParams["ForceReindex"] = $true
    }

    & $e2e @e2eParams
}

Write-Host "OK"

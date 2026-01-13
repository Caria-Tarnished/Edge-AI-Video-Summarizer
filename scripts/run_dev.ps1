param(
    [Alias("Host")]
    [string]$BackendHost = "127.0.0.1",
    [int]$BackendPort = 8001,

    [switch]$NoFrontend,
    [string]$FrontendDir = "frontend",

    [switch]$StartLlama,
    [string]$LlamaServerExe = "F:\\LLAMA\\bin\\llama-server.exe",
    [string]$LlamaModelPath = "F:\\LLAMA\\models\\Qwen2.5-7B-Instruct\\qwen2.5-7b-instruct-q4_k_m.gguf",
    [string]$LocalLLMBaseUrl = "http://127.0.0.1:8080/v1",
    [int]$LlamaPort = 8080,

    [string]$OutDir = "artifacts"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$root = Split-Path -Parent $PSScriptRoot
$absOutDir = Join-Path $root $OutDir
New-Item -ItemType Directory -Force -Path $absOutDir | Out-Null

function Write-Json($obj, $path) {
    $obj | ConvertTo-Json -Depth 10 | Set-Content -Encoding utf8 -Path $path
}

$devPidPath = Join-Path $absOutDir "dev_pids.json"
$frontendProc = $null
$llamaPid = $null
$llamaStartedByScript = $false

try {
    function Try-HttpOk([string]$url, [int]$timeoutSeconds) {
        try {
            $args = @{ Uri = $url; Method = "Get"; TimeoutSec = $timeoutSeconds }
            Invoke-WebRequest @args | Out-Null
            return $true
        } catch {
            return $false
        }
    }

    if ($StartLlama) {
        $modelsUrl = ($LocalLLMBaseUrl.TrimEnd('/') + "/models")
        if (Try-HttpOk $modelsUrl 2) {
            Write-Host "llama-server already running: $LocalLLMBaseUrl"
        } else {
        $runLlama = Join-Path $PSScriptRoot "run_llama_server.ps1"
        if (-not (Test-Path -LiteralPath $runLlama -PathType Leaf)) {
            throw "Missing script: $runLlama"
        }

        $llamaInfo = & $runLlama `
            -LlamaServerExe $LlamaServerExe `
            -ModelPath $LlamaModelPath `
            -ListenHost "127.0.0.1" `
            -Port $LlamaPort `
            -ApiBaseUrl $LocalLLMBaseUrl `
            -OutDir $absOutDir

        if ($llamaInfo -and $llamaInfo.pid) {
            $llamaPid = [int]$llamaInfo.pid
            $llamaStartedByScript = $true
        }

        }

        $env:LLM_LOCAL_BASE_URL = $LocalLLMBaseUrl.TrimEnd('/')
    }

    if (-not $NoFrontend) {
        $frontendPath = Join-Path $root $FrontendDir
        $pkg = Join-Path $frontendPath "package.json"
        if (Test-Path -LiteralPath $pkg -PathType Leaf) {
            $env:EDGE_VIDEO_AGENT_CORS_ORIGINS = "http://localhost:5173,http://127.0.0.1:5173"
            $backendBase = "http://${BackendHost}:${BackendPort}".TrimEnd('/')
            $cmd = "$env:VITE_BACKEND_BASE_URL='$backendBase'; npm run dev"
            $frontendProc = Start-Process -FilePath "powershell.exe" -ArgumentList @(
                "-NoProfile",
                "-NoExit",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                $cmd
            ) -WorkingDirectory $frontendPath -PassThru
        } else {
            Write-Host "Frontend not found at: $frontendPath (missing package.json). Skipping frontend start."
        }
    }

    $pids = [PSCustomObject]@{
        started_at = (Get-Date).ToString('o')
        backend_host = $BackendHost
        backend_port = [int]$BackendPort
        start_frontend = [bool](-not $NoFrontend)
        frontend_dir = $FrontendDir
        frontend_pid = if ($frontendProc) { [int]$frontendProc.Id } else { $null }
        start_llama = [bool]$StartLlama
        llama_pid = $llamaPid
        llama_started_by_script = [bool]$llamaStartedByScript
        out_dir = $OutDir
    }
    Write-Json $pids $devPidPath

    Write-Host "Dev PIDs saved: $devPidPath"
    Write-Host "Starting backend dev server... (Ctrl+C to stop)"

    $runBackend = Join-Path $PSScriptRoot "run_backend_dev.ps1"
    if (-not (Test-Path -LiteralPath $runBackend -PathType Leaf)) {
        throw "Missing script: $runBackend"
    }

    & $runBackend -Port $BackendPort -ListenHost $BackendHost
}
finally {
    if ($frontendProc) {
        try {
            Stop-Process -Id $frontendProc.Id -Force -ErrorAction SilentlyContinue
        } catch {
        }
    }

    if ($StartLlama -and $llamaStartedByScript -and $llamaPid) {
        try {
            Stop-Process -Id $llamaPid -Force -ErrorAction SilentlyContinue
        } catch {
        }
    }
}

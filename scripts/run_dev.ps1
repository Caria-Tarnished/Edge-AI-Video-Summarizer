param(
    [Alias("Host")]
    [string]$BackendHost = "127.0.0.1",
    [int]$BackendPort = 8001,

    [switch]$NoFrontend,
    [string]$FrontendDir = "frontend",

    [switch]$StartLlama,
    [string]$LlamaServerExe = "F:\\LLAMA\\bin\\llama-server.exe",
    [string]$LlamaModelPath = "F:\\LLAMA\\models\\Qwen2.5-7B-Instruct\\Qwen2.5-7B-Instruct-Q4_K_M.gguf",
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
$devConfigPath = Join-Path $absOutDir "dev_config.json"
$devErrorPath = Join-Path $absOutDir "dev_last_error.txt"
$frontendProc = $null
$llamaPid = $null
$llamaStartedByScript = $false

try {
    try {
        if (Test-Path -LiteralPath $devErrorPath -PathType Leaf) {
            Remove-Item -LiteralPath $devErrorPath -Force -ErrorAction SilentlyContinue
        }
    } catch {
    }

    Write-Host "Repo root: $root"
    Write-Host "Artifacts dir: $absOutDir"

    if (Test-Path -LiteralPath $devConfigPath -PathType Leaf) {
        try {
            $cfg = (Get-Content -LiteralPath $devConfigPath | ConvertFrom-Json)

            if (-not $PSBoundParameters.ContainsKey('LlamaServerExe') -and $cfg.llama_server_exe) {
                $LlamaServerExe = [string]$cfg.llama_server_exe
            }
            if (-not $PSBoundParameters.ContainsKey('LlamaModelPath') -and $cfg.llama_model_path) {
                $LlamaModelPath = [string]$cfg.llama_model_path
            }
            if (-not $PSBoundParameters.ContainsKey('LlamaPort') -and $cfg.llama_port) {
                $LlamaPort = [int]$cfg.llama_port
            }
            if (-not $PSBoundParameters.ContainsKey('LocalLLMBaseUrl') -and $cfg.local_llm_base_url) {
                $LocalLLMBaseUrl = [string]$cfg.local_llm_base_url
            }
        } catch {
        }
    }

    function Try-HttpOk([string]$url, [int]$timeoutSeconds) {
        try {
            $args = @{ Uri = $url; Method = "Get"; TimeoutSec = $timeoutSeconds }
            Invoke-WebRequest @args | Out-Null
            return $true
        } catch {
            return $false
        }
    }

    $backendBase = "http://${BackendHost}:${BackendPort}".TrimEnd('/')
    $backendHealthUrl = ($backendBase + "/health")
    $backendAlreadyRunning = (Try-HttpOk $backendHealthUrl 2)

    $env:LLM_LOCAL_BASE_URL = $LocalLLMBaseUrl.TrimEnd('/')

    if ($StartLlama) {
        if (-not (Test-Path -LiteralPath $LlamaModelPath -PathType Leaf)) {
            try {
                $modelDir = Split-Path -Parent $LlamaModelPath
                if ($modelDir -and (Test-Path -LiteralPath $modelDir -PathType Container)) {
                    $gguf = Get-ChildItem -Path $modelDir -Filter "*.gguf" -File -ErrorAction SilentlyContinue | Select-Object -First 1
                    if ($gguf -and $gguf.FullName) {
                        $LlamaModelPath = [string]$gguf.FullName
                    }
                }
            } catch {
            }
        }

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
    }

    if (-not $NoFrontend) {
        $frontendPath = Join-Path $root $FrontendDir
        $pkg = Join-Path $frontendPath "package.json"
        if (Test-Path -LiteralPath $pkg -PathType Leaf) {
            $nodeModules = Join-Path $frontendPath "node_modules"
            if (-not (Test-Path -LiteralPath $nodeModules -PathType Container)) {
                Write-Host "Frontend dependencies not installed. Please run: npm install (in $frontendPath)"
            } else {
            $env:EDGE_VIDEO_AGENT_CORS_ORIGINS = "http://localhost:5173,http://127.0.0.1:5173"
            $env:EDGE_VIDEO_AGENT_REPO_ROOT = $root
            $cmd = "`$env:VITE_BACKEND_BASE_URL = '$backendBase'; npm run dev"
            $frontendProc = Start-Process -FilePath "powershell.exe" -ArgumentList @(
                "-NoProfile",
                "-NoExit",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                $cmd
            ) -WorkingDirectory $frontendPath -PassThru
            }
        } else {
            Write-Host "Frontend not found at: $frontendPath (missing package.json). Skipping frontend start."
        }
    }

    $pids = [PSCustomObject]@{
        started_at = (Get-Date).ToString('o')
        backend_host = $BackendHost
        backend_port = [int]$BackendPort
        start_frontend = [bool]($frontendProc -ne $null)
        frontend_dir = $FrontendDir
        frontend_pid = if ($frontendProc) { [int]$frontendProc.Id } else { $null }
        start_llama = [bool]$StartLlama
        llama_pid = $llamaPid
        llama_started_by_script = [bool]$llamaStartedByScript
        out_dir = $OutDir
    }
    Write-Json $pids $devPidPath

    Write-Host "Dev PIDs saved: $devPidPath"
    if ($backendAlreadyRunning) {
        Write-Host "Backend already running: $backendBase"
        Write-Host "Keeping launcher alive. Press Ctrl+C to stop frontend/llama (backend will not be stopped)."
        while ($true) {
            Start-Sleep -Seconds 1
        }
    }

    Write-Host "Starting backend dev server... (Ctrl+C to stop)"

    $runBackend = Join-Path $PSScriptRoot "run_backend_dev.ps1"
    if (-not (Test-Path -LiteralPath $runBackend -PathType Leaf)) {
        throw "Missing script: $runBackend"
    }

    & $runBackend -Port $BackendPort -ListenHost $BackendHost
}
catch {
    $msg = ($_ | Out-String)
    try {
        $lines = @()
        $lines += "timestamp: $((Get-Date).ToString('o'))"
        $lines += "message: $($_.Exception.Message)"
        $lines += "full:"
        $lines += $msg
        $lines -join "`r`n" | Set-Content -Encoding utf8 -Path $devErrorPath
        Write-Host "Error saved: $devErrorPath"
    } catch {
    }
    throw
}
finally {
    if ($frontendProc) {
        try {
            Stop-Process -Id $frontendProc.Id -Force -ErrorAction SilentlyContinue
        } catch {
        }
        try {
            & taskkill.exe /PID $frontendProc.Id /F /T | Out-Null
        } catch {
        }
    }

    if ($StartLlama -and $llamaStartedByScript -and $llamaPid) {
        try {
            Stop-Process -Id $llamaPid -Force -ErrorAction SilentlyContinue
        } catch {
        }
        try {
            & taskkill.exe /PID $llamaPid /F /T | Out-Null
        } catch {
        }
    }
}

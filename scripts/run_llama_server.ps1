param(
    [string]$LlamaServerExe = "F:\LLAMA\bin\llama-server.exe",
    [string]$ModelPath = "F:\LLAMA\models\Qwen2.5-7B-Instruct\qwen2.5-7b-instruct-q4_k_m.gguf",
    [Alias("Host")]
    [string]$ListenHost = "127.0.0.1",
    [int]$Port = 8080,
    [int]$CtxSize = 4096,
    [int]$Threads = 0,
    [int]$GpuLayers = -1,
    [string]$ApiBaseUrl = "",
    [int]$StartupTimeoutSeconds = 60,
    [switch]$Foreground,
    [string]$OutDir = "artifacts",
    [string[]]$ExtraArgs = @()
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$root = Split-Path -Parent $PSScriptRoot

if (-not $ApiBaseUrl) {
    $ApiBaseUrl = "http://${ListenHost}:$Port/v1"
}
$ApiBaseUrl = $ApiBaseUrl.TrimEnd('/')

if (-not $LlamaServerExe) {
    throw "Must provide -LlamaServerExe (path to llama-server.exe)"
}
if (-not (Test-Path -LiteralPath $LlamaServerExe)) {
    throw "llama-server.exe not found: $LlamaServerExe"
}

if (-not $ModelPath) {
    throw "Must provide -ModelPath (path to .gguf)"
}
if (-not (Test-Path -LiteralPath $ModelPath)) {
    throw "ModelPath not found: $ModelPath"
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$logDir = Join-Path $OutDir "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$ts = (Get-Date).ToString("yyyyMMdd_HHmmss")
$stdoutPath = Join-Path $logDir "llama_server_${ts}.stdout.log"
$stderrPath = Join-Path $logDir "llama_server_${ts}.stderr.log"

$iwrHasBasic = $false
try {
    $iwrHasBasic = (Get-Command Invoke-WebRequest).Parameters.ContainsKey("UseBasicParsing")
} catch {
    $iwrHasBasic = $false
}

function Wait-Models([int]$timeoutSeconds) {
    $deadline = (Get-Date).AddSeconds($timeoutSeconds)
    $url = "$ApiBaseUrl/models"
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
            throw "llama-server not ready at $url (timeout ${timeoutSeconds}s)"
        }
        Start-Sleep -Milliseconds 500
    }
}

$argsList = @()
$argsList += "--host"; $argsList += $ListenHost
$argsList += "--port"; $argsList += "$Port"
$argsList += "-m"; $argsList += $ModelPath
$argsList += "-c"; $argsList += "$CtxSize"

if ($Threads -gt 0) {
    $argsList += "-t"; $argsList += "$Threads"
}

if ($GpuLayers -ge 0) {
    $argsList += "-ngl"; $argsList += "$GpuLayers"
}

if ($ExtraArgs -and $ExtraArgs.Count -gt 0) {
    $argsList += $ExtraArgs
}

Write-Host "Starting llama-server..."
Write-Host "  exe:   $LlamaServerExe"
Write-Host "  model: $ModelPath"
Write-Host "  url:   $ApiBaseUrl"
Write-Host "  args:  $($argsList -join ' ')"

if ($Foreground) {
    & $LlamaServerExe @argsList
    exit 0
}

$p = Start-Process -FilePath $LlamaServerExe -ArgumentList $argsList -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath

$pidPath = Join-Path $OutDir "llama_server.pid"
"$($p.Id)" | Set-Content -Encoding ascii -Path $pidPath

Write-Host "llama-server pid: $($p.Id)"
Write-Host "stdout: $stdoutPath"
Write-Host "stderr: $stderrPath"

$modelsRaw = Wait-Models $StartupTimeoutSeconds
$modelsPath = Join-Path $OutDir "llama_models_${ts}.json"
$modelsRaw | Set-Content -Encoding utf8 -Path $modelsPath

Write-Host "llama-server ready: $ApiBaseUrl"
Write-Host "models saved: $modelsPath"
Write-Host "OK"

return [PSCustomObject]@{
    pid = [int]$p.Id
    api_base_url = $ApiBaseUrl
    stdout_path = $stdoutPath
    stderr_path = $stderrPath
    models_path = $modelsPath
    pid_path = $pidPath
}

param(
    [string]$OutDir = "artifacts",
    [switch]$ForceStop,
    [int]$BackendPort = 8001,
    [int]$LlamaPort = 8080
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$root = Split-Path -Parent $PSScriptRoot
$absOutDir = Join-Path $root $OutDir
$devPidPath = Join-Path $absOutDir "dev_pids.json"

function Read-Json([string]$path) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        return $null
    }
    try {
        return (Get-Content -LiteralPath $path -ErrorAction Stop | ConvertFrom-Json)
    } catch {
        return $null
    }
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

function Force-KillPidTree([int]$TargetPid) {
    if (-not $TargetPid -or $TargetPid -le 0) {
        return
    }
    try {
        Stop-Process -Id $TargetPid -Force -ErrorAction SilentlyContinue
    } catch {
    }
    try {
        & taskkill.exe /PID $TargetPid /F /T | Out-Null
    } catch {
    }
}

function Stop-Pid([string]$name, [int]$pid, [bool]$allowStop, [int]$port = 0) {
    if (-not $pid -and $port) {
        $pid = Find-ListeningPid $port
    }
    if (-not $pid) {
        Write-Host "${name}: no pid"
        return
    }

    if (-not $allowStop) {
        Write-Host "${name}: skip stop (not started by script). pid=$pid"
        return
    }

    Write-Host "Stopping ${name} pid=$pid ..."
    Force-KillPidTree $pid
    Write-Host "${name}: stopped"
}

$record = Read-Json $devPidPath
if (-not $record) {
    Write-Host "No pid record found: $devPidPath"
    Write-Host "Use -ForceStop to attempt stopping by ports."
}

$frontendPid = $null
$llamaPid = $null
$allowStopFrontend = [bool]$ForceStop
$allowStopLlama = [bool]$ForceStop
$allowStopBackend = [bool]$ForceStop

if ($record) {
    try { $frontendPid = [int]$record.frontend_pid } catch { $frontendPid = $null }
    try { $llamaPid = [int]$record.llama_pid } catch { $llamaPid = $null }

    if (-not $ForceStop) {
        $allowStopFrontend = ($frontendPid -ne $null)
        $allowStopLlama = [bool]$record.llama_started_by_script
        $allowStopBackend = $true
    }
}

Stop-Pid -name "frontend" -pid $frontendPid -allowStop:$allowStopFrontend
Stop-Pid -name "llama-server" -pid $llamaPid -allowStop:$allowStopLlama -port $LlamaPort
Stop-Pid -name "backend" -pid 0 -allowStop:$allowStopBackend -port $BackendPort

Write-Host "OK"

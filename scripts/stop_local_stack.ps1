param(
    [string]$OutDir = "artifacts",
    [switch]$ForceStop
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$pidRecordPath = Join-Path $OutDir "local_stack_pids.json"
$llamaPidPath = Join-Path $OutDir "llama_server.pid"
$backendPidPath = Join-Path $OutDir "backend.pid"

$record = $null
if (Test-Path -LiteralPath $pidRecordPath -PathType Leaf) {
    try {
        $record = (Get-Content -LiteralPath $pidRecordPath -ErrorAction Stop | ConvertFrom-Json)
    } catch {
        $record = $null
    }
}

function Read-PidFile([string]$path) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        return $null
    }
    $raw = Get-Content -LiteralPath $path -ErrorAction Stop | Select-Object -First 1
    if (-not $raw) {
        return $null
    }
    try {
        return [int]$raw
    } catch {
        return $null
    }
}

function Stop-Pid([string]$name, [int]$pid, [switch]$allowStop) {
    if (-not $pid) {
        Write-Host "$name: no pid"
        return
    }

    if (-not $allowStop) {
        Write-Host "$name: skip stop (not started by script). pid=$pid"
        return
    }

    try {
        $p = Get-Process -Id $pid -ErrorAction Stop
    } catch {
        Write-Host "$name: process not found. pid=$pid"
        return
    }

    Write-Host "Stopping $name pid=$pid ..."
    try {
        Stop-Process -Id $pid -Force -ErrorAction Stop
        Write-Host "$name: stopped"
    } catch {
        Write-Host "$name: failed to stop pid=$pid"
        throw
    }
}

$llamaPid = Read-PidFile $llamaPidPath
$backendPid = Read-PidFile $backendPidPath

$allowStopLlama = $ForceStop
$allowStopBackend = $ForceStop

if (-not $ForceStop -and $record) {
    $allowStopLlama = [bool]$record.llama_server_started_by_script
    $allowStopBackend = [bool]$record.backend_started_by_script
}

if (-not $ForceStop -and -not $record) {
    Write-Host "No pid record found: $pidRecordPath"
    Write-Host "Use -ForceStop to stop processes based on pid files only."
}

Stop-Pid -name "llama-server" -pid $llamaPid -allowStop:$allowStopLlama
Stop-Pid -name "backend" -pid $backendPid -allowStop:$allowStopBackend

Write-Host "OK"

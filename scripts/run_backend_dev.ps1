param(
    [int]$Port = 8001,
    [Alias("Host")]
    [string]$ListenHost = "127.0.0.1"
)

$ErrorActionPreference = "Stop"

$env:KMP_DUPLICATE_LIB_OK = "TRUE"

$existing = $null
try {
    $existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop
} catch {
    $existing = $null
}
if ($existing) {
    $pids = $existing | Select-Object -ExpandProperty OwningProcess -Unique
    $pidStr = ($pids -join ",")
    throw "Port already in use: ${ListenHost}:$Port (listening pid(s): $pidStr)"
}

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$backend = Join-Path $root "..\backend"

$pythonExe = Join-Path $backend ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $pythonExe)) {
    $pythonExe = "python"
}

Push-Location $backend
try {
    & $pythonExe -m uvicorn app.main:app --host $ListenHost --port $Port --reload
} finally {
    Pop-Location
}

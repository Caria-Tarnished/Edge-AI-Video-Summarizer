param(
    [int]$Port = 8001,
    [Alias("Host")]
    [string]$ListenHost = "127.0.0.1"
)

$ErrorActionPreference = "Stop"

$env:KMP_DUPLICATE_LIB_OK = "TRUE"

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

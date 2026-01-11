param(
    [switch]$Quiet
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$backendDir = Join-Path $root "backend"
$py = Join-Path $backendDir ".venv\Scripts\python.exe"

if (-not (Test-Path -LiteralPath $py)) {
    throw "Python venv not found: $py. Please create venv in backend/.venv and install dependencies."
}

function Run-Step {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string[]]$Args
    )

    if (-not $Quiet) {
        Write-Host "==> $Name" -ForegroundColor Cyan
        Write-Host ("& '{0}' {1}" -f $py, ($Args -join " "))
    }

    Push-Location $backendDir
    try {
        & $py @Args
        if ($LASTEXITCODE -ne 0) {
            throw "Step failed ($Name) with exit code $LASTEXITCODE"
        }
    } finally {
        Pop-Location
    }
}

Run-Step -Name "flake8" -Args @("-m", "flake8", "app")
Run-Step -Name "mypy" -Args @(
    "-m",
    "mypy",
    "app",
    "--ignore-missing-imports",
    "--show-error-codes"
)
Run-Step -Name "pyright" -Args @(
    "-m",
    "pyright",
    "-p",
    $backendDir
)
Run-Step -Name "pytest" -Args @("-m", "pytest", "-q")

if (-not $Quiet) {
    Write-Host "All checks passed." -ForegroundColor Green
}

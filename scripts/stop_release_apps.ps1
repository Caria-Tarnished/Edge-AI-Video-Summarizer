param(
    [string]$ReleaseDir = "release",
    [switch]$IncludeAllInRelease
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = Split-Path -Parent $PSScriptRoot
$absRelease = Join-Path $repoRoot $ReleaseDir

if (-not (Test-Path -LiteralPath $absRelease -PathType Container)) {
    Write-Host "Release dir not found: $absRelease"
    exit 0
}

try {
    $absRelease = (Resolve-Path -LiteralPath $absRelease).Path
} catch {
}

$absReleaseLower = $absRelease.ToLowerInvariant().TrimEnd('\\') + "\\"

$targets = @()
try {
    $procs = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    foreach ($p in $procs) {
        $exe = ""
        try { $exe = [string]$p.ExecutablePath } catch { $exe = "" }
        if (-not $exe) { continue }

        $exeLower = $exe.ToLowerInvariant()
        if (-not ($exeLower.StartsWith($absReleaseLower))) { continue }

        if (-not $IncludeAllInRelease) {
            if ($exeLower -notlike "*\\win-unpacked\\*") { continue }
        }

        $targets += $p
    }
} catch {
    Write-Host "Failed to query running processes: $($_.Exception.Message)"
    exit 1
}

if (-not $targets -or $targets.Count -eq 0) {
    Write-Host "No running processes found under: $absRelease"
    exit 0
}

$uniquePids = @($targets | Select-Object -ExpandProperty ProcessId -Unique)

foreach ($pid in $uniquePids) {
    if (-not $pid -or $pid -le 0) { continue }

    $path = ""
    try {
        $pp = $targets | Where-Object { $_.ProcessId -eq $pid } | Select-Object -First 1
        if ($pp) { $path = [string]$pp.ExecutablePath }
    } catch {
        $path = ""
    }

    Write-Host "Stopping pid=$pid path=$path"

    try { Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue } catch { }
    try { & taskkill.exe /PID $pid /F /T 2>$null | Out-Null } catch { }
}

Start-Sleep -Milliseconds 500
Write-Host "OK"

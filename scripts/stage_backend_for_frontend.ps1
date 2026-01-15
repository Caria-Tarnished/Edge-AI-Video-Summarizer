param(
    [string]$BackendDistDir = "artifacts\\pyinstaller_backend\\dist\\edge-video-agent-backend",
    [string]$FrontendDir = "frontend",
    [string]$TargetRelative = "resources\\backend\\edge-video-agent-backend"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$root = Split-Path -Parent $PSScriptRoot

$src = Join-Path $root $BackendDistDir
if (-not (Test-Path -LiteralPath $src -PathType Container)) {
    throw "Backend dist dir not found: $src"
}

$exe = Join-Path $src "edge-video-agent-backend.exe"
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    throw "Backend exe not found: $exe"
}

$dst = Join-Path (Join-Path $root $FrontendDir) $TargetRelative

if (-not (Test-Path -LiteralPath $dst -PathType Container)) {
    New-Item -ItemType Directory -Force -Path $dst | Out-Null
}

# Clean target first to avoid stale _internal/ content.
try {
    if (Test-Path -LiteralPath $dst -PathType Container) {
        Remove-Item -LiteralPath $dst -Recurse -Force -ErrorAction SilentlyContinue
    }
} catch {
}
New-Item -ItemType Directory -Force -Path $dst | Out-Null

Copy-Item -Path (Join-Path $src "*") -Destination $dst -Recurse -Force

Write-Host ""
Write-Host "Staging done. Backend copied to: $dst"
Write-Host "Expected packaged lookup path: resources\\backend\\edge-video-agent-backend\\edge-video-agent-backend.exe"
Write-Host ""

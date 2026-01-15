param(
    [string]$OutDir = "artifacts\\pyinstaller_backend",
    [switch]$NoInstallDeps
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$root = Split-Path -Parent $PSScriptRoot
$backend = Join-Path $root "backend"

$pythonExe = Join-Path $backend ".venv\\Scripts\\python.exe"
if (-not (Test-Path -LiteralPath $pythonExe -PathType Leaf)) {
    throw "backend/.venv python not found: $pythonExe"
}

$absOutDir = Join-Path $root $OutDir
$distDir = Join-Path $absOutDir "dist"
$workDir = Join-Path $absOutDir "build"
$specDir = Join-Path $absOutDir "spec"

New-Item -ItemType Directory -Force -Path $distDir | Out-Null
New-Item -ItemType Directory -Force -Path $workDir | Out-Null
New-Item -ItemType Directory -Force -Path $specDir | Out-Null

Push-Location $backend
try {
    if (-not $NoInstallDeps) {
        & $pythonExe -m pip install -r requirements.txt
        if ($LASTEXITCODE -ne 0) { throw "pip install requirements.txt failed with exit code $LASTEXITCODE" }
        & $pythonExe -m pip install -r requirements-dev.txt
        if ($LASTEXITCODE -ne 0) { throw "pip install requirements-dev.txt failed with exit code $LASTEXITCODE" }
    }

    $pyiArgs = @(
        "--noconfirm",
        "--clean",
        "--onedir",
        "--exclude-module",
        "onnxruntime.tools",
        "--name",
        "edge-video-agent-backend",
        "--distpath",
        $distDir,
        "--workpath",
        $workDir,
        "--specpath",
        $specDir,
        "--collect-all",
        "faster_whisper",
        "--collect-all",
        "ctranslate2",
        "--collect-all",
        "chromadb",
        "--collect-all",
        "fastembed",
        "--collect-binaries",
        "onnxruntime",
        "--collect-data",
        "onnxruntime",
        "--collect-all",
        "imageio_ffmpeg",
        "run_backend.py"
    )

    $pyArgListLiteral = ($pyiArgs | ForEach-Object {
        $s = [string]$_
        "'" + ($s -replace "\\", "\\\\" -replace "'", "\\'") + "'"
    }) -join ", "

    $pyCode = "import sys`n" +
        "sys.setrecursionlimit(sys.getrecursionlimit() * 10)`n" +
        "from PyInstaller.__main__ import run`n" +
        "run([" + $pyArgListLiteral + "])`n"

    & $pythonExe -c $pyCode
    if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed with exit code $LASTEXITCODE" }

    $exePath = Join-Path $distDir "edge-video-agent-backend\\edge-video-agent-backend.exe"
    if (-not (Test-Path -LiteralPath $exePath -PathType Leaf)) {
        throw "Build finished but exe not found: $exePath"
    }

    Write-Host ""
    Write-Host "Backend build done. Output: $exePath"
    Write-Host ""
} finally {
    Pop-Location
}

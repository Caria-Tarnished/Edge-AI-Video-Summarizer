param(
    [string]$OutDir = "artifacts",
    [switch]$ForceStop,
    [int]$BackendPort = 8001,
    [int]$LlamaPort = 8080
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

function Test-IsAdmin {
    try {
        $currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object Security.Principal.WindowsPrincipal($currentIdentity)
        return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch {
        return $false
    }
}

function Force-KillPidTree([int]$TargetPid) {
    if (-not $TargetPid -or $TargetPid -le 0) {
        return
    }
    Stop-Process -Id $TargetPid -Force -ErrorAction SilentlyContinue
    try {
        $out = & taskkill.exe /PID $TargetPid /F /T 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Host "taskkill failed for pid=$TargetPid (exit=$LASTEXITCODE): $out"
        }
    } catch {
        return
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

function Get-ParentPid([int]$ChildPid) {
    if (-not $ChildPid -or $ChildPid -le 0) {
        return $null
    }
    try {
        $p = Get-CimInstance Win32_Process -Filter "ProcessId=$ChildPid" -ErrorAction Stop
        if ($p -and $p.ParentProcessId) {
            return [int]$p.ParentProcessId
        }
    } catch {
        return $null
    }
    return $null
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

function Stop-Pid(
    [string]$name,
    [int]$targetPid,
    [switch]$allowStop,
    [int]$port
) {
    if (-not $targetPid) {
        if ($allowStop -and $port) {
            $portPid = Find-ListeningPid $port
            if ($portPid) {
                $targetPid = $portPid
            } else {
                Write-Host "${name}: no pid"
                return
            }
        } else {
            Write-Host "${name}: no pid"
            return
        }
    }

    if (-not $allowStop) {
        Write-Host "${name}: skip stop (not started by script). pid=$targetPid"
        return
    }

    try {
        $p = Get-Process -Id $targetPid -ErrorAction Stop
    } catch {
        if ($allowStop -and $port) {
            $portPid = Find-ListeningPid $port
            if ($portPid) {
                $targetPid = $portPid
            } else {
                Write-Host "${name}: process not found. pid=$targetPid"
                return
            }
        } else {
            Write-Host "${name}: process not found. pid=$targetPid"
            return
        }
    }

    Write-Host "Stopping ${name} pid=$targetPid ..."

    try {
        Stop-Process -Id $targetPid -Force -ErrorAction Stop
    } catch {
        if ("$($_.FullyQualifiedErrorId)" -notlike "*NoProcessFoundForGivenId*") {
            Write-Host "${name}: Stop-Process error: $($_.Exception.Message)"
        }
    }

    if ($port) {
        $deadline = (Get-Date).AddSeconds(10)
        while ($true) {
            $stillPid = Find-ListeningPid $port
            if (-not $stillPid) {
                break
            }

            if ((Get-Date) -gt $deadline) {
                Force-KillPidTree $stillPid
                $parentPid = Get-ParentPid $stillPid
                if ($parentPid -and $parentPid -ne $stillPid) {
                    Force-KillPidTree $parentPid
                }
                $stillPid2 = Find-ListeningPid $port
                if ($stillPid2) {
                    throw (
                        "${name}: port $port still listening. pid=$stillPid2. " +
                        "Try running PowerShell as Administrator or reboot."
                    )
                }
                break
            }

            Force-KillPidTree $stillPid
            $parentPid = Get-ParentPid $stillPid
            if ($parentPid -and $parentPid -ne $stillPid) {
                Force-KillPidTree $parentPid
            }

            Start-Sleep -Milliseconds 300
        }
    }

    Write-Host "${name}: stopped"
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

if ($ForceStop -and -not (Test-IsAdmin)) {
    Write-Host "WARNING: Not running as Administrator. If a process was started elevated, stop may fail."
}

Stop-Pid -name "llama-server" -targetPid $llamaPid -allowStop:$allowStopLlama -port $LlamaPort
Stop-Pid -name "backend" -targetPid $backendPid -allowStop:$allowStopBackend -port $BackendPort

Write-Host "OK"

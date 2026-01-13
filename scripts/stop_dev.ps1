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

function Find-ListeningPids([int]$port) {
    if (-not $port -or $port -le 0) {
        return @()
    }
    try {
        $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop
        $pids = $conns | Select-Object -ExpandProperty OwningProcess -Unique
        if ($pids) {
            return @($pids | ForEach-Object { [int]$_ })
        }
    } catch {
        return @()
    }
    return @()
}

function Find-ListeningPidsNetstat([int]$port) {
    if (-not $port -or $port -le 0) {
        return @()
    }
    try {
        $raw = & cmd.exe /c "netstat -ano -p tcp | findstr :$port" 2>$null
        if (-not $raw) {
            return @()
        }
        $lines = @($raw)
        $hits = @()
        foreach ($line in $lines) {
            $m = [regex]::Match([string]$line, "\s(LISTENING|\u4fa6\u542c)\s+(\d+)\s*$")
            if ($m.Success) {
                try { $hits += [int]$m.Groups[2].Value } catch { }
            }
        }
        if ($hits -and $hits.Count -gt 0) {
            return @($hits | Select-Object -Unique)
        }
    } catch {
        return @()
    }
    return @()
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
        & taskkill.exe /PID $TargetPid /F /T 2>$null | Out-Null
    } catch {
    }
}

function Stop-Pid([string]$name, [Alias('pid')][int]$TargetPid, [bool]$allowStop, [int]$port = 0) {
    $targets = @()
    if ($TargetPid -and $TargetPid -gt 0) {
        $targets = @([int]$TargetPid)
    } elseif ($port) {
        $targets = Find-ListeningPids $port
    }
    if (-not $targets -or $targets.Count -eq 0) {
        Write-Host "${name}: no pid"
        return
    }

    if (-not $allowStop) {
        Write-Host "${name}: skip stop (not started by script). pids=$($targets -join ',')"
        return
    }

    foreach ($p in $targets) {
        Write-Host "Stopping ${name} pid=$p ..."

        if ($name -eq "backend") {
            try {
                $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$p" -ErrorAction SilentlyContinue
                $parentPid = $null
                try { $parentPid = [int]$proc.ParentProcessId } catch { $parentPid = $null }
                if ($parentPid -and $parentPid -gt 0 -and $parentPid -ne $p) {
                    $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$parentPid" -ErrorAction SilentlyContinue
                    $cmd = ""
                    try { $cmd = [string]$parent.CommandLine } catch { $cmd = "" }
                    $pname = ""
                    try { $pname = [string]$parent.Name } catch { $pname = "" }
                    if ($pname -match "python" -and ($cmd -match "uvicorn" -or $cmd -match "app\.main:app")) {
                        Write-Host "Stopping backend parent pid=$parentPid ..."
                        Force-KillPidTree $parentPid
                    }
                }
            } catch {
            }
        }

        Force-KillPidTree $p
    }
    Write-Host "${name}: stopped"

    if ($name -eq "backend" -and $port -and $port -gt 0) {
        $tries = 0
        while ($tries -lt 6) {
            $tries += 1
            $left = @()
            try {
                $left = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
            } catch {
                $left = @()
            }
            if (-not $left -or $left.Count -eq 0) {
                return
            }

            foreach ($lp in $left) {
                try { Force-KillPidTree ([int]$lp) } catch { }
            }

            # Fallback: uvicorn --reload may keep a reloader python process alive.
            try {
                $uvicorn = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
                    Where-Object { $_.Name -match "python" -and $_.CommandLine -and ($_.CommandLine -match "uvicorn") -and ($_.CommandLine -match "app\.main:app") })
                foreach ($u in $uvicorn) {
                    try { Force-KillPidTree ([int]$u.ProcessId) } catch { }
                }
            } catch {
            }

            # Fallback: if CIM/command line is unavailable, use netstat PID list.
            try {
                $netPids = Find-ListeningPidsNetstat $port
                foreach ($np in $netPids) {
                    try { Force-KillPidTree ([int]$np) } catch { }
                }
            } catch {
            }

            Start-Sleep -Milliseconds 500
        }
    }
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

param(
    [Parameter(Mandatory = $true)][string]$JobId,
    [string]$WsBase = "ws://127.0.0.1:8001"
)

$ErrorActionPreference = "Stop"

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    throw "node not found. Please install Node.js, then run: npm i ws"
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$js = Join-Path $scriptDir "ws_watch.js"

node $js $JobId $WsBase

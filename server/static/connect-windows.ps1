$ErrorActionPreference = "Stop"
$BaseUrl = "{{origin}}"
$BridgeWsUrl = "{{ws_origin}}/ws"
$Code = "{{code}}"
$BridgeName = "cya-bridge-windows-x64.exe"
$InstallDir = Join-Path $env:TEMP "cya"
$BridgePath = Join-Path $InstallDir $BridgeName

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Write-Host "Downloading CYA bridge for Windows x64..."
Invoke-WebRequest -Uri "$BaseUrl/bin/$BridgeName" -OutFile $BridgePath

$env:BRIDGE_WS_URL = $BridgeWsUrl
Write-Host "Starting CYA bridge session $Code..."
& $BridgePath $Code

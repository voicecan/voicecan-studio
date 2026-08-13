$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$Architecture = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$node = Join-Path $ProjectRoot ".runtime\node-v24.19.0-win-$Architecture\node.exe"
$envFile = Join-Path $ProjectRoot '.env'
if (-not (Test-Path -LiteralPath $node)) { throw 'Private Node runtime is missing. Run scripts/setup-local-windows.ps1 first.' }
if (-not (Test-Path -LiteralPath $envFile)) { throw '.env is missing. Run scripts/setup-local-windows.ps1 first.' }
Set-Location $ProjectRoot

Write-Host 'Voicecan Studio - Local Full'
Write-Host "Project: $ProjectRoot"
Write-Host "Node: $(& $node --version) (project-private runtime)"
Write-Host "Environment: $envFile"
Write-Host 'Starting the service. Platform reconciliation and local model loading may take some time.'
Write-Host 'The exact UI and health-check URLs will be printed when the HTTP server is listening.'
Write-Host 'Press Ctrl+C to stop.'
Write-Host ''

& $node --env-file=.env dist/main-local.js
exit $LASTEXITCODE

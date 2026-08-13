param(
  [switch]$NonInteractive,
  [string]$ModelEndpoint = $env:HF_ENDPOINT
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$RuntimeRoot = Join-Path $ProjectRoot '.runtime'
$DownloadRoot = Join-Path $RuntimeRoot 'downloads'
$Architecture = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$NodeVersion = '24.19.0'
$UvVersion = '0.10.2'

function Save-VerifiedDownload {
  param([string]$Url, [string]$Destination, [string]$Sha256)
  if (-not (Test-Path -LiteralPath $Destination)) {
    Invoke-WebRequest -Uri $Url -OutFile $Destination
  }
  $actual = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $Sha256) { throw "SHA-256 mismatch for $Destination" }
}

function Get-EnvValue {
  param([string]$Path, [string]$Key)
  $line = Get-Content -LiteralPath $Path | Where-Object { $_ -match "^$([regex]::Escape($Key))=" } | Select-Object -Last 1
  if (-not $line) { return '' }
  return ($line -split '=', 2)[1].Trim()
}

function Set-EnvValue {
  param([string]$Path, [string]$Key, [string]$Value)
  $lines = [Collections.Generic.List[string]]::new()
  $found = $false
  foreach ($line in Get-Content -LiteralPath $Path) {
    if ($line -match "^$([regex]::Escape($Key))=") {
      if (-not $found) { $lines.Add("$Key=$Value"); $found = $true }
    } else { $lines.Add($line) }
  }
  if (-not $found) { $lines.Add("$Key=$Value") }
  [IO.File]::WriteAllLines($Path, $lines, [Text.UTF8Encoding]::new($false))
}

function Remove-EnvValue {
  param([string]$Path, [string]$Key)
  $lines = Get-Content -LiteralPath $Path | Where-Object { $_ -notmatch "^$([regex]::Escape($Key))=" }
  [IO.File]::WriteAllLines($Path, $lines, [Text.UTF8Encoding]::new($false))
}

function Read-SecretValue {
  param([string]$Prompt)
  $secure = Read-Host $Prompt -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

New-Item -ItemType Directory -Force -Path $RuntimeRoot, $DownloadRoot | Out-Null
Set-Location $ProjectRoot

$nodeAsset = "node-v$NodeVersion-win-$Architecture.zip"
$nodeSha = if ($Architecture -eq 'arm64') {
  '8502f4a50b458d4cc38ed8f2001556c2cd239d464920f74017926ccb1e1c157f'
} else {
  '57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73'
}
$nodeArchive = Join-Path $DownloadRoot $nodeAsset
$nodeHome = Join-Path $RuntimeRoot "node-v$NodeVersion-win-$Architecture"
$nodeExe = Join-Path $nodeHome 'node.exe'
Save-VerifiedDownload "https://nodejs.org/dist/v$NodeVersion/$nodeAsset" $nodeArchive $nodeSha
if (-not (Test-Path -LiteralPath $nodeExe)) {
  if (Test-Path -LiteralPath $nodeHome) { throw "Incomplete private Node runtime exists: $nodeHome" }
  Expand-Archive -LiteralPath $nodeArchive -DestinationPath $RuntimeRoot
}
if ((& $nodeExe --version) -ne "v$NodeVersion") { throw 'Private Node runtime verification failed.' }
$npm = Join-Path $nodeHome 'npm.cmd'

$uvTarget = if ($Architecture -eq 'arm64') { 'aarch64-pc-windows-msvc' } else { 'x86_64-pc-windows-msvc' }
$uvAsset = "uv-$uvTarget.zip"
$uvSha = if ($Architecture -eq 'arm64') {
  '826e4ee3a03ec245e54c449e272fdf8aab749e039cc49c950ad43cc13702221f'
} else {
  '493ebbe0e06128d6ee4905e1ed5e2a433fb0f7cfc08b0eaca9fab4ca76778ae1'
}
$uvArchive = Join-Path $DownloadRoot $uvAsset
$uvHome = Join-Path $RuntimeRoot "uv-v$UvVersion-win-$Architecture"
Save-VerifiedDownload "https://github.com/astral-sh/uv/releases/download/$UvVersion/$uvAsset" $uvArchive $uvSha
if (-not (Test-Path -LiteralPath $uvHome)) {
  New-Item -ItemType Directory -Path $uvHome | Out-Null
  Expand-Archive -LiteralPath $uvArchive -DestinationPath $uvHome
}
$uvExe = Get-ChildItem -LiteralPath $uvHome -Recurse -Filter uv.exe | Select-Object -First 1
if (-not $uvExe) { throw "uv.exe was not found under $uvHome" }
if (-not (& $uvExe.FullName --version).StartsWith("uv $UvVersion")) { throw 'Private uv runtime verification failed.' }

Write-Host 'Installing Node dependencies...'
& $npm ci
if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE" }

Write-Host 'Installing FFmpeg and LC3 decoder...'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'install-audio-tools.ps1')
if ($LASTEXITCODE -ne 0) { throw "Audio tool setup failed with exit code $LASTEXITCODE" }

Write-Host 'Installing Python and Faster-Whisper dependencies...'
& $uvExe.FullName sync --project local-asr --python 3.12
if ($LASTEXITCODE -ne 0) { throw "uv sync failed with exit code $LASTEXITCODE" }

$totalRam = (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
if ($totalRam -lt 8GB) { throw 'Local Full requires at least 8 GiB RAM.' }
Write-Host 'Installing local Summary dependencies...'
& $uvExe.FullName sync --project local-summary --python 3.12
if ($LASTEXITCODE -ne 0) { throw "local-summary uv sync failed with exit code $LASTEXITCODE" }

$summaryPython = Join-Path $ProjectRoot 'local-summary\.venv\Scripts\python.exe'
& $summaryPython -c 'from llama_cpp import llama_cpp; raise SystemExit(0 if llama_cpp.llama_supports_gpu_offload() else 1)' 2>$null
$summaryGpuReady = $LASTEXITCODE -eq 0
$nvidiaSmi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
$nvcc = Get-Command nvcc -ErrorAction SilentlyContinue
if (-not $summaryGpuReady -and $nvidiaSmi -and $nvcc) {
  Write-Host 'Building the pinned local Summary runtime with CUDA support...'
  $previousCmakeArgs = $env:CMAKE_ARGS
  $previousCmakeGenerator = $env:CMAKE_GENERATOR
  $previousForceCmake = $env:FORCE_CMAKE
  $previousCudaPath = $env:CUDA_PATH
  try {
    $vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path -LiteralPath $vswhere) {
      $vsRoot = [string](& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath)
      $vsRoot = $vsRoot.Trim()
      $vsDevCmd = if ($vsRoot) { Join-Path $vsRoot 'Common7\Tools\VsDevCmd.bat' } else { '' }
      if ($vsDevCmd -and (Test-Path -LiteralPath $vsDevCmd)) {
        & cmd.exe /s /c "`"$vsDevCmd`" -arch=x64 -host_arch=x64 >nul && set" | ForEach-Object {
          if ($_ -match '^([^=]+)=(.*)$') { Set-Item -Path "Env:$($Matches[1])" -Value $Matches[2] }
        }
        $env:CMAKE_GENERATOR = 'Ninja'
      }
    }
    $env:CMAKE_ARGS = '-DGGML_CUDA=on -DCMAKE_CUDA_FLAGS=-allow-unsupported-compiler'
    $env:FORCE_CMAKE = '1'
    $env:CUDA_PATH = Split-Path -Parent (Split-Path -Parent $nvcc.Source)
    & $uvExe.FullName pip install --python $summaryPython --reinstall-package llama-cpp-python --no-binary llama-cpp-python --no-cache 'llama-cpp-python==0.3.16'
    if ($LASTEXITCODE -ne 0) {
      Write-Warning 'CUDA Summary runtime build failed; Local Full will use the CPU fallback.'
      & $uvExe.FullName sync --project local-summary --python 3.12
      if ($LASTEXITCODE -ne 0) { throw 'Failed to restore the CPU Summary runtime after the CUDA build failure.' }
    } else {
      & $summaryPython -c 'from llama_cpp import llama_cpp; raise SystemExit(0 if llama_cpp.llama_supports_gpu_offload() else 1)' 2>$null
      if ($LASTEXITCODE -ne 0) { Write-Warning 'The rebuilt Summary runtime does not expose GPU offload; Local Full will use the CPU fallback.' }
    }
  } finally {
    if ($null -eq $previousCmakeArgs) { Remove-Item Env:CMAKE_ARGS -ErrorAction SilentlyContinue } else { $env:CMAKE_ARGS = $previousCmakeArgs }
    if ($null -eq $previousCmakeGenerator) { Remove-Item Env:CMAKE_GENERATOR -ErrorAction SilentlyContinue } else { $env:CMAKE_GENERATOR = $previousCmakeGenerator }
    if ($null -eq $previousForceCmake) { Remove-Item Env:FORCE_CMAKE -ErrorAction SilentlyContinue } else { $env:FORCE_CMAKE = $previousForceCmake }
    if ($null -eq $previousCudaPath) { Remove-Item Env:CUDA_PATH -ErrorAction SilentlyContinue } else { $env:CUDA_PATH = $previousCudaPath }
  }
} elseif (-not $summaryGpuReady -and $nvidiaSmi) {
  Write-Warning 'An NVIDIA GPU is present but nvcc was not found; install the CUDA Toolkit and rerun setup to enable Summary GPU offload.'
}

Write-Host 'Installing the pinned local speech model...'
$modelArguments = @('run', '--project', 'local-asr', 'python', 'scripts/install-local-model.py', '--output', 'models/faster-whisper-small')
if ($ModelEndpoint) { $modelArguments += @('--endpoint', $ModelEndpoint) }
& $uvExe.FullName @modelArguments
if ($LASTEXITCODE -ne 0) { throw "Local model installation failed with exit code $LASTEXITCODE" }

Write-Host 'Installing the pinned local Summary model...'
$summaryArguments = @('run', '--project', 'local-summary', 'python', 'scripts/install-local-summary-model.py', '--output', 'models/qwen3-4b-q4-k-m')
if ($ModelEndpoint) { $summaryArguments += @('--endpoint', $ModelEndpoint) }
& $uvExe.FullName @summaryArguments
if ($LASTEXITCODE -ne 0) { throw "Local Summary model installation failed with exit code $LASTEXITCODE" }

$ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $ffmpeg) {
  $ffmpeg = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages') -Recurse -Filter ffmpeg.exe -ErrorAction SilentlyContinue | Select-Object -First 1
}
if (-not $ffmpeg) { throw 'FFmpeg was installed but could not be located.' }
$ffmpegPath = if ($ffmpeg.PSObject.Properties.Name -contains 'Source') { $ffmpeg.Source } else { $ffmpeg.FullName }
$lc3Path = Join-Path $env:LOCALAPPDATA 'Voicecan\audio-tools\dlc3.exe'
if (-not (Test-Path -LiteralPath $lc3Path)) { throw 'LC3 decoder was installed but could not be located.' }

$envFile = Join-Path $ProjectRoot '.env'
if (-not (Test-Path -LiteralPath $envFile)) { Copy-Item -LiteralPath (Join-Path $ProjectRoot '.env.example') -Destination $envFile }
Set-EnvValue $envFile 'FFMPEG_PATH' ($ffmpegPath -replace '\\', '/')
Set-EnvValue $envFile 'LC3_DECODER_PATH' ($lc3Path -replace '\\', '/')
Set-EnvValue $envFile 'LOCAL_ASR_MODEL_PATH' './models/faster-whisper-small'
Set-EnvValue $envFile 'LOCAL_SUMMARY_MODEL_PATH' './models/qwen3-4b-q4-k-m'
Set-EnvValue $envFile 'LOCAL_ASR_DEVICE' 'auto'
Set-EnvValue $envFile 'LOCAL_ASR_COMPUTE_TYPE' 'default'
Set-EnvValue $envFile 'LOCAL_SUMMARY_GPU_MODE' 'prefer'
Set-EnvValue $envFile 'LOCAL_SUMMARY_GPU_LAYERS' '-1'
Set-EnvValue $envFile 'NOTIFICATION_ENABLED' 'false'
Remove-EnvValue $envFile 'LOCAL_ASR_MODEL_VERSION'
Remove-EnvValue $envFile 'DEMO_FIXTURE_MODE'
Remove-EnvValue $envFile 'LOCAL_PROCESSOR_MODE'

if (-not $NonInteractive) {
  $platformUrl = Get-EnvValue $envFile 'VOICECAN_SERVER_URL'
  if (-not $platformUrl) { $platformUrl = Read-Host 'Device Platform URL (without /api/v1)' }
  try { $parsedPlatformUrl = [Uri]$platformUrl } catch { throw 'VOICECAN_SERVER_URL is invalid.' }
  if (-not $parsedPlatformUrl.IsAbsoluteUri -or $parsedPlatformUrl.Scheme -notin @('http', 'https')) { throw 'VOICECAN_SERVER_URL must be an absolute HTTP(S) URL.' }

  $applicationToken = Get-EnvValue $envFile 'VOICECAN_APPLICATION_TOKEN'
  if (-not $applicationToken) { $applicationToken = Read-SecretValue 'Application Token (vcd_app_...)' }
  if (-not $applicationToken.StartsWith('vcd_app_')) { throw 'Application Token must start with vcd_app_.' }

  $webhookSecret = Get-EnvValue $envFile 'VOICECAN_WEBHOOK_SECRET'
  if (-not $webhookSecret) { $webhookSecret = Read-SecretValue 'Webhook Secret (vce_...)' }
  if (-not $webhookSecret.StartsWith('vce_')) { throw 'Webhook Secret must start with vce_.' }

  Set-EnvValue $envFile 'VOICECAN_SERVER_URL' $platformUrl.TrimEnd('/')
  Set-EnvValue $envFile 'VOICECAN_APPLICATION_TOKEN' $applicationToken
  Set-EnvValue $envFile 'VOICECAN_WEBHOOK_SECRET' $webhookSecret
}

Write-Host 'Building Voicecan Studio...'
& $npm run build
if ($LASTEXITCODE -ne 0) { throw "Build failed with exit code $LASTEXITCODE" }

Write-Host ''
Write-Host 'Voicecan Studio Local Full setup is complete.'
Write-Host 'Start it with:'
Write-Host '  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-local-windows.ps1'

param(
  [string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA 'Voicecan\audio-tools')
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  throw 'winget is required. Install Microsoft App Installer first.'
}

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  winget install --id Gyan.FFmpeg --exact --silent --disable-interactivity --accept-package-agreements --accept-source-agreements
}
$ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $ffmpeg) {
  $ffmpegCandidate = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages') -Recurse -Filter ffmpeg.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $ffmpegCandidate) { throw 'FFmpeg was installed but ffmpeg.exe could not be located. Open a new terminal and rerun this script.' }
  $ffmpegPath = $ffmpegCandidate.FullName
} else {
  $ffmpegPath = $ffmpeg.Source
}

New-Item -ItemType Directory -Force -Path $InstallDirectory | Out-Null
$dlc3Path = Join-Path $InstallDirectory 'dlc3.exe'
if (Test-Path -LiteralPath $dlc3Path) {
  Write-Host "Existing LC3 decoder found at $dlc3Path; skipping the liblc3 clone and build."
} else {
  if (-not (Test-Path -LiteralPath 'C:\msys64\msys2_shell.cmd')) {
    winget install --id MSYS2.MSYS2 --exact --silent --disable-interactivity --accept-package-agreements --accept-source-agreements
  }

  $cygpath = 'C:\msys64\usr\bin\cygpath.exe'
  $msysShell = 'C:\msys64\msys2_shell.cmd'
  if (-not (Test-Path -LiteralPath $cygpath) -or -not (Test-Path -LiteralPath $msysShell)) { throw 'MSYS2 installation is incomplete.' }

  $builderWindows = (Resolve-Path (Join-Path $PSScriptRoot 'build-liblc3-msys2.sh')).Path
  $builderUnix = (& $cygpath -u $builderWindows).Trim()
  $targetUnix = (& $cygpath -u (Resolve-Path $InstallDirectory).Path).Trim()
  & $msysShell -defterm -no-start -ucrt64 -c "bash '$builderUnix' '$targetUnix'"
  if ($LASTEXITCODE -ne 0) { throw "liblc3 build failed with exit code $LASTEXITCODE" }
  if (-not (Test-Path -LiteralPath $dlc3Path)) { throw 'dlc3.exe was not produced.' }
}

$filters = & $ffmpegPath -hide_banner -filters 2>&1
if (-not ($filters | Select-String -SimpleMatch 'afftdn')) { throw 'Installed FFmpeg does not provide the afftdn filter.' }
$dlc3Check = Start-Process -FilePath $dlc3Path -ArgumentList '-h' -Wait -PassThru -WindowStyle Hidden
if ($dlc3Check.ExitCode -ne 0) { throw "dlc3.exe could not start (exit $($dlc3Check.ExitCode))." }

Write-Host 'Audio tools are ready.'
Write-Host "FFMPEG_PATH=$ffmpegPath"
Write-Host "LC3_DECODER_PATH=$dlc3Path"


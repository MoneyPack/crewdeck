#Requires -Version 7
# Installs the MSVC Spectre-mitigated runtime libs (fixes MSB8040 when
# node-pty / better-sqlite3 are rebuilt against Electron). Idempotent.
$ErrorActionPreference = 'Stop'

$component = 'Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre'
$installerDir = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer'
$vswhere = Join-Path $installerDir 'vswhere.exe'
$vsInstaller = Join-Path $installerDir 'vs_installer.exe'

if (-not (Test-Path $vswhere)) { throw "vswhere.exe not found at $vswhere" }

$installPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $installPath) { throw 'No Visual Studio install with the VC x86/x64 toolset was found.' }

$has = & $vswhere -latest -products * -requires $component -property installationPath
if ($has) {
  Write-Host "Spectre libs already present in $installPath"
  exit 0
}

Write-Host "Adding $component to $installPath"
$proc = Start-Process -FilePath $vsInstaller -Wait -PassThru -NoNewWindow -ArgumentList @(
  'modify', '--installPath', "`"$installPath`"",
  '--add', $component,
  '--quiet', '--norestart', '--nocache'
)
# 3010 = success, reboot required
if ($proc.ExitCode -ne 0 -and $proc.ExitCode -ne 3010) {
  throw "vs_installer exited with code $($proc.ExitCode)"
}

$has = & $vswhere -latest -products * -requires $component -property installationPath
if (-not $has) { throw "$component still missing after install" }
Write-Host 'Spectre libs installed.'

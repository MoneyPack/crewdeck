<#
.SYNOPSIS
  Windows Sandbox installer smoke (M1-05).

.DESCRIPTION
  Host mode (default): renders scripts\smoke-sandbox.wsb for this checkout,
  starts Windows Sandbox, and waits for smoke-results\result.txt.

  Guest mode (-Guest): runs inside the sandbox. Silently installs the NSIS
  build, checks the install and Start menu shortcut, launches the app,
  uninstalls it, and checks cleanup. Writes PASS or FAIL to result.txt.
#>
[CmdletBinding()]
param(
  [switch]$Guest,
  [int]$HostTimeoutSec = 900,
  [int]$LaunchSec = 15,
  [int]$CleanupTimeoutSec = 60
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Repo = Split-Path -Parent $ScriptDir
$ResultsDir = Join-Path $Repo 'smoke-results'

function Invoke-Host {
  $installer = Get-ChildItem -LiteralPath (Join-Path $Repo 'release') -Filter 'zapfleet Setup *.exe' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $installer) {
    throw "No 'zapfleet Setup *.exe' in $Repo\release. Run 'npm run dist' first."
  }

  if (Test-Path -LiteralPath $ResultsDir) { Remove-Item -LiteralPath $ResultsDir -Recurse -Force }
  New-Item -ItemType Directory -Path $ResultsDir | Out-Null

  # Render the template with this checkout's absolute path. WSB files do not expand env vars or relative paths.
  $template = Get-Content -Raw -LiteralPath (Join-Path $ScriptDir 'smoke-sandbox.wsb')
  $wsb = Join-Path $ResultsDir 'run.wsb'
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($wsb, $template.Replace('{{REPO}}', $Repo), $utf8NoBom)

  Write-Host "Starting Windows Sandbox with $($installer.Name)..."
  Start-Process -FilePath $wsb

  $resultFile = Join-Path $ResultsDir 'result.txt'
  $deadline = (Get-Date).AddSeconds($HostTimeoutSec)
  while (-not (Test-Path -LiteralPath $resultFile) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 5
  }
  if (-not (Test-Path -LiteralPath $resultFile)) {
    throw "Timed out after $HostTimeoutSec s waiting for $resultFile"
  }

  $verdict = (Get-Content -LiteralPath $resultFile -TotalCount 1).Trim()
  Write-Host (Get-Content -Raw -LiteralPath (Join-Path $ResultsDir 'smoke.log'))
  Write-Host "Verdict: $verdict"
  if ($verdict -ne 'PASS') { exit 1 }
  exit 0
}

function Invoke-Guest {
  $log = Join-Path $ResultsDir 'smoke.log'
  $resultFile = Join-Path $ResultsDir 'result.txt'

  function Write-Log([string]$Message) {
    $line = '{0} {1}' -f (Get-Date -Format 'o'), $Message
    Write-Host $line
    Add-Content -LiteralPath $log -Value $line -Encoding ASCII
  }

  function Assert-Step([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "ASSERT FAILED: $Message" }
    Write-Log "OK: $Message"
  }

  $verdict = 'FAIL'
  try {
    $installer = Get-ChildItem -LiteralPath (Join-Path $Repo 'release') -Filter 'zapfleet Setup *.exe' |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    Assert-Step ($null -ne $installer) "installer found: $($installer.Name)"

    # electron-builder NSIS defaults (package.json has no artifactName, shortcutName, or perMachine).
    $installDir = Join-Path $env:LOCALAPPDATA 'Programs\zapfleet'
    $exe = Join-Path $installDir 'zapfleet.exe'
    $uninstaller = Join-Path $installDir 'Uninstall zapfleet.exe'
    $startLnk = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\zapfleet.lnk'
    $userData = Join-Path $env:APPDATA 'zapfleet'

    Write-Log 'Step 1: silent install'
    $install = Start-Process -FilePath $installer.FullName -ArgumentList '/S', '/currentuser' -Wait -PassThru
    Assert-Step ($install.ExitCode -eq 0) "installer exit code 0 (got $($install.ExitCode))"
    Assert-Step (Test-Path -LiteralPath $exe) 'zapfleet.exe installed under LOCALAPPDATA'
    Assert-Step (Test-Path -LiteralPath $startLnk) 'Start menu shortcut created'

    Write-Log 'Step 2: launch'
    $app = Start-Process -FilePath $exe -PassThru
    Start-Sleep -Seconds $LaunchSec
    Assert-Step (-not $app.HasExited) "app still running after $LaunchSec s"
    $running = Get-Process -Name 'zapfleet' -ErrorAction SilentlyContinue |
      Where-Object { $_.Path -and $_.Path.StartsWith($installDir, [StringComparison]::OrdinalIgnoreCase) }
    Assert-Step ($running.Count -gt 0) "zapfleet process running from $installDir"
    $running | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3

    Write-Log 'Step 3: silent uninstall'
    Assert-Step (Test-Path -LiteralPath $uninstaller) 'uninstaller present'
    # The NSIS uninstaller may hand off to a temp copy and exit early, so poll for cleanup instead of trusting ExitCode alone.
    $uninstall = Start-Process -FilePath $uninstaller -ArgumentList '/S' -PassThru
    Write-Log "uninstaller launched (initial exit code is informational; PID $($uninstall.Id))"
    $deadline = (Get-Date).AddSeconds($CleanupTimeoutSec)
    while ((Test-Path -LiteralPath $installDir) -and (Get-Date) -lt $deadline) {
      Start-Sleep -Seconds 2
    }

    Write-Log 'Step 4: cleanup checks'
    Assert-Step (-not (Test-Path -LiteralPath $installDir)) "install dir removed: $installDir"
    Assert-Step (-not (Test-Path -LiteralPath $startLnk)) 'Start menu shortcut removed'

    # Informational only: electron-builder keeps user data unless deleteAppDataOnUninstall is set.
    $userDataState = if (Test-Path -LiteralPath $userData) { 'kept' } else { 'removed' }
    Write-Log "INFO: user data $userData is $userDataState after uninstall"

    $verdict = 'PASS'
  }
  catch {
    Write-Log "FAIL: $($_.Exception.Message)"
  }
  finally {
    Set-Content -LiteralPath $resultFile -Value $verdict -Encoding ASCII
    Write-Log "Verdict: $verdict"
  }

  if ($verdict -eq 'PASS') { exit 0 } else { exit 1 }
}

if ($Guest) { Invoke-Guest } else { Invoke-Host }

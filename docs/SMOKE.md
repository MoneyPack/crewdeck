# Windows Sandbox installer smoke (M1-05)

Verifies the NSIS installer in a clean Windows Sandbox: silent install, launch, silent uninstall, and cleanup. Required for every release candidate.

## Prerequisites

- Windows 10/11 Pro or Enterprise with the "Windows Sandbox" optional feature enabled.
- A built installer: `npm run dist`, which produces `release\zapfleet Setup <version>.exe`.

## Run

```powershell
powershell -ExecutionPolicy Bypass -File scripts\smoke-sandbox.ps1
```

The host script:

1. Finds the newest `release\zapfleet Setup *.exe`.
2. Recreates `smoke-results\`.
3. Renders `scripts\smoke-sandbox.wsb` with this checkout's absolute path and starts Windows Sandbox.
4. Waits up to 15 minutes for `smoke-results\result.txt`, then prints `smoke-results\smoke.log`.
5. Exits 0 on `PASS`, 1 otherwise.

Options: `-HostTimeoutSec`, `-LaunchSec` (default 15), `-CleanupTimeoutSec` (default 60).

## What the guest checks

| Step | Check |
| --- | --- |
| 1. Install | `/S /currentuser` exits 0; `%LOCALAPPDATA%\Programs\zapfleet\zapfleet.exe` exists; `%APPDATA%\Microsoft\Windows\Start Menu\Programs\zapfleet.lnk` exists. |
| 2. Launch | App is still running after `-LaunchSec`; a `zapfleet` process runs from the install dir. |
| 3. Uninstall | `Uninstall zapfleet.exe /S` is launched; the install dir is removed within `-CleanupTimeoutSec`. |
| 4. Cleanup | Install dir and Start menu shortcut are gone. `%APPDATA%\zapfleet` is reported as kept or removed (informational). |

## Artifacts

- `smoke-results\smoke.log`: timestamped step log.
- `smoke-results\result.txt`: `PASS` or `FAIL`.
- `smoke-results\run.wsb`: the rendered sandbox config.

`smoke-results\` is generated output. Do not commit it.

## Troubleshooting

- **"Windows Sandbox is not enabled"**: enable the feature, then reboot.
- **Installer exit code non-zero**: check the log for the exit code and the sandbox's Event Viewer.
- **Install dir not removed**: the uninstaller may still be running. Raise `-CleanupTimeoutSec` once to rule out slowness; if the dir persists, treat it as a real failure.
- **Host times out**: the guest script never wrote `result.txt`. Open the sandbox window and check the PowerShell console there.

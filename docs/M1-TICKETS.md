# crewdeck - Milestone 1 Tickets (Windows boot, CI, smoke, hardening)

Scope: turn the 6-week MVP into something a stranger can install, trust, update and keep using on Windows. M1 adds no new agent features. It closes the MVP "Known limitations", puts every release through CI and a packaged smoke test, signs and ships through NSIS, MSIX, winget and electron-updater, and lands the runtime seam from ADR 0001 so M2 (WSL2 host daemon) is a drop-in. Source: `docs/PLAN.md` Roadmap M1, Windows packaging, CI, smoke, Risks and section 11 Native feel.

Stack (pinned, unchanged from MVP):
- electron 44.4.3, node-pty 1.1.0, better-sqlite3 13.0.3
- @xterm/xterm 6.0.0, @xterm/addon-fit 0.11.0, @xterm/addon-web-links 0.12.0
- @electron/rebuild 4.2.0, electron-builder 26.15.3, vite 8.3.0, react 19.3.0
- New in M1: electron-updater (pinned to the electron-builder 26.15.3 line), Azure Trusted Signing, GitHub Actions `windows-latest`.

Each ticket: ID, title, acceptance criteria (AC), estimate (d = dev-days). IDs use `M1-NN` because `CD-NN` is taken by the MVP and Overseer tickets.

Exit criteria for M1 (all must hold):
- Installable: a signed installer installs on a fresh Windows 11 VM with no SmartScreen "unknown publisher" warning.
- Updatable: v0.2.0 auto-updates to v0.2.1 from GitHub Releases without losing projects, sessions or settings.
- Usable: the packaged smoke suite passes in CI on every push to `main` and on every release tag.

---

## Week 1 - CI and native module hygiene

- **M1-01 CI pipeline on windows-latest** (1d)
  AC: `.github/workflows/ci.yml` runs on push and pull request: `npm ci`, `npm run lint`, `npm run typecheck`, `npm test`. npm cache keyed on `package-lock.json`. Any failure fails the job. CI badge in README. Median run under 10 minutes.
- **M1-02 Native modules rebuilt in CI** (1.5d)
  AC: runner installs the MSVC Spectre-mitigated libraries (fixes MSB8040). `@electron/rebuild` builds node-pty and better-sqlite3 against Electron 44.4.3. A post-build check loads both `.node` files inside Electron and fails the job on ABI mismatch. If rebuild fails, the job fails loudly; N-API prebuilds stay only as a documented local-dev fallback in `docs/BUILD.md`.
- **M1-03 Lockfile and update policy** (0.5d)
  AC: all dependencies pinned exactly; CI uses `npm ci` only. Dependabot opens weekly grouped PRs; electron, node-pty and better-sqlite3 are in their own group, never auto-merged, and must pass M1-04 before merge.
- **M1-04 Packaged smoke in CI** (1.5d)
  AC: a `smoke` job runs `npm run dist`, then `npm run test:e2e:dist` against `release/win-unpacked/crewdeck.exe` via `CREWDECK_E2E_EXE`. Smoke covers: cold launch, greeting renders, open a fixture repo, spawn a PTY, echo round-trip, git status visible, clean quit with no orphan processes. Uploads installer, `main.log`, Playwright trace and screenshots as artifacts on failure.
- **M1-05 Clean-machine install smoke** (1d)
  AC: `scripts/smoke-sandbox.wsb` plus a PowerShell driver installs the NSIS build silently inside Windows Sandbox, launches it, runs the smoke checks, uninstalls, and confirms `%LOCALAPPDATA%` and Start menu entries are removed. Procedure documented in `docs/SMOKE.md`. Required for every release candidate.

> **Week 1 status: planned.**
> Exit check: a red CI run blocks merge; a green run proves the packaged exe, not just the dev build, launches and runs a PTY.

## Week 2 - Signing, installers and updates

- **M1-06 Real icon and installer art** (0.5d)
  AC: `build/icon.ico` with 16, 24, 32, 48, 64, 128, 256 px layers generated from `build/crewbot.svg` by a script. NSIS header and sidebar use the brand palette (`#ff4d00`, `#c6f432`, `#3fe0ff`, `#0c0c0a`). Placeholder icon removed. Taskbar, Alt-Tab, Start menu and installer all show the new icon.
- **M1-07 Azure Trusted Signing** (1.5d)
  AC: electron-builder signs the app exe, the installer and the uninstaller through Trusted Signing. Credentials live only in a GitHub `release` environment with a required reviewer; PR builds stay unsigned. `signtool verify /pa /v` passes in CI. Signed installer downloads and runs on the M1-05 VM without an "unknown publisher" prompt.
- **M1-08 Auto-update with electron-updater** (1.5d)
  AC: publish provider is GitHub Releases on `MoneyPack/crewdeck`. App checks on start and every 6 hours, downloads in the background and shows "Restart to update". It never restarts on its own while any agent session is running. `stable` and `beta` channels selectable in Settings. CI job installs N-1, publishes a test release to a draft channel and verifies the update applies and data survives.
- **M1-09 MSIX package** (1d)
  AC: electron-builder `appx` target produces a signed MSIX. node-pty and better-sqlite3 load under MSIX virtualization; `userData` resolves to a stable path; PTY spawn works from inside the package. Sideload install and uninstall verified on the M1-05 VM. Store submission is out of scope.
- **M1-10 winget manifest** (0.5d)
  AC: release workflow generates a `MoneyPack.CrewDeck` manifest with installer URL and SHA-256. `winget validate` passes and `winget install --manifest` works locally. Upstream `winget-pkgs` PR opened for the first public release.

> **Week 2 status: planned.**
> Exit check: one tag push yields signed NSIS and MSIX artifacts, a GitHub Release, update metadata and a winget manifest with no manual steps besides the release approval.

## Week 3 - Runtime seam and robustness

- **M1-11 Runtime interface (ADR 0001)** (1.5d)
  AC: `src/main/runtime/` exposes the `Runtime` interface from `docs/adr/0001-runtime-interface.md` (start, reconnect, saveMove, shutdown, probe). The current direct node-pty path becomes `NativeRuntime`; every PTY spawn goes through the interface. Contract tests run against `NativeRuntime` and a fake. No behavior change visible to users.
- **M1-12 WSL2 detection and guidance** (1.5d)
  AC: `probe()` runs `wsl.exe --status` and `wsl.exe -l -v` with a 3 s timeout and reports: not installed, WSL1 only, WSL2 without distro, WSL2 ready. First-run panel shows the state and a guided `wsl --install` path. Missing `wsl.exe` never crashes the app. When WSL2 is not ready, CrewDeck falls back to `NativeRuntime` with a persistent, dismissible-per-session warning banner. `WslRuntime` exists behind a flag as a stub for M2.
- **M1-13 Crash handling and diagnostics** (1d)
  AC: main process logs `uncaughtException` and `unhandledRejection` to `main.log` with stack. `render-process-gone` shows a "Reload window" card and keeps PTYs alive. `crashReporter` writes local minidumps to `userData/crashes`; nothing is uploaded. Help menu "Copy diagnostics" zips logs, version, OS build and runtime probe result to the Desktop.
- **M1-14 Temp folder GC** (0.5d)
  AC: on start and every hour, `%TEMP%/crewdeck` entries older than 24 h and not owned by a live CrewDeck PID are deleted. Total size capped at 500 MB, oldest first. Unit tested with a fake clock.
- **M1-15 Reversible untracked discard** (0.5d)
  AC: discarding untracked files uses `shell.trashItem` so they land in the Recycle Bin. Confirm dialog lists every file. Fallback when trash fails: refuse and explain, never hard-delete silently.
- **M1-16 Persisted attribution** (1d)
  AC: file-to-agent attribution stored in SQLite with a schema version table and forward migration. Survives restart. "Re-attribute" action on dirty files. Multi-target routes record every target agent. Migration tested from the MVP schema.

> **Week 3 status: planned.**
> Exit check: kill the renderer, kill a PTY, unplug WSL - CrewDeck stays up, tells the user what happened and what to do next.

## Week 4 - Honest limits, native feel and release

- **M1-17 Explicit limits in the UI** (0.5d)
  AC: when the 5000-file status cap, 2 MB patch cap or 200-entry routing log cap is hit, the UI says so ("Showing first 5000 of N files") instead of truncating silently. Caps configurable in Settings within safe bounds.
- **M1-18 Binary and long-line diffs** (0.5d)
  AC: binary files show old/new size and SHA-256 plus "Open externally". Lines over 2000 chars render unhighlighted with a "long line" marker instead of being skipped.
- **M1-19 Native feel pass** (1d)
  AC: Mica `backgroundMaterial` on Windows 11 with solid fallback on Windows 10. Taskbar progress shows running agents (`setProgressBar`). Toast when an agent finishes or needs input, with click-to-focus. Jump List lists recent projects. All toggles in Settings.
- **M1-20 Performance budget** (0.5d)
  AC: smoke measures cold start to greeting (target under 2.5 s on the reference runner) and 8 concurrent PTYs streaming for 60 s with no frame gap over 100 ms. Numbers uploaded as a CI artifact; regressions over 20% fail the job.
- **M1-21 Release v0.2.0** (0.5d)
  AC: `CHANGELOG.md`, signed NSIS and MSIX, GitHub Release, winget PR, verified update path from 0.1.x. README install section points to winget and Releases.
- **M1-22 Buffer and docs** (0.5d)
  AC: `docs/BUILD.md`, `docs/SMOKE.md`, `docs/RELEASE.md` current; known limitations list for M2 written.

> **Week 4 status: planned.**
> Exit check: all three M1 exit criteria hold on a fresh VM.
> Deferred to M2+: WSL2 host daemon and real `WslRuntime`, worktrees, Guard, cost controls, Hyper-V and .wsb sandbox tiers, watch debounce tuning, Store listing.

---

Total: 22 tickets, about 19 dev-days plus buffer, 4 weeks.

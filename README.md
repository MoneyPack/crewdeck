# crewdeck

[![CI](https://github.com/MoneyPack/crewdeck/actions/workflows/ci.yml/badge.svg)](https://github.com/MoneyPack/crewdeck/actions/workflows/ci.yml)

A Windows desktop app for running several coding-agent CLIs (Claude Code, Codex, Gemini CLI, or a plain shell) side by side in one project. Features:

- **N terminals** on ConPTY via `node-pty`, rendered with xterm.js. PTY output is batched once per animation frame.
- **Session persistence**: tabs, layout, project and scrollback are saved in SQLite and restored on restart. Agents resume where possible (e.g. `claude --continue`).
- **`@mention` routing**: send a prompt or a selection from one terminal to others. Every route is written to a routing log.
- **Git panel**: status, unified diff (working tree / staged), stage/unstage/discard, and heuristic per-agent attribution.

Stack: Electron 44, React 19, Vite 8, TypeScript (strict), node-pty 1.1, better-sqlite3 13, @xterm/xterm 6, electron-builder 26.

## Requirements

- Windows 10/11 x64 (ConPTY)
- Node.js ≥ 22.12 (developed on 24.x)
- `git` on `PATH` (for the git panel)
- Optional: the agent CLIs you want to run (`claude`, `codex`, `gemini`) on `PATH`

## Setup

```pwsh
npm install
```

`node-pty` and `better-sqlite3` load from their bundled N-API prebuilds (`prebuilds/win32-x64`), so you don't need a native toolchain. If a module fails to load with an ABI error, run `npm run rebuild`. This needs VS Build Tools **with Spectre-mitigated libraries**; without them node-pty fails with MSB8040.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server + esbuild watch for main/preload + Electron |
| `npm run typecheck` | `tsc` over renderer and main/e2e configs |
| `npm run build` | typecheck → `vite build` → bundle main/preload into `dist-electron/` |
| `npm start` | run the built app (`electron .`) |
| `npm test` | unit tests: mention parser, DB layer, git parser, routing log |
| `npm run smoke` | in-Electron integration smoke (PTY, DB, persistence, git, logger) |
| `npm run test:e2e` | build, then the Playwright-for-Electron smoke (launch → spawn shell → echo round-trip) |
| `npm run dist` | build + NSIS installer into `release/` |
| `npm run test:e2e:dist` | `dist`, then the Playwright smoke against `release/win-unpacked/crewdeck.exe` (`-- --no-build` reuses an existing package) |
| `npm run icon` | regenerate `build/icon.png` + `build/icon.ico` (dependency-free generator) |
| `npm run rebuild` | force `electron-rebuild` of node-pty and better-sqlite3 |

### Packaging

```pwsh
npm run dist
```

Outputs:

- `release/crewdeck Setup 0.1.0.exe`: per-user NSIS installer. It is assisted, lets you change the install directory, and adds a desktop shortcut.
- `release/win-unpacked/crewdeck.exe`: the unpacked app.

The two native modules are listed in `asarUnpack`, so they load from `resources/app.asar.unpacked`. `npmRebuild` is off because the build relies on the prebuilds.

To run the e2e smoke against the packaged exe instead of the dev build:

```pwsh
$env:CREWDECK_E2E_EXE = 'release/win-unpacked/crewdeck.exe'; npx playwright test
```

### CI

`.github/workflows/ci.yml` runs on every push to `main` and on every PR, using `windows-latest` and Node 24. Steps:

1. `npm ci`
2. `electron-rebuild` of better-sqlite3
3. typecheck
4. unit tests
5. `npm run dist`
6. Playwright smoke against the packaged exe

The NSIS installer is uploaded as the `crewdeck-installer` artifact. If a run fails, `test-results/` is uploaded as well.

## Environment hooks

| Variable | Effect |
| --- | --- |
| `CREWDECK_USER_DATA` | Overrides Electron `userData` (DB, scrollback, logs). Tests use it to isolate state. |
| `CREWDECK_TEST_PROJECT` | Makes "Open project" pick this folder without showing the native dialog. Only honoured for an existing directory. |
| `CREWDECK_E2E_EXE` | Playwright launches this executable instead of `dist-electron/main.cjs`. |

## Data locations

Everything lives under `%APPDATA%/crewdeck` (or `CREWDECK_USER_DATA`):

- SQLite database. Migrations live in `database/`; never edit the v1 schema, add a new `NNN_*.sql` instead.
- Terminal scrollback files.
- `logs/main.log`: rotated at 1 MB, keeping `main.1.log`…`main.3.log`.

Large selections that are forwarded between terminals are written to `%TEMP%/crewdeck` with mode 0600.

## Known limitations

- **Packaging**: the installer is unsigned (SmartScreen will warn). The icon is a generated placeholder (`npm run icon`); the ICO is emitted directly because electron-builder's WASM png→ico tool fails to allocate memory on this machine. There is no auto-update or publish target. Only a Windows x64 build is produced.
- **Native modules**: they are not rebuilt by electron-builder. The app depends on the node-pty and better-sqlite3 N-API prebuilds matching the Electron version.
- **Tests**: e2e needs a build first (`test:e2e` does this). Native file dialogs are bypassed via `CREWDECK_TEST_PROJECT`.
- **Persistence**: restored scrollback is inert text, because a fresh process is spawned. Full-screen TUIs from the previous session replay as a flattened snapshot at best. Plain shells get no resume command.
- **Routing**: temp files from large forwards are not garbage-collected. The routing log UI shows the latest 200 entries per project.
- **Git**:
  - Status is capped at 5000 files and patches at 2 MB.
  - Binary files have no text diff.
  - The file watcher debounces for 400 ms.
  - Discarding an untracked file is irreversible.
- **Attribution** is a heuristic:
  - It is held in memory only.
  - Files that were already dirty are not re-attributed.
  - Multi-target routes are ignored.
- **Highlighting** works per line and skips lines longer than 2000 characters.
- **Scope**: one project at a time.

## Post-MVP backlog

- Code signing, designed branding (replace the generated icon), and auto-update (electron-updater + a publish provider)
- macOS / Linux builds
- Multi-project workspaces
- Embedded browser (CDP) for agent-driven web testing
- Workflow / chart canvas (`@xyflow/react`) to orchestrate agents
- Richer attribution: persisted, per-hunk, using agent hooks instead of heuristics
- Syntax-aware diff highlighting and a side-by-side diff mode
- Garbage collection for forward temp files, and paging for the routing log
- Collaboration, tunnels, SSO, audit logging, licensing

## Docs

- [`docs/MVP-TICKETS.md`](docs/MVP-TICKETS.md): the 6-week MVP tickets, acceptance criteria and weekly status notes

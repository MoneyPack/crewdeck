# crewdeck — 6-Week MVP Tickets

Scope: one project, N terminals running 2–3 agent CLIs, session persistence (Windows/ConPTY),
`@mention` routing between terminals, git diff view. Everything else is post-MVP.

Stack (pinned): electron 44.4.3, node-pty 1.1.0, better-sqlite3 13.0.3, @xterm/xterm 6.0.0,
@xterm/addon-fit 0.11.0, @xterm/addon-web-links 0.12.0, @electron/rebuild 4.2.0,
electron-builder 26.15.3, vite 8.3.0, react 19.3.0.

Each ticket: ID, title, acceptance criteria (AC), estimate (d = dev-days).

---

## Week 1 — Foundation + terminal engine

- **CD-01 Scaffold** (1d)
  AC: `pnpm dev` opens an Electron window rendering a React app via Vite; TypeScript strict; main/preload/renderer split; `contextIsolation: true`, `nodeIntegration: false`.
- **CD-02 Native module rebuild** (0.5d)
  AC: `postinstall` runs `electron-rebuild` for `node-pty` and `better-sqlite3`; both load in main process without ABI errors.
- **CD-03 PTY service (main)** (1.5d)
  AC: create/write/resize/kill PTYs by id; default shell `pwsh.exe` (fallback `powershell.exe`); exit events emitted; all PTYs killed on app quit.
- **CD-04 Terminal IPC bridge** (1d)
  AC: typed preload API (`terminal.create/write/resize/kill/onData/onExit`); no raw `ipcRenderer` exposed; listeners unsubscribable.
- **CD-05 Terminal pane (renderer)** (1d)
  AC: xterm renders shell output, keyboard input round-trips, fit addon resizes PTY on container resize, links clickable (open externally).

## Week 2 — Multi-terminal layout + agent profiles

- **CD-06 Terminal manager + tabs** (1.5d)
  AC: open/close/rename N terminals; switching tabs preserves scrollback; closing a tab kills its PTY.
- **CD-07 Split layout** (1.5d)
  AC: 1/2/4-pane grid; each pane hosts any terminal; layout persists in memory.
- **CD-08 Agent profiles** (1d)
  AC: built-in profiles for Claude Code, Codex, Gemini CLI (command, args, env); "detect installed" check via `where.exe`; launch terminal from profile.
- **CD-09 Project selection** (1d)
  AC: pick one folder as the project; all terminals spawn with `cwd` = project root; shown in title bar.

## Week 3 — Persistence

- **CD-10 SQLite schema + migrations** (1d)
  AC: `database/schema.sql` with `projects`, `terminals`, `sessions`, `settings`; JSON columns are `TEXT` queried via `json_extract()`; versioned migrations run on start; DB in `app.getPath('userData')`.
- **CD-11 Layout/terminal restore** (1.5d)
  AC: on restart, project, tabs, split layout, profiles and cwd are restored and shells re-spawned.
- **CD-12 Scrollback persistence** (1.5d)
  AC: per-terminal output ring buffer (cap 5k lines) flushed to disk (debounced); replayed into xterm on restore with a visible "restored session" divider.
- **CD-13 Agent resume hooks** (1d)
  AC: profiles may define a resume command (e.g. `claude --continue`); restore uses it when available. Documented limitation: live process state is not preserved across app restart (no tmux on Windows).

> **Week 3 status: done.** Verified by CDP restart test (tabs, layout, project, scrollback marker, divider, `restoredFrom`, `claude --continue`).
> Known limitations: restored scrollback is inert text (the prior process is gone; a fresh shell/agent is spawned). Replay strips alt-screen and clear-scrollback sequences so full-screen TUIs from the previous session render as a flattened snapshot at best. Plain shells get no resume command.

## Week 4 — @mention routing

- **CD-14 Mention parser** (1d)
  AC: composer input `@<terminalName> <message>` resolves target(s); `@all` broadcasts; unknown names error inline. Unit tested.
- **CD-15 Composer bar** (1.5d)
  AC: global input bar with autocomplete of terminal names; sends text + Enter to target PTY(s); history with ↑/↓.
- **CD-16 Output capture + forward** (1.5d)
  AC: select text in a terminal → "Send to @X" action; ANSI stripped before forwarding; large payloads (>4 KB) written to temp file and referenced by path instead.
- **CD-17 Routing log** (1d)
  AC: side panel lists every routed message (from, to, time, preview); persisted in SQLite.

> **Week 4 status: done.** Parser unit-tested; composer, selection forward (ANSI stripped, >4 KB → 0600 temp file under `%TEMP%/crewdeck`) and routing log (schema v2 migration `002_routing_log.sql`, FK cascade, CHECK guards) verified by `npm run smoke` (round-trip, newest-first ordering, limit, per-project scoping, input normalisation, cascade delete).
> Known limitations: temp files are not garbage-collected; routing log shows the latest 200 entries per project.

## Week 5 — Git diff view

- **CD-18 Git status service** (1d)
  AC: main-process wrapper over `git` CLI; changed files list with status; refresh on FS watch (debounced) and on demand; non-repo projects handled gracefully.
- **CD-19 Diff viewer** (2d)
  AC: side-by-side / unified diff for a selected file (working tree vs HEAD, and staged); syntax highlighting; large-file guard.
- **CD-20 Per-agent attribution (basic)** (1d)
  AC: diff panel shows which terminal was active/last-routed when a file changed (best-effort heuristic, clearly labeled).
- **CD-21 Stage / discard** (1d)
  AC: stage, unstage, discard per file with confirmation on discard.

> **Week 5 status: done.** Git service (`git` CLI via `runGit`, porcelain v2 parser, ref-counted debounced FS watch, id-resolved project paths + rel-path guards), unified diff viewer (working tree / staged, line-based highlighter), heuristic attribution (clearly labeled) and stage/unstage/discard (confirm dialog; tracked-file delete refused; no-HEAD repos supported) verified by `npm run smoke`.
> Known limitations: status capped at 5000 files, patches at 2 MB; binary files have no text diff; 400 ms watch debounce; untracked discard is irreversible; attribution is in-memory only, does not re-attribute already-dirty files and ignores multi-target routes; highlighting is per-line and skips lines > 2000 chars.

## Week 6 — Hardening + packaging

- **CD-22 Error handling + logging** (1d)
  AC: main-process log file with rotation; PTY spawn failures shown in pane with actionable message.
- **CD-23 Performance pass** (1d)
  AC: 6 concurrent terminals streaming output keep UI ≥ 50 fps; PTY data batched per animation frame.
- **CD-24 Tests** (1.5d)
  AC: unit tests (mention parser, DB layer, git parser); one Playwright-for-Electron smoke test (launch, spawn shell, echo round-trip).
- **CD-25 Packaging** (1d)
  AC: `electron-builder` NSIS installer for Windows x64; native modules included (`asarUnpack`); installs and runs on a clean machine.
- **CD-26 Buffer / docs** (0.5d)
  AC: README with setup, known limitations, post-MVP backlog.

> **Week 6 status: done.** Size-rotating main-process log (`userData/logs/main.log`, 1 MB × 3) plus actionable PTY spawn-failure messages in the pane; PTY output batched per animation frame; unit tests (`npm test`, 27/27: mention parser, DB layer, git parser, routing log); Playwright-for-Electron smoke (launch → spawn shell → echo round-trip) passes against both the dev build and the packaged `release/win-unpacked/crewdeck.exe` (`CREWDECK_E2E_EXE`); `npm run dist` produces the NSIS x64 installer, with node-pty/better-sqlite3 loaded from `app.asar.unpacked`; README covers setup, scripts, env hooks, limitations and the post-MVP backlog.
> Known limitations: the installer is unsigned (a generated placeholder icon is in `build/`); no auto-update/publish target; native modules are not rebuilt by electron-builder (N-API prebuilds are used because `electron-rebuild` of node-pty needs Spectre libs, MSB8040); e2e requires a build first (`test:e2e` / `test:e2e:dist` handle this); the "clean machine" install was verified via the unpacked exe on the dev box, not on a fresh VM.

---

## Overseer — CREWDECK's built-in AI helper

> All Overseer work sits behind the `overseer.enabled` flag (off by default). Provider: Claude (`@anthropic-ai/sdk`). Every writing run gets its own worktree/branch and merges only after diff review. Push and release always require explicit approval.

## Overseer Phase 0 — Spikes
- **CD-27 SDK tool-loop spike** (0.5d)
  AC: a throwaway script shows Claude calling a tool via `@anthropic-ai/sdk` and using the result in its answer.
- **CD-28 CLI headless/MCP spike** (1d)
  AC: documented findings on whether claude, codex and gemini CLIs can run unattended against an MCP server; results feed CD-48.

---

## Overseer Phase 1 — Run model
- **CD-29 Migration `004_overseer.sql`** (0.5d)
  AC: new tables for runs, tool calls, approvals, audit and memory (TEXT UUIDs, epoch-ms, `json_valid()` checks); applied by `db.ts`; `schema.sql` untouched.
- **CD-30 Service skeleton + flag** (0.5d)
  AC: `electron/services/overseer/index.ts` starts only when `overseer.enabled` is true; off by default; no behaviour change when disabled.
- **CD-31 RunManager** (1.5d)
  AC: states `queued → running → awaiting_approval → done|failed|cancelled`; token/step/time budgets enforced; kill switch stops a run in under 1s.
- **CD-32 `overseer:*` IPC channels** (0.5d)
  AC: typed channels in `shared/ipc.ts` + preload for start/cancel/list runs, stream events and answer approvals.

---

## Overseer Phase 2 — Tools, policy, audit
- **CD-33 ToolRegistry** (1d)
  AC: tools register with a schema and a risk class (`read`, `write-local`, `exec`, `git-local`, `network`, `git-remote`, `release`); invalid input rejected before execution.
- **CD-34 Policy** (0.5d)
  AC: per-project policy with defaults — `read` auto; `write-local`, `exec`, `git-local` approve; `network` deny; `git-remote`, `release` approve and locked (cannot be set to auto).
- **CD-35 Audit trail** (0.5d)
  AC: every tool call, decision and result is recorded with run id, timestamp and outcome; viewable per run.
- **CD-36 Read-only tools** (1d)
  AC: `fs.read`, `fs.list`, `fs.search`, `git.status`, `git.diff`, `git.log`, `project.info`, `routing_log.read`, `browser.snapshot`; confined to the project root.

---

## Overseer Phase 3 — Claude runtime and panel
- **CD-37 API key storage** (0.5d)
  AC: Anthropic key stored encrypted via `safeStorage`; never written to logs or the renderer.
- **CD-38 ApiRuntime** (2d)
  AC: Claude tool loop over the ToolRegistry with streaming, budgets, cancellation and error handling.
- **CD-39 Project context** (0.5d)
  AC: runs include project info plus `CLAUDE.md`/`AGENTS.md` when present, within a size cap.
- **CD-40 Overseer panel** (2d)
  AC: `src/overseer/*` panel to start a run, see live steps, answer approvals and cancel; not added to `App.tsx` beyond mounting.
- **CD-41 Memory** (0.5d)
  AC: per-project notes the Overseer can read and propose; user can view and delete them.

---

## Overseer Phase 4 — Safe changes
- **CD-42 Worktree per run** (0.5d)
  AC: each writing run works in its own git worktree and branch; cleaned up after merge or discard.
- **CD-43 Write tools** (1d)
  AC: `fs.write`, `fs.patch`, `fs.delete` limited to the run's worktree; all `write-local` risk.
- **CD-44 ApprovalGate** (1.5d)
  AC: risky calls pause the run in `awaiting_approval`; approve/deny from the panel; a timeout counts as deny.
- **CD-45 Diff review and merge** (1.5d)
  AC: user sees the full diff of a run and chooses merge or discard; nothing reaches the main branch without this step.

---

## Overseer Phase 5 — CLI runtimes
- **CD-46 Per-run bridge tokens** (0.5d)
  AC: each run gets its own short-lived bridge token scoped to its allowed tools; revoked when the run ends.
- **CD-47 Extend `crewdeck-mcp`** (1d)
  AC: MCP server exposes Overseer tools (not only the browser), still subject to policy and approvals.
- **CD-48 CliRuntime** (2d)
  AC: runs can use claude/codex/gemini CLIs over MCP (per CD-28 findings); marked "partially governed"; no `git-remote` or `release` rights.

---

## Overseer Phase 6 — Test, build and hand-off
- **CD-49 Exec tools** (1d)
  AC: typecheck, `npm test` and build runnable inside the run's worktree; `exec` risk; output captured in the audit trail.
- **CD-50 `@overseer` and hand-off** (1.5d)
  AC: `@overseer` mention routes to the Overseer; it can hand a task to an agent tab and report the result back.

---

## Overseer Phase 7 — Push, PR, release
- **CD-51 Push and PR** (1d)
  AC: push branch and open a PR only after approval; force-push always denied.
- **CD-52 Release** (1d)
  AC: release steps require double confirmation; never automatic.
- **CD-53 Hardening and docs** (1.5d)
  AC: security review of tools/bridge, README section on the Overseer, and the out-of-MVP list updated.

---

**Overseer totals:** Phases 0–4 ≈ 17.5d; Phases 5–7 ≈ 9.5d; ≈ 27d overall.

## Explicitly out of MVP
Embedded browser (CDP), workflow/chart canvas (`@xyflow/react`), multi-project, collaboration,
tunnels, SSO, audit logging, macOS/Linux builds, licensing/monetization.

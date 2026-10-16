<p align="center">
  <img src="../design/logo.svg" width="112" alt="CrewDeck logo" />
</p>

<h1 align="center">CrewDeck — The Plan</h1>

<p align="center"><b>Hire a crew in one click.</b></p>

<p align="center">
  claude · codex · gemini · OneAPI · your agent · shell — side by side, then everywhere.
</p>

---

> *Hey, captain. Your crew is waking up.*

This document is where CrewDeck goes next. It is not a rewrite. It is an
evolution of the app that already exists — Electron + React + Vite, `node-pty`
terminals, xterm.js panes, SQLite state, MCP — into the best place on Windows
to run, supervise, and ship work from a crew of AI coding agents.

---

## 1. The vision in one paragraph

Today you open CrewDeck and tile up to four agents next to each other.
Tomorrow you describe a job, and CrewDeck **hires the crew for it**: a lead
agent splits the work, each crew member gets its own sandbox and its own git
branch, they run locally or in the cloud, you watch every keystroke, approve
anything risky with one tap, compare their answers side by side, and merge the
best one as a pull request. You stay the captain. The crew does the rowing.

## 2. Principles

1. **The captain is always in control.** Every agent action is visible,
   interruptible, and attributable. No silent side effects.
2. **Isolation by default.** Each crew member works in its own worktree and its
   own sandbox. Nothing an agent does can touch another agent's work, or your
   machine, without permission.
3. **Any agent, no lock-in.** Claude Code, Codex, Gemini CLI, OneAPI, any CLI,
   or a plain shell. CrewDeck is the deck, not the crew.
4. **Windows first, and proud of it.** Most agent tooling treats Windows as an
   afterthought. CrewDeck treats it as home: ConPTY, PowerShell, WSL2, Windows
   Sandbox, Hyper-V, winget, Mica.
5. **Evolve, don't rewrite.** Every milestone ships on top of the current
   stack and keeps the app working.
6. **Costs are a feature.** Tokens, minutes, and VM time are shown, budgeted,
   and capped.

## 3. Where we stand

CrewDeck already runs Claude Code, Codex, Gemini CLI, OneAPI, any CLI, or a
plain shell side by side on Windows, with up to four tiled panes, `@mentions`
and a built-in browser.

| Area | Today |
|---|---|
| Shell | Electron, React 19, Vite |
| Terminals | `node-pty` 1.1 (ConPTY), `@xterm/xterm` 6 + fit / web-links / webgl |
| State | `better-sqlite3` |
| Agent protocol | `@modelcontextprotocol/sdk` |
| Updates | `electron-updater` |
| Validation | `zod` |
| Packaging | `electron-builder --win --x64` |
| Quality gates | `smoke`, `test`, `test:e2e`, `test:stress`, `test:e2e:dist`, `lint`, `format` |

The 6-week MVP in [`MVP-TICKETS.md`](./MVP-TICKETS.md) (one project, N
terminals across 2–3 CLIs, ConPTY persistence, `@mention` routing, git diff)
is the foundation. Nothing in this plan replaces it; everything here builds on
it.

## 4. What we learned by studying the field

We read three codebases closely before writing this plan.

**cloudroom-core** (Rust, axum, tokio, rustls) — a server-side agent runtime.
The ideas worth taking:

- **One VM per agent, one git branch per agent.** Isolation is the product.
- Agents run as a **separate user with no sudo**, with a **secret token per
  request** between runtime and host.
- A **Command Guard** that inspects commands before they run.
- **Teleport** (`src/mac/transfer.rs`): move a running session between local
  and cloud without losing state.
- Modules for `runtime`, `session`, `workspace`, `computer_use`, `secrets`,
  `sync` — a clean map of what an agent platform actually needs.
- Decisions recorded as ADRs. (Note: its README and ADRs disagree about
  history storage — PostgreSQL vs. gzipped HTTPS uploads. We will pick one
  and write it down.)

**cloudroom-gui** (pnpm + turbo, TypeScript) — the desktop and web client. The
ideas worth taking:

- A split between **desktop**, **host-daemon**, and **server** apps.
- A thread-centric UI: threads, automations, pinned items, projects grouped by
  repo; "Thought for Xs" / "Worked for 3m 41s" timing; an input bar with
  `@`-mentions, model selector, repo picker, cloud/local toggle, a visible
  branch name, and an explicit access level.
- What it does **not** do: its desktop package targets `darwin` and `linux`
  only. **There is no Windows story.** That is our opening.

**bb** — the MIT-licensed upstream GUI that cloudroom-gui grew from. Useful as
reference; if we ever reuse its code we carry its MIT notice.

The conclusion: the best agent platforms isolate every agent, make every
action visible, and let sessions move between laptop and cloud. None of them
do it natively on Windows. CrewDeck will.

## 5. Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│ CrewDeck desktop  (Electron + React + Vite + xterm.js)           │
│  threads · tiles · @mentions · review · budgets · approvals      │
└───────────────┬──────────────────────────────────────────────────┘
                │ named pipe  /  localhost + per-session token
┌───────────────▼──────────────────────────────────────────────────┐
│ crewdeck host-daemon  (Node today, Rust-ready interface)         │
│  PTY supervisor · worktrees · Command Guard · cost meter · MCP   │
│  SQLite state · secrets broker · Teleport                        │
└───────┬──────────────────────┬───────────────────────┬───────────┘
        │                      │                       │
┌───────▼────────┐   ┌─────────▼─────────┐   ┌─────────▼──────────┐
│ Local: WSL2    │   │ Local: Windows    │   │ Cloud: one VM per  │
│ distro per     │   │ Sandbox (.wsb) /  │   │ agent, own branch, │
│ crew (default) │   │ Hyper-V           │   │ Rust core          │
└────────────────┘   └───────────────────┘   └────────────────────┘
```

- **Desktop** stays what it is: the deck. It renders, it never executes agent
  code itself.
- **host-daemon** is extracted from today's Electron main process. It owns
  PTYs, worktrees, policy, and state, so the UI can crash, update, or close
  without killing the crew.
- **Runtimes** are pluggable behind one interface: `spawn`, `attach`,
  `snapshot`, `transfer`, `destroy`.

### Runtime strategy

1. **WSL2 first.** A Linux core runs unchanged inside a dedicated WSL2 distro,
   one worktree per thread. Fastest path to real isolation with the most
   compatible toolchain.
2. **Native later.** A `cfg(windows)` path: a low-privilege local account,
   Job Objects for process-tree limits and kill-on-close, ConPTY for terminals.

## 6. The eleven builds

Each build lists **why**, **how**, and **done when**.

### 1. Windows packaging that feels first-class
- **Why:** Trust starts at install. Unsigned installers lose users at the
  SmartScreen prompt.
- **How:** keep `electron-builder`; ship NSIS (per-user, no admin) and MSIX;
  publish a winget manifest; sign with Azure Trusted Signing in CI;
  `electron-updater` on a stable and a beta channel.
- **Done when:** `winget install` works, installs are signed, and updates apply
  silently.

### 2. Sandbox tiers per thread
- **Why:** Different jobs deserve different walls.
- **How:** three tiers selectable per thread — **WSL2 distro** (default),
  **Windows Sandbox** via generated `.wsb` (disposable, mapped worktree only),
  **Hyper-V** VM (strongest, for untrusted repos). Tier shown on the tile.
- **Done when:** a thread can be started in any tier and the agent cannot read
  outside its worktree.

### 3. Core on WSL2, then native
- **Why:** Reuse a proven Linux runtime now; earn native Windows later.
- **How:** the runtime interface from §5; WSL2 adapter first; native adapter
  with low-privilege account + Job Objects + ConPTY second.
- **Done when:** the same thread runs on either adapter with no UI changes.

### 4. Teleport for PC
- **Why:** Start on your laptop, keep going in the cloud when you shut the lid.
- **How:** `src/windows/` transfer module mirroring the ideas in cloudroom's
  `mac/transfer.rs`: snapshot worktree + session + scrollback, ship to a
  `cloud-pc` runtime, reattach. Access levels per session: **Off**,
  **Read-only**, **Ask first**, **Full**. Optional Tailscale for reaching your
  own machine from anywhere.
- **Done when:** a running thread moves local → cloud → local and its terminal
  history is intact.

### 5. Computer use, the Windows way
- **Why:** Some work lives in GUIs, not shells.
- **How:** UI Automation for structured control; Windows.Graphics.Capture for
  pixels; only inside a sandbox tier, never on the captain's desktop without
  explicit **Full** access.
- **Done when:** an agent can drive a sample app in Windows Sandbox and every
  action is logged on the thread.

### 6. Command Guard for PowerShell
- **Why:** One bad command should never cost you a disk.
- **How:** parse commands before execution; per-repo allow/deny lists;
  **Ask once per class** of command; hard blocks for `Remove-Item -Recurse` on
  paths outside the worktree, `format`, `reg delete`, and friends. Decisions
  are recorded on the thread.
- **Done when:** destructive commands are stopped or approved, never silently
  run.

### 7. Cost controls
- **Why:** A crew that bills you in the dark is not a crew you keep.
- **How:** per-thread budgets for tokens, wall time, and VM minutes;
  auto-pause at the cap; a dashboard that shows spend by agent, thread, and
  repo.
- **Done when:** every thread shows its live cost and stops at its budget.

### 8. Cross-agent review
- **Why:** The fastest way to a good answer is three answers.
- **How:** run the same task on up to three agents; side-by-side diffs;
  per-hunk pick; one-click PR from the winner (or the blend).
- **Done when:** a captain can go from "ask three" to an open PR in one view.

### 9. Orchestration
- **Why:** "Hire a crew" means more than one hire.
- **How:** a lead agent splits the job into tasks, assigns crew members,
  each on its own branch; a merge queue lands their work in order and reruns
  checks on conflict.
- **Done when:** a multi-part task lands as a sequence of green merges.

### 10. Local models
- **Why:** Private repos, offline flights, zero marginal cost.
- **How:** first-class Ollama and LM Studio profiles alongside hosted CLIs;
  same budgets, same review, same guard.
- **Done when:** a local model can be `@mentioned` like any other crew member.

### 11. Native feel
- **Why:** It should feel like it belongs on Windows 11.
- **How:** Mica / acrylic backdrops, taskbar progress for running threads,
  toast notifications for approvals and finishes, Jump List entries for
  recent projects.
- **Done when:** you can approve a command from a toast without opening the app.

## 7. Roadmap

| Milestone | Theme | Ships |
|---|---|---|
| **M0** | Brand & license | This plan, `design/logo.svg`, MIT confirmed, naming notes |
| **M1** | Windows boot, CI, smoke | Signed builds, CI running `lint`/`test`/`smoke`/`test:e2e:dist`. Much of the scaffolding exists already — this milestone is hardening, not starting. |
| **M2** | Local crews on WSL2 | host-daemon extraction, worktree per thread, WSL2 runtime, Command Guard v1, cost meter v1 |
| **M3** | Cloud & Teleport | Cloud runtime (one VM per agent), Teleport, access levels, Windows Sandbox tier |
| **M4** | Differentiators | Cross-agent review, orchestration + merge queue, computer use, local models, native polish, Hyper-V tier |

Every milestone ends with the app installable, updatable, and usable.

## 8. Risks and how we meet them

| Risk | Response |
|---|---|
| Native modules (`node-pty`, `better-sqlite3`) break on Electron upgrades | Pin versions (as the MVP already does), rebuild in CI, smoke-test packaged builds |
| WSL2 not installed or disabled by policy | Detect at first run, guide setup, fall back to native shell tier with a clear warning |
| Sandbox escapes via mapped folders | Map only the worktree; read-only by default for anything else |
| Agent CLIs change flags or output | Agent profiles are data, not code; version them and test against each CLI |
| Cost surprises | Budgets on by default with conservative caps |

## 9. License and attribution

CrewDeck is **MIT**, "Copyright (c) 2026 MoneyPack". We stay MIT. If code
from `bb` is ever reused, its MIT notice ships alongside ours. Ideas studied
from cloudroom-core and cloudroom-gui are re-implemented, not copied.

## 10. Naming notes

- The product is **CrewDeck**; tagline **"Hire a crew in one click."**
- An earlier candidate, *Krew*, was dropped: it collides with kubectl's
  `krew` plugin manager.
- **The CrewDeck trademark has not been checked.** Run a search before any
  paid marketing or store listing.

## 11. The first three moves

1. Land this plan and the logo (M0).
2. Turn M1 into tickets next to `MVP-TICKETS.md`: signing, winget, CI gates.
3. Write the runtime interface (`spawn / attach / snapshot / transfer /
   destroy`) as an ADR, then build the WSL2 adapter behind it.

---

<p align="center"><i>The deck is set. Let's hire the crew.</i></p>

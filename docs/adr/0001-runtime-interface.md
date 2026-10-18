# 0001 - Runtime interface

Status: proposed (2026-10-18)

## Context

CrewDeck spawns every agent CLI (Claude Code, Codex, Gemini, OpenCode and friends) by calling node-pty directly from the Electron main process. That works on one Windows host, but it ties session lifetime, file access and isolation to whatever the main process happens to do. M2 puts agents inside WSL2, M3 adds cloud machines and M4 adds Hyper-V sandboxes. Each of those changes where a shell lives, how it survives a window reload and how files cross the boundary. Without a seam, every backend leaks into terminal, worktree, limits and review code.

cloudroom-core solves the same problem on macOS with a privileged core service (its ADR 0001) and a transfer path (`src/mac/transfer.rs`) that moves up to 16 MiB in one job and larger payloads up to 2 GiB in 8 MiB pieces, staged in a temp folder and checked with SHA-256. We borrow the shape of that contract, not the privilege model, for M1.

## Decision

The main process talks to execution backends only through a `Runtime` interface in `src/main/runtime/`:

```ts
interface Runtime {
  readonly kind: "native" | "wsl" | "fake";
  probe(): Promise<ProbeResult>;
  start(spec: SessionSpec): Promise<SessionHandle>;
  reconnect(id: SessionId): Promise<SessionHandle | null>;
  saveMove(req: MoveRequest): Promise<MoveResult>;
  shutdown(opts?: { graceMs?: number }): Promise<void>;
}
```

- `probe` never throws. It returns `ready`, `degraded` or `unavailable` with a reason and a fix hint, and caps every external command at 3 s. For WSL it maps `wsl.exe --status` and `wsl.exe -l -v` to: not installed, WSL1 only, WSL2 without a distro, WSL2 ready. A missing `wsl.exe` is a result, not a crash.
- `start` spawns a PTY from a `SessionSpec` (agent id, argv, cwd, env allowlist, cols, rows) and returns a handle with a stable `SessionId`, data and exit events, `write`, `resize` and `kill`. The id is stored in SQLite.
- `reconnect` reattaches to a session that is still running, for example after a renderer reload or `render-process-gone`. It returns `null` when the session is gone and never spawns a new one. In M1 `NativeRuntime` keeps PTYs in the main process, so reconnect covers renderer reloads only; surviving a full app restart is the M2 host daemon's job.
- `saveMove` moves files between the host and the runtime filesystem (worktree in, artifacts out). The contract follows `transfer.rs`: up to 16 MiB in one job; larger payloads in 8 MiB pieces up to a 2 GiB hard cap; staged in a per-move temp folder; SHA-256 of the whole payload checked at the destination before an atomic rename; up to 3 tries per piece. Anything over the cap fails with a clear message and writes nothing. `NativeRuntime` implements it as a local copy with the same checks, so callers cannot tell the difference.
- `shutdown` stops new starts, asks sessions to exit (Ctrl+C, then terminate), waits `graceMs` (default 5000) and then force-kills the process tree. It is idempotent and runs on app quit and before an update installs.

Implementations:

- `NativeRuntime` (M1): today's node-pty path, wrapped. No user-visible change.
- `WslRuntime` (stub behind a flag in M1, real in M2): runs `wsl.exe -d <distro> --cd <path> -- <argv>` over ConPTY, translates paths with `wslpath`, and moves worktrees onto the distro's ext4 disk rather than `/mnt/c` for speed.
- `FakeRuntime`: in-memory and deterministic, for contract and UI tests.

One contract test suite runs against every implementation: `NativeRuntime` and `FakeRuntime` in CI on `windows-latest`, `WslRuntime` wherever a distro is available. A runtime that fails the suite does not ship.

Order of work: WSL2 first, because agent CLIs expect Linux tooling and WSL2 gives a VM boundary for free. Native Windows isolation comes later behind `cfg(windows)` in the host daemon: a dedicated low-privilege local account, Job Objects for process-tree lifetime and CPU and memory caps, and ConPTY for terminals. Selection at session start: use `WslRuntime` when its probe is `ready` and the user opted in; otherwise use `NativeRuntime` and show a persistent warning banner, dismissible per session (M1-12).

## Consequences

- Terminal, worktree, limits and review code depend only on `Runtime`. Cloud (M3) and Hyper-V (M4) become new implementations, not rewrites.
- M1 cost is about 1.5 dev-days for the seam (M1-11) and 1.5 for probe and guidance (M1-12).
- The interface is async with serializable inputs and outputs, so it can move behind IPC to the M2 host daemon without touching callers.
- 2 GiB is a product limit. Bigger repos are cloned or mounted inside the runtime, not moved.
- `NativeRuntime` still has no isolation in M1, and the banner says so plainly.

## Alternatives considered

- Keep direct node-pty calls and branch per backend: cheapest today, but spreads backend checks across every feature.
- A privileged core service now, as in cloudroom-core: strongest isolation, but it needs a signed Windows service, elevated installs and an update path before M1 even has signing. Deferred to the M2+ host daemon.
- Docker Desktop as the only runtime: licence cost for larger orgs, a heavy install, and WSL2 underneath anyway.
- Native Windows sandbox first: more plumbing (accounts, ACLs, Job Objects) and most agent CLIs assume POSIX. Revisit after WSL2.

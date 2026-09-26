import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as pty from 'node-pty';
import type {
  TerminalCreateOptions,
  TerminalCreateResult,
  TerminalDataEvent,
  TerminalExitEvent,
} from '../../shared/ipc';

type DataSink = (event: TerminalDataEvent) => void;
type ExitSink = (event: TerminalExitEvent) => void;

interface Session {
  id: string;
  proc: pty.IPty;
  buffer: string;
  flushTimer: NodeJS.Timeout | null;
}

/** Output from a PTY is coalesced for this long before being sent to the renderer. */
const FLUSH_INTERVAL_MS = 8;
/** Flush immediately once this much output is pending. */
const MAX_PENDING_BYTES = 64 * 1024;

/** Extra environment injected into every spawned shell (crewdeck browser bridge, shim PATH). */
let extraEnv: Record<string, string> = {};
let extraPath: string | null = null;

export function setExtraPtyEnv(env: Record<string, string>, prependPath: string | null = null): void {
  extraEnv = { ...env };
  extraPath = prependPath;
}

function withExtraEnv(base: Record<string, string>): Record<string, string> {
  const env = { ...base, ...extraEnv };
  if (extraPath) {
    const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
    const current = env[key] ?? '';
    const parts = current.split(path.delimiter).filter((p) => p && p !== extraPath);
    env[key] = [extraPath, ...parts].join(path.delimiter);
  }
  return env;
}

export function resolveDefaultShell(): string {
  if (process.platform !== 'win32') return process.env.SHELL || '/bin/bash';
  const candidates = [
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
    path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ];
  return candidates.find((c) => existsSync(c)) ?? 'powershell.exe';
}

export class PtyManager {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly onData: DataSink,
    private readonly onExit: ExitSink,
  ) {}

  create(options: TerminalCreateOptions = {}): TerminalCreateResult {
    const shell = options.shell ?? resolveDefaultShell();
    const cwd = options.cwd && existsSync(options.cwd) ? options.cwd : os.homedir();
    const env = withExtraEnv({
      ...(process.env as Record<string, string>),
      ...options.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    });

    const proc = pty.spawn(shell, options.args ?? [], {
      name: 'xterm-256color',
      cols: clampDim(options.cols, 80),
      rows: clampDim(options.rows, 24),
      cwd,
      env,
      useConpty: true,
    });

    const id = randomUUID();
    const session: Session = { id, proc, buffer: '', flushTimer: null };
    this.sessions.set(id, session);

    proc.onData((data) => {
      session.buffer += data;
      if (session.buffer.length >= MAX_PENDING_BYTES) {
        this.flush(session);
      } else if (!session.flushTimer) {
        session.flushTimer = setTimeout(() => this.flush(session), FLUSH_INTERVAL_MS);
      }
    });

    proc.onExit(({ exitCode, signal }) => {
      this.flush(session);
      this.sessions.delete(id);
      this.onExit({ id, exitCode, signal });
    });

    return { id, pid: proc.pid, shell };
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.proc.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id);
    if (!session) return;
    try {
      session.proc.resize(clampDim(cols, 80), clampDim(rows, 24));
    } catch {
      // Resizing a PTY that is exiting can throw; safe to ignore.
    }
  }

  kill(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    try {
      session.proc.kill();
    } catch {
      // Already dead.
    }
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id);
  }

  get size(): number {
    return this.sessions.size;
  }

  private flush(session: Session): void {
    if (session.flushTimer) {
      clearTimeout(session.flushTimer);
      session.flushTimer = null;
    }
    if (!session.buffer) return;
    const data = session.buffer;
    session.buffer = '';
    this.onData({ id: session.id, data });
  }
}

function clampDim(value: number | undefined, fallback: number): number {
  if (!value || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(1000, Math.floor(value)));
}

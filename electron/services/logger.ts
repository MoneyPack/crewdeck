import fs from 'node:fs';
import path from 'node:path';
import { inspect } from 'node:util';

export type LogLevel = 'info' | 'warn' | 'error';

export interface LoggerOptions {
  /** Max bytes of the active file before it rotates. */
  maxBytes?: number;
  /** Number of rotated files kept (main.1.log … main.N.log). */
  maxFiles?: number;
  /** Mirror lines to the console (default: true). */
  echo?: boolean;
}

/**
 * Minimal synchronous size-rotating file logger for the main process.
 * Sync writes keep ordering intact and survive crashes; log volume is low.
 */
export class Logger {
  private file: string | null = null;
  private size = 0;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly echo: boolean;

  constructor(options: LoggerOptions = {}) {
    this.maxBytes = options.maxBytes ?? 1024 * 1024;
    this.maxFiles = options.maxFiles ?? 3;
    this.echo = options.echo ?? true;
  }

  /** Starts writing to `<dir>/main.log`. Before init, lines only go to the console. */
  init(dir: string): string {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'main.log');
    try {
      this.size = fs.statSync(this.file).size;
    } catch {
      this.size = 0;
    }
    return this.file;
  }

  get path(): string | null {
    return this.file;
  }

  info(...args: unknown[]): void {
    this.write('info', args);
  }

  warn(...args: unknown[]): void {
    this.write('warn', args);
  }

  error(...args: unknown[]): void {
    this.write('error', args);
  }

  private write(level: LogLevel, args: unknown[]): void {
    const text = args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 4, breakLength: Infinity }))).join(' ');
    const line = `${new Date().toISOString()} [${level}] ${text}\n`;
    if (this.echo) {
      const out = level === 'info' ? console.log : level === 'warn' ? console.warn : console.error;
      out(line.trimEnd());
    }
    if (!this.file) return;
    try {
      const bytes = Buffer.byteLength(line);
      if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate();
      fs.appendFileSync(this.file, line);
      this.size += bytes;
    } catch {
      // Logging must never take the app down.
    }
  }

  private rotate(): void {
    if (!this.file) return;
    const base = this.file.replace(/\.log$/, '');
    try {
      fs.rmSync(`${base}.${this.maxFiles}.log`, { force: true });
      for (let i = this.maxFiles - 1; i >= 1; i--) {
        const from = `${base}.${i}.log`;
        if (fs.existsSync(from)) fs.renameSync(from, `${base}.${i + 1}.log`);
      }
      if (this.maxFiles >= 1) fs.renameSync(this.file, `${base}.1.log`);
      else fs.rmSync(this.file, { force: true });
    } catch {
      // Best effort; fall through and keep appending.
    }
    this.size = 0;
  }
}

export const log = new Logger();

/** Turns a PTY spawn failure into an actionable, user-facing message. */
export function describeSpawnError(shell: string | undefined, err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const target = shell ?? 'default shell';
  if (/ENOENT|not found|cannot find|File not found|error code: 2\b/i.test(raw)) {
    return `Could not start "${target}": executable not found. Check that it is installed and on PATH, then restart the terminal. (${raw})`;
  }
  if (/EACCES|access is denied|error code: 5\b/i.test(raw)) {
    return `Could not start "${target}": permission denied. Check file permissions or antivirus blocking. (${raw})`;
  }
  return `Could not start "${target}": ${raw}`;
}

import fs from 'node:fs';
import path from 'node:path';
import { log } from './logger';

export const SCROLLBACK_MAX_LINES = 5000;
export const SCROLLBACK_FLUSH_MS = 1000;

/** Relative file name for a session's scrollback log (stored in `sessions.scrollback_path`). */
export function scrollbackFileName(sessionId: string): string {
  return `${sessionId}.log`;
}

/**
 * Line-capped output buffer. Trims lazily (at 1.2x the cap) so appends stay O(chunk),
 * and always cuts at a newline so replay never starts mid-line.
 */
export class LineRing {
  private text = '';
  private lines = 0;

  constructor(private readonly maxLines = SCROLLBACK_MAX_LINES) {}

  append(chunk: string): void {
    this.text += chunk;
    this.lines += countNewlines(chunk);
    if (this.lines > this.maxLines * 1.2) this.trim();
  }

  toString(): string {
    if (this.lines > this.maxLines) this.trim();
    return this.text;
  }

  private trim(): void {
    let drop = this.lines - this.maxLines;
    let i = 0;
    while (drop > 0) {
      i = this.text.indexOf('\n', i) + 1;
      drop--;
    }
    this.text = this.text.slice(i);
    this.lines = this.maxLines;
  }
}

function countNewlines(s: string): number {
  let n = 0;
  for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) n++;
  return n;
}

interface Entry {
  file: string;
  ring: LineRing;
  dirty: boolean;
  timer: NodeJS.Timeout | null;
}

/** Per-PTY scrollback persisted to `<dir>/<sessionId>.log` with debounced writes. */
export class ScrollbackStore {
  private readonly entries = new Map<string, Entry>();

  constructor(
    readonly dir: string,
    private readonly flushMs = SCROLLBACK_FLUSH_MS,
    private readonly maxLines = SCROLLBACK_MAX_LINES,
  ) {}

  /** Starts tracking `ptyId`, optionally seeded (e.g. with the restored previous session). Returns the relative file name. */
  attach(ptyId: string, sessionId: string, seed = ''): string {
    const name = scrollbackFileName(sessionId);
    const ring = new LineRing(this.maxLines);
    if (seed) ring.append(seed);
    this.entries.set(ptyId, { file: path.join(this.dir, name), ring, dirty: seed.length > 0, timer: null });
    if (seed) this.flush(ptyId);
    return name;
  }

  append(ptyId: string, data: string): void {
    const entry = this.entries.get(ptyId);
    if (!entry) return;
    entry.ring.append(data);
    entry.dirty = true;
    entry.timer ??= setTimeout(() => {
      entry.timer = null;
      this.flush(ptyId);
    }, this.flushMs);
  }

  /** Synchronous write; safe to call during shutdown. */
  flush(ptyId: string): void {
    const entry = this.entries.get(ptyId);
    if (!entry) return;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (!entry.dirty) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = `${entry.file}.tmp`;
      fs.writeFileSync(tmp, entry.ring.toString(), 'utf8');
      fs.renameSync(tmp, entry.file);
      entry.dirty = false;
    } catch (err) {
      log.warn('[scrollback] flush failed:', err);
    }
  }

  /** Final flush and stop tracking. */
  detach(ptyId: string): void {
    this.flush(ptyId);
    this.entries.delete(ptyId);
  }

  flushAll(): void {
    for (const id of this.entries.keys()) this.flush(id);
  }

  /** Reads a stored log by relative name; null if missing or the name escapes `dir`. */
  read(name: string | null | undefined): string | null {
    const file = this.resolve(name);
    if (!file) return null;
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  }

  remove(name: string | null | undefined): void {
    const file = this.resolve(name);
    if (file) fs.rmSync(file, { force: true });
  }

  /** Deletes logs not in `keep` (orphans from closed terminals). Returns the number removed. */
  sweep(keep: Set<string>): number {
    let removed = 0;
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return 0;
    }
    const live = new Set([...this.entries.values()].map((e) => path.basename(e.file)));
    for (const name of names) {
      if (keep.has(name) || live.has(name)) continue;
      fs.rmSync(path.join(this.dir, name), { force: true });
      removed++;
    }
    return removed;
  }

  private resolve(name: string | null | undefined): string | null {
    if (!name || name !== path.basename(name) || !name.endsWith('.log')) return null;
    return path.join(this.dir, name);
  }
}

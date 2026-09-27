// SQLite persistence (better-sqlite3). This module is the only place that talks
// to the database driver; the rest of the main process uses CrewdeckDb.
// It is deliberately free of `electron` imports so it can be exercised from
// plain Node and from the smoke test with any file path.
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentId } from '../../shared/agents';
import { LATEST_SCHEMA_VERSION, MIGRATIONS, type Migration } from './migrations';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface ProjectRow {
  id: string;
  path: string;
  name: string;
  layout: Record<string, Json>;
  createdAt: number;
  lastOpenedAt: number;
}

export interface TerminalRow {
  id: string;
  projectId: string;
  title: string;
  profileId: AgentId;
  cwd: string;
  position: number;
  config: Record<string, Json>;
  createdAt: number;
  updatedAt: number;
}

export interface SessionRow {
  id: string;
  terminalId: string;
  pid: number | null;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  scrollbackPath: string | null;
  metadata: Record<string, Json>;
}

export type TerminalInput = Pick<TerminalRow, 'title' | 'profileId' | 'cwd'> &
  Partial<Pick<TerminalRow, 'id' | 'config'>>;

export type RouteKind = 'composer' | 'forward' | 'browser';

export interface RouteRow {
  id: string;
  projectId: string;
  kind: RouteKind;
  fromLabel: string;
  targets: string[];
  preview: string;
  bytes: number;
  viaFile: boolean;
  createdAt: number;
}

export type RouteInput = Pick<RouteRow, 'kind' | 'fromLabel' | 'targets' | 'preview'> &
  Partial<Pick<RouteRow, 'bytes' | 'viaFile'>>;

interface RawRoute {
  id: string;
  project_id: string;
  kind: string;
  from_label: string;
  targets: string;
  preview: string;
  bytes: number;
  via_file: number;
  created_at: number;
}

const toRoute = (r: RawRoute): RouteRow => ({
  id: r.id,
  projectId: r.project_id,
  kind: r.kind as RouteKind,
  fromLabel: r.from_label,
  targets: JSON.parse(r.targets),
  preview: r.preview,
  bytes: r.bytes,
  viaFile: r.via_file === 1,
  createdAt: r.created_at,
});

interface RawProject {
  id: string;
  path: string;
  name: string;
  layout: string;
  created_at: number;
  last_opened_at: number;
}
interface RawTerminal {
  id: string;
  project_id: string;
  title: string;
  profile_id: string;
  cwd: string;
  position: number;
  config: string;
  created_at: number;
  updated_at: number;
}
interface RawSession {
  id: string;
  terminal_id: string;
  pid: number | null;
  started_at: number;
  ended_at: number | null;
  exit_code: number | null;
  scrollback_path: string | null;
  metadata: string;
}

const toProject = (r: RawProject): ProjectRow => ({
  id: r.id,
  path: r.path,
  name: r.name,
  layout: JSON.parse(r.layout),
  createdAt: r.created_at,
  lastOpenedAt: r.last_opened_at,
});
const toTerminal = (r: RawTerminal): TerminalRow => ({
  id: r.id,
  projectId: r.project_id,
  title: r.title,
  profileId: r.profile_id as AgentId,
  cwd: r.cwd,
  position: r.position,
  config: JSON.parse(r.config),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const toSession = (r: RawSession): SessionRow => ({
  id: r.id,
  terminalId: r.terminal_id,
  pid: r.pid,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  exitCode: r.exit_code,
  scrollbackPath: r.scrollback_path,
  metadata: JSON.parse(r.metadata),
});

/**
 * Applies pending migrations in order, each in its own transaction together with
 * the user_version bump, so a failed migration leaves the previous version intact.
 * Returns the versions that were applied.
 */
export function migrate(db: Database.Database, migrations: readonly Migration[] = MIGRATIONS): number[] {
  const current = db.pragma('user_version', { simple: true }) as number;
  const latest = migrations.length ? migrations[migrations.length - 1].version : 0;
  if (current > latest) {
    throw new Error(
      `Database schema v${current} is newer than this build supports (v${latest}). Update crewdeck or remove the database.`,
    );
  }
  const applied: number[] = [];
  for (const m of migrations) {
    if (m.version <= current) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    })();
    applied.push(m.version);
  }
  return applied;
}

export class CrewdeckDb {
  readonly raw: Database.Database;
  readonly appliedMigrations: number[];

  constructor(readonly file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new Database(file);
    try {
      this.raw.pragma('journal_mode = WAL');
      this.raw.pragma('synchronous = NORMAL');
      this.raw.pragma('foreign_keys = ON');
      this.raw.pragma('busy_timeout = 5000');
      this.appliedMigrations = migrate(this.raw);
    } catch (err) {
      // Don't leak the file handle (Windows keeps the DB/WAL locked otherwise).
      this.raw.close();
      throw err;
    }
  }

  get schemaVersion(): number {
    return this.raw.pragma('user_version', { simple: true }) as number;
  }

  close(): void {
    if (this.raw.open) this.raw.close();
  }

  // ---- settings -----------------------------------------------------------

  getSetting<T extends Json>(key: string, fallback: T): T {
    const row = this.raw.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : fallback;
  }

  setSetting(key: string, value: Json): void {
    this.raw
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), Date.now());
  }

  // ---- projects -----------------------------------------------------------

  /** Inserts the project if new, otherwise refreshes its name and last_opened_at. */
  openProject(projectPath: string, name: string): ProjectRow {
    const now = Date.now();
    const row = this.raw
      .prepare(
        `INSERT INTO projects (id, path, name, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (path) DO UPDATE SET name = excluded.name, last_opened_at = excluded.last_opened_at
         RETURNING *`,
      )
      .get(randomUUID(), projectPath, name, now, now) as RawProject;
    return toProject(row);
  }

  getLastProject(): ProjectRow | null {
    const row = this.raw.prepare('SELECT * FROM projects ORDER BY last_opened_at DESC LIMIT 1').get() as
      RawProject | undefined;
    return row ? toProject(row) : null;
  }

  getProject(projectId: string): ProjectRow | null {
    const row = this.raw.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as RawProject | undefined;
    return row ? toProject(row) : null;
  }

  saveProjectLayout(projectId: string, layout: Record<string, Json>): void {
    this.raw.prepare('UPDATE projects SET layout = ? WHERE id = ?').run(JSON.stringify(layout), projectId);
  }

  // ---- terminals ----------------------------------------------------------

  listTerminals(projectId: string): TerminalRow[] {
    const rows = this.raw
      .prepare('SELECT * FROM terminals WHERE project_id = ? ORDER BY position, created_at')
      .all(projectId) as RawTerminal[];
    return rows.map(toTerminal);
  }

  /**
   * Replaces the project's terminal set with `terminals` (in display order):
   * rows with a known id are updated in place (keeping their sessions), new ones
   * inserted, missing ones deleted (cascading to their sessions).
   */
  saveTerminals(projectId: string, terminals: readonly TerminalInput[]): TerminalRow[] {
    const now = Date.now();
    const upsert = this.raw.prepare(
      `INSERT INTO terminals (id, project_id, title, profile_id, cwd, position, config, created_at, updated_at)
       VALUES (@id, @projectId, @title, @profileId, @cwd, @position, @config, @now, @now)
       ON CONFLICT (id) DO UPDATE SET
         title = excluded.title, profile_id = excluded.profile_id, cwd = excluded.cwd,
         position = excluded.position, config = excluded.config, updated_at = excluded.updated_at
       WHERE terminals.project_id = excluded.project_id`,
    );
    this.raw.transaction(() => {
      const ids = terminals.map((t, position) => {
        const id = t.id ?? randomUUID();
        upsert.run({
          id,
          projectId,
          title: t.title,
          profileId: t.profileId,
          cwd: t.cwd,
          position,
          config: JSON.stringify(t.config ?? {}),
          now,
        });
        return id;
      });
      this.raw
        .prepare('DELETE FROM terminals WHERE project_id = ? AND id NOT IN (SELECT value FROM json_each(?))')
        .run(projectId, JSON.stringify(ids));
    })();
    return this.listTerminals(projectId);
  }

  // ---- sessions -----------------------------------------------------------

  startSession(terminalId: string, pid: number | null, metadata: Record<string, Json> = {}): SessionRow {
    const row = this.raw
      .prepare(`INSERT INTO sessions (id, terminal_id, pid, started_at, metadata) VALUES (?, ?, ?, ?, ?) RETURNING *`)
      .get(randomUUID(), terminalId, pid, Date.now(), JSON.stringify(metadata)) as RawSession;
    return toSession(row);
  }

  endSession(sessionId: string, exitCode: number | null): void {
    this.raw
      .prepare('UPDATE sessions SET ended_at = ?, exit_code = ? WHERE id = ? AND ended_at IS NULL')
      .run(Date.now(), exitCode, sessionId);
  }

  setSessionScrollback(sessionId: string, scrollbackPath: string): void {
    this.raw.prepare('UPDATE sessions SET scrollback_path = ? WHERE id = ?').run(scrollbackPath, sessionId);
  }

  latestSession(terminalId: string): SessionRow | null {
    const row = this.raw
      .prepare('SELECT * FROM sessions WHERE terminal_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1')
      .get(terminalId) as RawSession | undefined;
    return row ? toSession(row) : null;
  }

  /** Scrollback files still referenced: the latest session of every existing terminal. */
  liveScrollbackPaths(): Set<string> {
    const rows = this.raw
      .prepare(
        `SELECT scrollback_path AS p FROM (
           SELECT scrollback_path, ROW_NUMBER() OVER (PARTITION BY terminal_id ORDER BY started_at DESC, rowid DESC) AS rn
           FROM sessions
         ) WHERE rn = 1 AND scrollback_path IS NOT NULL`,
      )
      .all() as { p: string }[];
    return new Set(rows.map((r) => r.p));
  }

  // ---- routing log --------------------------------------------------------

  logRoute(projectId: string, input: RouteInput): RouteRow {
    const row = this.raw
      .prepare(
        `INSERT INTO routing_log (id, project_id, kind, from_label, targets, preview, bytes, via_file, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        randomUUID(),
        projectId,
        input.kind,
        input.fromLabel,
        JSON.stringify(input.targets),
        input.preview,
        input.bytes ?? 0,
        input.viaFile ? 1 : 0,
        Date.now(),
      ) as RawRoute;
    return toRoute(row);
  }

  /** Most recent first. */
  listRoutes(projectId: string, limit = 200): RouteRow[] {
    const rows = this.raw
      .prepare('SELECT * FROM routing_log WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(projectId, limit) as RawRoute[];
    return rows.map(toRoute);
  }

  /** Marks sessions left open by a crash / hard kill as ended (exit_code NULL). */
  closeDanglingSessions(): number {
    return this.raw.prepare('UPDATE sessions SET ended_at = ? WHERE ended_at IS NULL').run(Date.now()).changes;
  }
}

export { LATEST_SCHEMA_VERSION };

let instance: CrewdeckDb | null = null;

/** Opens (once) the app database at `file`, running migrations. */
export function openDatabase(file: string): CrewdeckDb {
  instance ??= new CrewdeckDb(file);
  return instance;
}

export function getDatabase(): CrewdeckDb {
  if (!instance) throw new Error('Database not opened yet');
  return instance;
}

export function closeDatabase(): void {
  instance?.close();
  instance = null;
}

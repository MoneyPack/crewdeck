-- crewdeck schema, version 1 (baseline).
--
-- Applied by electron/services/db.ts as migration #1. Later changes go into
-- database/migrations/NNN_*.sql and are appended to the migration list; this
-- file is never edited after release.
--
-- Conventions:
--   * ids are TEXT (UUIDs generated in the main process)
--   * timestamps are INTEGER unix epoch milliseconds
--   * JSON columns are TEXT guarded by json_valid() and queried via json_extract()

CREATE TABLE projects (
  id              TEXT    PRIMARY KEY,
  path            TEXT    NOT NULL UNIQUE,
  name            TEXT    NOT NULL,
  -- UI layout snapshot: { "layout": "1"|"2"|"4", "activeTerminalId": "...", ... }
  layout          TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(layout)),
  created_at      INTEGER NOT NULL,
  last_opened_at  INTEGER NOT NULL
);

CREATE INDEX idx_projects_last_opened ON projects (last_opened_at DESC);

CREATE TABLE terminals (
  id          TEXT    PRIMARY KEY,
  project_id  TEXT    NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  title       TEXT    NOT NULL,
  -- agent profile id from shared/agents.ts ('shell', 'claude', 'codex', 'gemini', ...)
  profile_id  TEXT    NOT NULL,
  cwd         TEXT    NOT NULL,
  position    INTEGER NOT NULL DEFAULT 0,
  -- spawn overrides and UI state: { "shell": "...", "args": [...], "env": {...} }
  config      TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(config)),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX idx_terminals_project ON terminals (project_id, position);

CREATE TABLE sessions (
  id              TEXT    PRIMARY KEY,
  terminal_id     TEXT    NOT NULL REFERENCES terminals (id) ON DELETE CASCADE,
  pid             INTEGER,
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER,
  exit_code       INTEGER,
  -- file (relative to userData/scrollback) holding the persisted output ring buffer
  scrollback_path TEXT,
  -- free-form: { "resumeCommand": "claude --continue", "restoredFrom": "<session id>" }
  metadata        TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(metadata)),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE INDEX idx_sessions_terminal ON sessions (terminal_id, started_at DESC);

CREATE TABLE settings (
  key         TEXT    PRIMARY KEY,
  -- every value is JSON so booleans/numbers/objects round-trip losslessly
  value       TEXT    NOT NULL CHECK (json_valid(value)),
  updated_at  INTEGER NOT NULL
);

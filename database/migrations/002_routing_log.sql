-- Migration 2: routing log (CD-17).
-- One row per routed message: composer @mentions and selection forwards.

CREATE TABLE routing_log (
  id          TEXT    PRIMARY KEY,
  project_id  TEXT    NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  -- 'composer' (typed @mention) or 'forward' (terminal selection sent to an agent)
  kind        TEXT    NOT NULL CHECK (kind IN ('composer', 'forward')),
  -- sender label: 'you' for the composer, the source terminal title for forwards
  from_label  TEXT    NOT NULL,
  -- JSON array of recipient handles, e.g. ["claude-1", "codex-1"]
  targets     TEXT    NOT NULL CHECK (json_valid(targets) AND json_type(targets) = 'array'),
  -- first part of the routed text (ANSI-stripped)
  preview     TEXT    NOT NULL,
  -- total routed size in bytes and whether it went through a temp file
  bytes       INTEGER NOT NULL DEFAULT 0,
  via_file    INTEGER NOT NULL DEFAULT 0 CHECK (via_file IN (0, 1)),
  created_at  INTEGER NOT NULL
);

CREATE INDEX idx_routing_log_project ON routing_log (project_id, created_at DESC);

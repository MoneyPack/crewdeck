-- Migration 3: routing log gains the 'browser' kind (agent/UI browser commands).
-- SQLite cannot alter a CHECK constraint in place, so the table is rebuilt.
-- Nothing references routing_log, so the drop/rename is safe with foreign_keys ON.

CREATE TABLE routing_log_new (
  id          TEXT    PRIMARY KEY,
  project_id  TEXT    NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  -- 'composer' (typed @mention), 'forward' (terminal selection sent to an agent),
  -- 'browser' (a command driven through the crewdeck browser pane)
  kind        TEXT    NOT NULL CHECK (kind IN ('composer', 'forward', 'browser')),
  from_label  TEXT    NOT NULL,
  targets     TEXT    NOT NULL CHECK (json_valid(targets) AND json_type(targets) = 'array'),
  preview     TEXT    NOT NULL,
  bytes       INTEGER NOT NULL DEFAULT 0,
  via_file    INTEGER NOT NULL DEFAULT 0 CHECK (via_file IN (0, 1)),
  created_at  INTEGER NOT NULL
);

INSERT INTO routing_log_new (id, project_id, kind, from_label, targets, preview, bytes, via_file, created_at)
  SELECT id, project_id, kind, from_label, targets, preview, bytes, via_file, created_at FROM routing_log;

DROP TABLE routing_log;
ALTER TABLE routing_log_new RENAME TO routing_log;

CREATE INDEX idx_routing_log_project ON routing_log (project_id, created_at DESC);

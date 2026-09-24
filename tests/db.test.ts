import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { CrewdeckDb, LATEST_SCHEMA_VERSION, migrate } from '../electron/services/db';
import { MIGRATIONS } from '../electron/services/migrations';

function withDb(fn: (db: CrewdeckDb) => void): void {
  const db = new CrewdeckDb(':memory:');
  try {
    fn(db);
  } finally {
    db.close();
  }
}

test('fresh database applies every migration', () => {
  withDb((db) => {
    assert.equal(db.schemaVersion, LATEST_SCHEMA_VERSION);
    assert.deepEqual(db.appliedMigrations, MIGRATIONS.map((m) => m.version));
    assert.equal(db.raw.pragma('user_version', { simple: true }), LATEST_SCHEMA_VERSION);
  });
});

test('migrate is idempotent and refuses newer schemas', () => {
  const raw = new Database(':memory:');
  try {
    assert.deepEqual(migrate(raw), MIGRATIONS.map((m) => m.version));
    assert.deepEqual(migrate(raw), []);
    raw.pragma(`user_version = ${LATEST_SCHEMA_VERSION + 1}`);
    assert.throws(() => migrate(raw), /newer than this build supports/);
  } finally {
    raw.close();
  }
});

test('failed migration rolls back its own step', () => {
  const raw = new Database(':memory:');
  try {
    const bad = [
      { version: 1, name: 'ok', sql: 'CREATE TABLE a (x INTEGER);' },
      { version: 2, name: 'broken', sql: 'CREATE TABLE b (y INTEGER); SELECT * FROM missing_table;' },
    ];
    assert.throws(() => migrate(raw, bad));
    assert.equal(raw.pragma('user_version', { simple: true }), 1);
    const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    assert.deepEqual(tables.map((t) => t.name), ['a']);
  } finally {
    raw.close();
  }
});

test('projects: upsert by path, last project, layout', () => {
  withDb((db) => {
    const a = db.openProject('C:/a', 'a');
    const again = db.openProject('C:/a', 'renamed');
    assert.equal(again.id, a.id);
    assert.equal(again.name, 'renamed');
    assert.deepEqual(a.layout, {});
    db.raw.prepare('UPDATE projects SET last_opened_at = 0 WHERE id = ?').run(a.id);
    const b = db.openProject('C:/b', 'b');
    assert.equal(db.getLastProject()?.id, b.id);
    db.saveProjectLayout(a.id, { cols: 2, panes: ['x', null] });
    assert.deepEqual(db.getProject(a.id)?.layout, { cols: 2, panes: ['x', null] });
    assert.equal(db.getProject('nope'), null);
  });
});

test('terminals: ordered replace keeps ids and cascades deletes', () => {
  withDb((db) => {
    const p = db.openProject('C:/p', 'p');
    const first = db.saveTerminals(p.id, [
      { title: 'shell', profileId: 'shell', cwd: 'C:/p' },
      { title: 'claude', profileId: 'claude', cwd: 'C:/p', config: { yolo: true } },
    ]);
    assert.deepEqual(first.map((t) => [t.title, t.position]), [['shell', 0], ['claude', 1]]);
    assert.deepEqual(first[1].config, { yolo: true });

    const [shell, claude] = first;
    const s = db.startSession(shell.id, 1);
    const second = db.saveTerminals(p.id, [
      { id: claude.id, title: 'claude*', profileId: 'claude', cwd: 'C:/p' },
      { title: 'codex', profileId: 'codex', cwd: 'C:/p' },
    ]);
    assert.deepEqual(second.map((t) => t.title), ['claude*', 'codex']);
    assert.equal(second[0].id, claude.id);
    assert.equal(db.latestSession(shell.id), null, 'sessions cascade with their terminal');
    assert.equal((db.raw.prepare('SELECT COUNT(*) AS n FROM sessions WHERE id = ?').get(s.id) as { n: number }).n, 0);

    // A foreign project cannot hijack another project's terminal id.
    const q = db.openProject('C:/q', 'q');
    db.saveTerminals(q.id, [{ id: claude.id, title: 'stolen', profileId: 'gemini', cwd: 'C:/q' }]);
    assert.equal(db.listTerminals(p.id)[0].title, 'claude*');
  });
});

test('sessions: lifecycle, latest, dangling, live scrollback', () => {
  withDb((db) => {
    const p = db.openProject('C:/p', 'p');
    const [t1, t2] = db.saveTerminals(p.id, [
      { title: 'a', profileId: 'shell', cwd: 'C:/p' },
      { title: 'b', profileId: 'shell', cwd: 'C:/p' },
    ]);
    const old = db.startSession(t1.id, 10, { agent: 'shell' });
    db.setSessionScrollback(old.id, 'old.log');
    db.endSession(old.id, 0);
    const cur = db.startSession(t1.id, 11);
    db.setSessionScrollback(cur.id, 'cur.log');
    const other = db.startSession(t2.id, null);
    db.setSessionScrollback(other.id, 'other.log');

    const ended = db.latestSession(t1.id);
    assert.equal(ended?.id, cur.id);
    assert.deepEqual(old.metadata, { agent: 'shell' });

    db.endSession(old.id, 5); // already ended: ignored
    const oldRow = db.raw.prepare('SELECT exit_code FROM sessions WHERE id = ?').get(old.id) as { exit_code: number };
    assert.equal(oldRow.exit_code, 0);

    assert.deepEqual([...db.liveScrollbackPaths()].sort(), ['cur.log', 'other.log']);
    assert.equal(db.closeDanglingSessions(), 2);
    assert.equal(db.closeDanglingSessions(), 0);
    const closed = db.latestSession(t1.id);
    assert.ok(closed?.endedAt);
    assert.equal(closed?.exitCode, null);
  });
});

test('routing log: round-trip, ordering, limit, project scope', () => {
  withDb((db) => {
    const p = db.openProject('C:/p', 'p');
    const q = db.openProject('C:/q', 'q');
    const r1 = db.logRoute(p.id, { kind: 'composer', fromLabel: 'you', targets: ['claude', 'codex'], preview: 'hi' });
    assert.equal(r1.bytes, 0);
    assert.equal(r1.viaFile, false);
    assert.deepEqual(r1.targets, ['claude', 'codex']);
    const r2 = db.logRoute(p.id, { kind: 'forward', fromLabel: 'claude', targets: ['gemini'], preview: 'x', bytes: 9, viaFile: true });
    assert.equal(r2.viaFile, true);
    db.logRoute(q.id, { kind: 'composer', fromLabel: 'you', targets: ['codex'], preview: 'q' });

    const list = db.listRoutes(p.id);
    assert.deepEqual(list.map((r) => r.id), [r2.id, r1.id]);
    assert.deepEqual(db.listRoutes(p.id, 1).map((r) => r.id), [r2.id]);
    assert.equal(db.listRoutes(q.id).length, 1);
  });
});

// Headless smoke test for PtyManager, run inside Electron so node-pty is loaded
// against the Electron ABI (the same binary the app uses).
// Checks: spawn default shell, input/output round-trip, resize, kill -> exit event.
import { app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { INLINE_FORWARD_LIMIT, stripAnsi, utf8Length } from '../shared/ansi';
import { ROUTE_PREVIEW_LIMIT } from '../shared/ipc';
import { mentionCompletions, mentionHandles, parseMention } from '../shared/mention';
import { MAX_ROUTE_LABEL, MAX_ROUTE_TARGETS, parseRouteInput } from '../shared/routeLog';
import { writeForwardTemp } from './ipc/routing';
import { CrewdeckDb, LATEST_SCHEMA_VERSION } from './services/db';
import { langForPath, tokenizeLine } from '../src/components/GitPanel/highlight';
import {
  gitDiff,
  gitDiscard,
  gitStage,
  gitStatus,
  gitUnstage,
  isRelevantChange,
  parsePorcelain,
  resolveInRepo,
  runGit,
  watchRepo,
} from './services/git';
import { PtyManager, resolveDefaultShell } from './services/ptyManager';
import { LineRing, ScrollbackStore } from './services/scrollback';
import { Logger, describeSpawnError } from './services/logger';

const TIMEOUT_MS = 20_000;

function fail(message: string): never {
  console.error(`SMOKE FAIL: ${message}`);
  app.exit(1);
  throw new Error(message);
}

function check(cond: unknown, message: string): void {
  if (!cond) fail(`db: ${message}`);
}

function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

// DB checks: migrations, idempotent reopen, round-trips, json_extract, FK cascade, json_valid guard.
function dbChecks(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewdeck-smoke-'));
  const file = path.join(dir, 'crewdeck.db');
  let db: CrewdeckDb | undefined;
  try {
    db = new CrewdeckDb(file);
    check(db.appliedMigrations.length === LATEST_SCHEMA_VERSION, `fresh db applied ${db.appliedMigrations}`);
    check(db.schemaVersion === LATEST_SCHEMA_VERSION, `schemaVersion ${db.schemaVersion}`);
    check(db.raw.pragma('foreign_keys', { simple: true }) === 1, 'foreign_keys off');
    check(db.raw.pragma('journal_mode', { simple: true }) === 'wal', 'journal_mode not wal');
    db.close();

    db = new CrewdeckDb(file);
    check(db.appliedMigrations.length === 0, 'reopen re-applied migrations');

    // settings
    check(db.getSetting('theme', 'dark') === 'dark', 'setting fallback');
    db.setSetting('theme', 'light');
    db.setSetting('theme', 'solarized');
    check(db.getSetting<string>('theme', 'dark') === 'solarized', 'setting upsert');

    // projects
    const p1 = db.openProject('C:\\work\\alpha', 'alpha');
    const p1b = db.openProject('C:\\work\\alpha', 'alpha-renamed');
    check(p1.id === p1b.id && p1b.name === 'alpha-renamed', 'project upsert keeps id');
    db.saveProjectLayout(p1.id, { split: 'horizontal', sizes: [60, 40], active: 1 });
    check(db.getLastProject()?.layout.split === 'horizontal', 'layout round-trip');
    const viaJson = db.raw
      .prepare("SELECT json_extract(layout, '$.sizes[0]') AS s FROM projects WHERE id = ?")
      .get(p1.id) as { s: number };
    check(viaJson.s === 60, 'json_extract on layout');

    // terminals: insert, reorder/update, delete missing
    let terms = db.saveTerminals(p1.id, [
      { title: 'claude', profileId: 'claude', cwd: 'C:\\work\\alpha' },
      { title: 'shell', profileId: 'shell' as never, cwd: 'C:\\work\\alpha', config: { fontSize: 13 } },
    ]);
    check(terms.length === 2 && terms[1].config.fontSize === 13, 'terminals insert');
    const [t0, t1] = terms;
    const s0 = db.startSession(t0.id, 1234, { resumeCommand: 'claude --continue' });
    db.setSessionScrollback(s0.id, `${t0.id}.log`);
    check(db.liveScrollbackPaths().has(`${t0.id}.log`), 'liveScrollbackPaths');
    db.startSession(t1.id, 5678);
    terms = db.saveTerminals(p1.id, [{ ...t1, title: 'shell 2' }]);
    check(terms.length === 1 && terms[0].id === t1.id && terms[0].position === 0, 'terminals reorder/delete');
    check(db.latestSession(t0.id) === null, 'FK cascade removed deleted terminal sessions');
    check(db.latestSession(t1.id)?.pid === 5678, 'sessions kept for surviving terminal');

    // sessions
    check(db.closeDanglingSessions() === 1, 'closeDanglingSessions count');
    const s2 = db.startSession(t1.id, 9, { resumeCommand: 'claude --continue' });
    db.endSession(s2.id, 0);
    const latest = db.latestSession(t1.id);
    check(latest?.id === s2.id && latest.exitCode === 0 && latest.endedAt !== null, 'session end');
    check(latest?.metadata.resumeCommand === 'claude --continue', 'session metadata');

    // guards
    const g = db;
    check(
      throws(() => g.raw.prepare("UPDATE projects SET layout = '{bad' WHERE id = ?").run(p1.id)),
      'json_valid CHECK did not reject invalid JSON',
    );
    check(throws(() => g.startSession('no-such-terminal', null)), 'FK did not reject orphan session');

    // routing log (CD-17): round-trip, newest-first, per-project, CHECK guards
    const r1 = db.logRoute(p1.id, { kind: 'composer', fromLabel: 'composer', targets: [t1.id], preview: 'hi', bytes: 2 });
    const r2 = db.logRoute(p1.id, {
      kind: 'forward',
      fromLabel: 'shell 2',
      targets: [t1.id, 'x'],
      preview: 'big',
      bytes: 5000,
      viaFile: true,
    });
    check(typeof r1.createdAt === 'number' && r1.targets[0] === t1.id && !r1.viaFile, 'logRoute round-trip');
    const routes = db.listRoutes(p1.id);
    check(routes.length === 2 && routes[0].id === r2.id && routes[1].id === r1.id, 'listRoutes newest-first');
    check(routes[0].viaFile && routes[0].bytes === 5000 && routes[0].targets.length === 2, 'route fields');
    check(db.listRoutes(p1.id, 1).length === 1, 'listRoutes limit');
    const p2 = db.openProject('C:\\work\\beta', 'beta');
    check(db.listRoutes(p2.id).length === 0, 'routes scoped per project');
    const insertRaw = (kind: string, targets: string) =>
      g.raw
        .prepare(
          `INSERT INTO routing_log (id, project_id, kind, from_label, targets, preview, bytes, via_file, created_at)
           VALUES (lower(hex(randomblob(8))), ?, ?, 'x', ?, 'p', 0, 0, 0)`,
        )
        .run(p1.id, kind, targets);
    check(throws(() => insertRaw('bogus', '["a"]')), 'kind CHECK');
    check(throws(() => insertRaw('forward', '{bad')), 'targets json CHECK');
    check(throws(() => g.logRoute('no-such-project', { kind: 'composer', fromLabel: 'x', targets: ['a'], preview: '' })), 'route FK');

    // parseRouteInput guards
    const parsed = parseRouteInput({ kind: 'forward', fromLabel: 'a'.repeat(300), targets: ['t'], preview: 'p'.repeat(400), bytes: 12.7, viaFile: 1 });
    check(
      parsed?.fromLabel.length === MAX_ROUTE_LABEL && parsed.preview.length === ROUTE_PREVIEW_LIMIT && parsed.bytes === 12 && parsed.viaFile === false,
      'parseRouteInput normalises',
    );
    check(parseRouteInput({ kind: 'composer', fromLabel: 'a', targets: ['t'], preview: '', bytes: -1 })?.bytes === 0, 'negative bytes');
    for (const bad of [
      null,
      'x',
      { kind: 'nope', fromLabel: 'a', targets: ['t'], preview: '' },
      { kind: 'composer', fromLabel: '', targets: ['t'], preview: '' },
      { kind: 'composer', fromLabel: 'a', targets: [], preview: '' },
      { kind: 'composer', fromLabel: 'a', targets: [''], preview: '' },
      { kind: 'composer', fromLabel: 'a', targets: Array(MAX_ROUTE_TARGETS + 1).fill('t'), preview: '' },
      { kind: 'composer', fromLabel: 'a', targets: ['t'.repeat(MAX_ROUTE_LABEL + 1)], preview: '' },
      { kind: 'composer', fromLabel: 'a', targets: ['t'], preview: 5 },
    ]) {
      check(parseRouteInput(bad) === null, `parseRouteInput accepted ${JSON.stringify(bad)?.slice(0, 60)}`);
    }

    // project delete cascades to terminals, sessions and routing log
    db.raw.prepare('DELETE FROM projects WHERE id = ?').run(p1.id);
    const left = db.raw
      .prepare('SELECT (SELECT count(*) FROM terminals) + (SELECT count(*) FROM sessions) + (SELECT count(*) FROM routing_log) AS n')
      .get() as { n: number };
    check(left.n === 0, 'project delete cascade');

    // too-new schema is refused
    db.raw.pragma(`user_version = ${LATEST_SCHEMA_VERSION + 1}`);
    db.close();
    check(throws(() => new CrewdeckDb(file)), 'newer schema not refused');
    console.log(`db ok (schema v${LATEST_SCHEMA_VERSION})`);
  } finally {
    if (db?.raw.open) db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Scrollback checks: line cap cuts at newlines, flush/read round-trip, path guard, sweep.
function scrollbackChecks(): void {
  const ring = new LineRing(10);
  for (let i = 0; i < 50; i++) ring.append(`line${i}\n`);
  const text = ring.toString();
  const lines = text.split('\n').filter(Boolean);
  check(lines.length === 10 && lines[0] === 'line40' && lines[9] === 'line49', `ring cap: ${lines[0]}..${lines.length}`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewdeck-sb-'));
  try {
    const store = new ScrollbackStore(dir, 60_000, 100);
    const name = store.attach('pty1', 'sess1', 'seed\n');
    check(name === 'sess1.log' && store.read(name) === 'seed\n', 'seed flushed on attach');
    store.append('pty1', 'more\n');
    check(store.read(name) === 'seed\n', 'append is debounced');
    store.flushAll();
    check(store.read(name) === 'seed\nmore\n', 'flushAll writes');
    check(store.read('../sess1.log') === null && store.read('x.txt') === null, 'resolve guard');
    fs.writeFileSync(path.join(dir, 'orphan.log'), 'x');
    fs.writeFileSync(path.join(dir, 'kept.log'), 'x');
    check(store.sweep(new Set(['kept.log'])) === 1, 'sweep count');
    check(fs.existsSync(path.join(dir, 'kept.log')) && fs.existsSync(path.join(dir, name)), 'sweep kept live + keep');
    store.detach('pty1');
    store.append('pty1', 'ignored\n');
    check(store.read(name) === 'seed\nmore\n', 'detach stops tracking');
    console.log('scrollback ok');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Mention parser (CD-14): targets, multi, @all, case, dup titles, punctuation, errors, completions.
function mentionChecks(): void {
  const terms = [
    { id: 'a', title: 'Claude' },
    { id: 'b', title: 'codex' },
    { id: 'c', title: 'Claude' },
    { id: 'd', title: 'My Shell' },
    { id: 'e', title: 'all' },
  ];
  const hs = mentionHandles(terms).map((t) => t.handle);
  check(hs.join() === 'claude,codex,claude-2,my-shell,all-2', `handles ${hs}`);

  const ok = (input: string) => {
    const r = parseMention(input, terms);
    if (!r.ok) fail(`mention: "${input}" -> ${r.error}`);
    return r;
  };
  const err = (input: string, re: RegExp) => {
    const r = parseMention(input, terms);
    check(!r.ok && re.test(r.error), `mention error for "${input}": ${r.ok ? 'ok' : r.error}`);
    return r;
  };

  let r = ok('@claude fix the test');
  check(r.targets.map((t) => t.id).join() === 'a' && r.message === 'fix the test' && !r.broadcast, 'single');
  r = ok('  @CODEX:   review  this  ');
  check(r.targets[0].id === 'b' && r.message === 'review  this', 'case/colon/whitespace');
  r = ok('@claude, @claude-2 @codex @claude hi @x');
  check(r.targets.map((t) => t.id).join() === 'a,c,b' && r.message === 'hi @x', 'multi + dedupe + inline @ kept');
  r = ok('@all git status');
  check(r.broadcast && r.targets.length === 5 && r.message === 'git status', 'broadcast');
  r = ok('@all-2 hi');
  check(r.targets[0].id === 'e', 'terminal titled "all" gets all-2');
  r = ok('@my-shell line1\nline2');
  check(r.message === 'line1\nline2', 'multiline message');

  const u = err('@codex @nope do it', /Unknown terminal @nope/);
  check(!u.ok && u.start === 7 && u.end === 12, 'unknown range');
  err('hello', /Start with @/);
  err('@ hi', /Missing terminal name/);
  err('@claude   ', /Message is empty/);
  check(!parseMention('@all hi', []).ok, 'broadcast with no terminals');

  check(mentionCompletions('@cl', terms).join() === 'claude,claude-2', 'completions');
  check(mentionCompletions('a', terms).join() === 'all-2,all', 'completions include all');
  console.log('mention ok');
}

// Output forwarding (CD-16): ANSI stripping, byte sizing, temp-file handoff.
function ansiChecks(): void {
  const raw = '\x1b[1;32mgreen\x1b[0m \x1b]0;title\x07ok\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\\r\nline2\rline3\x1b(B\x07';
  const clean = stripAnsi(raw);
  check(clean === 'green oklink\nline2\nline3', `stripAnsi -> ${JSON.stringify(clean)}`);
  check(stripAnsi('plain\ttext') === 'plain\ttext', 'stripAnsi keeps tabs');
  check(utf8Length('héllo') === 6 && utf8Length('') === 0, 'utf8Length');
  check(INLINE_FORWARD_LIMIT === 4096, 'inline limit');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewdeck-fwd-'));
  try {
    const big = 'x'.repeat(INLINE_FORWARD_LIMIT + 1);
    const file = writeForwardTemp(big, path.join(dir, 'nested'));
    check(path.dirname(file) === path.join(dir, 'nested') && file.endsWith('.txt'), 'temp path');
    check(fs.readFileSync(file, 'utf8') === big, 'temp content');
    check(writeForwardTemp(big, path.join(dir, 'nested')) !== file, 'unique temp names');
    check(throws(() => writeForwardTemp(42 as unknown as string, dir)), 'rejects non-string');
    check(throws(() => writeForwardTemp('x'.repeat(8 * 1024 * 1024 + 1), dir)), 'rejects > 8 MB');
    console.log('forward ok');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Git service (CD-18): porcelain parser, path guard, watch filter, real repo status/diff.
async function gitChecks(): Promise<void> {
  // parser
  const p = parsePorcelain(
    '## main...origin/main [ahead 2, behind 1]\0 M a.txt\0M  b.txt\0R  new.txt\0old.txt\0?? u.txt\0UU c.txt\0!! ign\0',
  );
  check(p.branch === 'main' && p.upstream === 'origin/main' && p.ahead === 2 && p.behind === 1, 'porcelain branch');
  check(p.files.map((f) => f.state).join() === 'modified,modified,renamed,untracked,conflicted', `porcelain states ${p.files.map((f) => f.state)}`);
  check(!p.files[0].staged && p.files[0].unstaged && p.files[1].staged && !p.files[1].unstaged, 'porcelain staged flags');
  check(p.files[2].path === 'new.txt' && p.files[2].oldPath === 'old.txt', 'porcelain rename');
  check(parsePorcelain('## No commits yet on dev\0').branch === 'dev', 'porcelain unborn');
  check(parsePorcelain('## HEAD (no branch)\0').branch === 'HEAD (detached)', 'porcelain detached');
  const capped = parsePorcelain(' M a\0 M b\0 M c\0', 2);
  check(capped.files.length === 2 && capped.truncated, 'porcelain cap');

  // highlighter (CD-19): language detection + lossless tokenization
  check(langForPath('src/a.ts') !== null && langForPath('x.py') !== null, 'langForPath known');
  check(langForPath('README.unknownext') === null, 'langForPath unknown');
  for (const [file, line] of [
    ['a.ts', 'const x: number = 42; // "hi" \'q\''],
    ['a.py', 'def f(s="a#b"): return 0x1F  # c'],
    ['a.ts', 'let s = `unterminated'],
    ['a.txt', 'plain text'],
  ] as const) {
    const toks = tokenizeLine(line, langForPath(file));
    check(toks.map((t) => t.text).join('') === line, `tokenize lossless ${file}: ${line}`);
  }
  const tsToks = tokenizeLine('const x = 1; // c', langForPath('a.ts'));
  check(tsToks.some((t) => t.kind === 'kw' && t.text === 'const') && tsToks.some((t) => t.kind === 'com'), 'tokenize kinds');

  // path guard + watch filter
  const root = path.resolve(os.tmpdir(), 'repo');
  check(resolveInRepo(root, 'src/a.ts') === path.join(root, 'src', 'a.ts'), 'resolveInRepo ok');
  for (const bad of ['', '..', '../x', 'a/../../x', path.join(root, 'a'), '.git/config', '.GIT\\HEAD', 'a\0b']) {
    check(resolveInRepo(root, bad) === null, `resolveInRepo accepted ${JSON.stringify(bad)}`);
  }
  check(isRelevantChange('src/a.ts') && isRelevantChange(null) && isRelevantChange('.git/index'), 'relevant');
  check(!isRelevantChange('node_modules/x/y.js') && !isRelevantChange('.git/index.lock') && !isRelevantChange('.git/objects/ab/cd'), 'irrelevant');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewdeck-git-'));
  try {
    const plain = path.join(dir, 'plain');
    fs.mkdirSync(plain);
    const ns = await gitStatus(plain);
    check(!ns.isRepo && ns.files.length === 0 && !ns.error, `non-repo status ${JSON.stringify(ns)}`);
    const missing = await gitStatus(path.join(dir, 'nope'));
    check(!missing.isRepo && missing.error === 'project folder not found', 'missing folder');

    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    const git = (...args: string[]) => runGit(repo, args);
    await git('init', '-q', '-b', 'main');
    await git('config', 'user.email', 'smoke@crewdeck.local');
    await git('config', 'user.name', 'smoke');
    await git('config', 'core.autocrlf', 'false');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
    fs.writeFileSync(path.join(repo, 'move-me.txt'), 'rename body line\n'.repeat(10));
    await git('add', '.');
    await git('commit', '-q', '-m', 'init');

    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\nTWO\n');
    fs.writeFileSync(path.join(repo, 'staged.txt'), 'new\n');
    await git('add', 'staged.txt');
    await git('mv', 'move-me.txt', 'moved.txt');
    fs.mkdirSync(path.join(repo, 'sub'));
    fs.writeFileSync(path.join(repo, 'sub', 'u.txt'), 'untracked\nno-eol');
    fs.writeFileSync(path.join(repo, 'bin.dat'), Buffer.from([1, 0, 2, 3]));

    const st = await gitStatus(repo);
    check(st.isRepo && st.branch === 'main' && !st.error, `repo status ${JSON.stringify(st).slice(0, 200)}`);
    const by = new Map(st.files.map((f) => [f.path, f]));
    check(by.get('a.txt')?.state === 'modified' && by.get('a.txt')?.unstaged, 'modified file');
    check(by.get('staged.txt')?.state === 'added' && by.get('staged.txt')?.staged, 'staged add');
    check(by.get('moved.txt')?.state === 'renamed' && by.get('moved.txt')?.oldPath === 'move-me.txt', 'rename');
    check(by.get('sub/u.txt')?.state === 'untracked', 'untracked nested');
    const sub = await gitStatus(path.join(repo, 'sub'));
    check(sub.isRepo && sub.root === st.root, 'status from subfolder');

    const root2 = st.root!;
    const d1 = await gitDiff(root2, 'a.txt', 'unstaged');
    check(/^-two$/m.test(d1.patch) && /^\+TWO$/m.test(d1.patch) && !d1.binary, 'unstaged diff');
    const d2 = await gitDiff(root2, 'staged.txt', 'staged');
    check(/^\+new$/m.test(d2.patch), 'staged diff');
    check((await gitDiff(root2, 'staged.txt', 'unstaged')).patch === '', 'no unstaged diff for staged file');
    const d3 = await gitDiff(root2, 'moved.txt', 'staged', 'move-me.txt');
    check(/^rename from move-me\.txt$/m.test(d3.patch), `rename diff ${d3.patch.slice(0, 120)}`);
    const d4 = await gitDiff(root2, 'sub/u.txt', 'untracked');
    check(/^@@ -0,0 \+1,2 @@$/m.test(d4.patch) && /^\+no-eol$/m.test(d4.patch) && /No newline/.test(d4.patch), 'untracked diff');
    check((await gitDiff(root2, 'bin.dat', 'untracked')).binary, 'binary untracked');
    check(await gitDiff(root2, '../escape', 'unstaged').then(() => false, () => true), 'diff path guard');

    // CD-21 actions: stage / unstage / discard + guards
    const fileOf = async (p: string) => (await gitStatus(repo)).files.find((f) => f.path === p);
    await gitStage(root2, 'a.txt');
    check((await fileOf('a.txt'))?.staged && !(await fileOf('a.txt'))?.unstaged, 'stage');
    await gitUnstage(root2, 'a.txt');
    check(!(await fileOf('a.txt'))?.staged && (await fileOf('a.txt'))?.unstaged, 'unstage');
    await gitUnstage(root2, 'moved.txt', 'move-me.txt');
    const afterRen = await gitStatus(repo);
    check(!afterRen.files.some((f) => f.state === 'renamed'), 'unstage rename');
    await gitStage(root2, 'moved.txt');
    await gitStage(root2, 'move-me.txt');
    await gitDiscard(root2, 'a.txt', false);
    check(!(await fileOf('a.txt')) && fs.readFileSync(path.join(repo, 'a.txt'), 'utf8') === 'one\ntwo\n', 'discard tracked');
    await gitDiscard(root2, 'bin.dat', true);
    check(!fs.existsSync(path.join(repo, 'bin.dat')), 'discard untracked');
    check(await gitDiscard(root2, 'staged.txt', true).then(() => false, (e: Error) => /tracked/.test(e.message)), 'refuse delete tracked');
    check(fs.existsSync(path.join(repo, 'staged.txt')), 'tracked file kept');
    check(await gitStage(root2, '../escape').then(() => false, () => true), 'stage path guard');
    check(await gitDiscard(root2, '../escape', true).then(() => false, () => true), 'discard path guard');

    // unstage in a repo without HEAD
    const fresh = path.join(dir, 'fresh');
    fs.mkdirSync(fresh);
    await runGit(fresh, ['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(fresh, 'n.txt'), 'n\n');
    const froot = (await gitStatus(fresh)).root!;
    await gitStage(froot, 'n.txt');
    check((await gitStatus(fresh)).files[0]?.staged, 'stage no-HEAD');
    await gitUnstage(froot, 'n.txt');
    check((await gitStatus(fresh)).files[0]?.state === 'untracked', 'unstage no-HEAD');

    // watcher: a write triggers exactly one debounced callback
    let hits = 0;
    const stop = watchRepo(repo, () => hits++, 100);
    await new Promise((r) => setTimeout(r, 150));
    fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'y\n');
    await new Promise((r) => setTimeout(r, 600));
    stop();
    check(hits === 1, `watch debounce hits=${hits}`);
    console.log('git ok');
  } finally {
    await removeTree(dir);
  }
}

/** Best-effort temp cleanup: git objects are read-only and Windows handles release lazily. */
async function removeTree(dir: string): Promise<void> {
  const makeWritable = (p: string) => {
    try {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const full = path.join(p, e.name);
        if (e.isDirectory()) makeWritable(full);
        else fs.chmodSync(full, 0o666);
      }
    } catch {
      /* ignore */
    }
  };
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      makeWritable(dir);
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  console.warn(`smoke: could not remove temp dir ${dir}`);
}

function loggerChecks(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewdeck-log-'));
  try {
    const logger = new Logger({ maxBytes: 200, maxFiles: 2, echo: false });
    const file = logger.init(dir);
    for (let i = 0; i < 20; i++) logger.info(`line ${i} ${'x'.repeat(40)}`);
    const names = fs.readdirSync(dir).sort();
    check(names.join(',') === 'main.1.log,main.2.log,main.log', `logger rotation files: ${names.join(',')}`);
    check(fs.statSync(file).size <= 200, 'logger active file within maxBytes');
    check(fs.readFileSync(file, 'utf8').includes('line 19'), 'logger latest line in active file');
    const enoent = describeSpawnError('nope.exe', new Error('File not found: nope.exe'));
    check(enoent.includes('executable not found') && enoent.includes('nope.exe'), 'describeSpawnError ENOENT');
    check(describeSpawnError(undefined, new Error('boom')).includes('default shell'), 'describeSpawnError default');
    const manager = new PtyManager(() => {}, () => {});
    check(throws(() => manager.create({ shell: 'crewdeck-missing-shell.exe', cols: 80, rows: 24 })), 'spawn of missing shell throws');
    check(manager.size === 0, 'failed spawn leaves no session');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('logger ok');
}
async function run(): Promise<void> {
  dbChecks();
  loggerChecks();
  scrollbackChecks();
  mentionChecks();
  ansiChecks();
  await gitChecks();

  let output = '';
  let exited: ((code: number) => void) | null = null;
  const exitPromise = new Promise<number>((resolve) => (exited = resolve));

  const manager = new PtyManager(
    (e) => {
      output += e.data;
    },
    (e) => exited?.(e.exitCode),
  );

  const shell = resolveDefaultShell();
  console.log(`shell: ${shell}`);
  const { id, pid } = manager.create({ shell, args: ['-NoLogo', '-NoProfile'], cols: 80, rows: 24 });
  console.log(`spawned pid ${pid}`);

  const waitFor = (pattern: RegExp, label: string) =>
    new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        if (pattern.test(output)) return resolve();
        if (Date.now() - started > TIMEOUT_MS) return reject(new Error(`timed out waiting for ${label}`));
        setTimeout(tick, 50);
      };
      tick();
    });

  // Round-trip: the marker is built by concatenation so the echoed input line alone cannot match.
  manager.write(id, "Write-Output ('CREW' + 'DECK_OK')\r");
  await waitFor(/CREWDECK_OK/, 'echo marker');
  console.log('round-trip ok');

  manager.resize(id, 132, 40);
  output = '';
  manager.write(id, "Write-Output ('SIZE=' + $Host.UI.RawUI.WindowSize.Width + 'x' + $Host.UI.RawUI.WindowSize.Height)\r");
  await waitFor(/SIZE=132x40/, 'resized dimensions');
  console.log('resize ok');

  manager.kill(id);
  const code = await Promise.race([
    exitPromise,
    new Promise<number>((_, reject) => setTimeout(() => reject(new Error('timed out waiting for exit')), TIMEOUT_MS)),
  ]);
  console.log(`exit event ok (code ${code}), live sessions: ${manager.size}`);
  if (manager.size !== 0) fail('session not cleaned up after exit');

  console.log('SMOKE PASS');
  app.exit(0);
}

app.whenReady().then(() => run().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err))));

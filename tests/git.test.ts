import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  gitDiff,
  gitStage,
  gitStatus,
  gitUnstage,
  isRelevantChange,
  parsePorcelain,
  resolveInRepo,
  worktreeAdd,
  worktreeRemove,
  worktreesBase,
} from '../electron/services/git';

const z = (...parts: string[]) => parts.join('\0') + '\0';

test('parsePorcelain: branch with upstream and tracking', () => {
  const r = parsePorcelain(z('## main...origin/main [ahead 1, behind 2]'));
  assert.equal(r.branch, 'main');
  assert.equal(r.upstream, 'origin/main');
  assert.equal(r.ahead, 1);
  assert.equal(r.behind, 2);
  assert.deepEqual(r.files, []);
  assert.equal(r.truncated, false);
});

test('parsePorcelain: branch variants', () => {
  assert.equal(parsePorcelain(z('## feature/x')).branch, 'feature/x');
  assert.equal(parsePorcelain(z('## feature/x')).upstream, null);
  assert.equal(parsePorcelain(z('## No commits yet on main')).branch, 'main');
  assert.equal(parsePorcelain(z('## Initial commit on trunk')).branch, 'trunk');
  assert.equal(parsePorcelain(z('## HEAD (no branch)')).branch, 'HEAD (detached)');
  const gone = parsePorcelain(z('## dev...origin/dev [behind 7]'));
  assert.equal(gone.ahead, 0);
  assert.equal(gone.behind, 7);
});

test('parsePorcelain: file states and staged/unstaged flags', () => {
  const r = parsePorcelain(
    z(
      '## main',
      'M  staged.ts',
      ' M dirty.ts',
      'MM both.ts',
      'A  new.ts',
      ' D gone.ts',
      '?? untracked file.txt',
      'UU conflict.ts',
      'AA both-added.ts',
      'T  link',
      '!! ignored.log',
    ),
  );
  const by = Object.fromEntries(r.files.map((f) => [f.path, f]));
  assert.equal(by['ignored.log'], undefined);
  assert.deepEqual([by['staged.ts'].state, by['staged.ts'].staged, by['staged.ts'].unstaged], ['modified', true, false]);
  assert.deepEqual([by['dirty.ts'].state, by['dirty.ts'].staged, by['dirty.ts'].unstaged], ['modified', false, true]);
  assert.deepEqual([by['both.ts'].staged, by['both.ts'].unstaged], [true, true]);
  assert.equal(by['new.ts'].state, 'added');
  assert.equal(by['gone.ts'].state, 'deleted');
  assert.deepEqual(
    [by['untracked file.txt'].state, by['untracked file.txt'].staged, by['untracked file.txt'].unstaged],
    ['untracked', false, true],
  );
  assert.deepEqual([by['conflict.ts'].state, by['conflict.ts'].staged, by['conflict.ts'].unstaged], ['conflicted', false, true]);
  assert.equal(by['both-added.ts'].state, 'conflicted');
  assert.equal(by['link'].state, 'typechange');
});

test('parsePorcelain: renames consume the next NUL field as oldPath', () => {
  const r = parsePorcelain(z('R  new name.ts', 'old name.ts', 'C  copy.ts', 'src.ts', ' M after.ts'));
  assert.equal(r.files.length, 3);
  assert.deepEqual([r.files[0].path, r.files[0].oldPath, r.files[0].state], ['new name.ts', 'old name.ts', 'renamed']);
  assert.deepEqual([r.files[1].oldPath, r.files[1].state], ['src.ts', 'copied']);
  assert.equal(r.files[2].path, 'after.ts');
  assert.equal('oldPath' in r.files[2], false);
});

test('parsePorcelain: truncates past maxFiles and skips junk', () => {
  const r = parsePorcelain(z(' M a', ' M b', 'xy', ' M c'), 2);
  assert.deepEqual(r.files.map((f) => f.path), ['a', 'b']);
  assert.equal(r.truncated, true);
  assert.deepEqual(parsePorcelain('').files, []);
});

test('resolveInRepo rejects escapes and git internals', () => {
  const root = path.resolve(os.tmpdir(), 'repo');
  assert.equal(resolveInRepo(root, 'src/a.ts'), path.join(root, 'src', 'a.ts'));
  assert.equal(resolveInRepo(root, 'src/../b.ts'), path.join(root, 'b.ts'));
  for (const bad of ['', '..', '../x', 'a/../../x', 'a\0b', '.git/config', '.GIT\\HEAD', 'x'.repeat(4097), path.resolve(root, 'a')]) {
    assert.equal(resolveInRepo(root, bad), null, JSON.stringify(bad.slice(0, 40)));
  }
  assert.equal(resolveInRepo(root, '.'), null);
  assert.ok(resolveInRepo(root, '.github/workflows/ci.yml'));
});

test('isRelevantChange filters noise', () => {
  assert.equal(isRelevantChange(null), true);
  assert.equal(isRelevantChange(''), true);
  assert.equal(isRelevantChange('src/app.ts'), true);
  assert.equal(isRelevantChange('src\\app.ts'), true);
  assert.equal(isRelevantChange('node_modules/x/index.js'), false);
  assert.equal(isRelevantChange('pkg\\dist\\out.js'), false);
  assert.equal(isRelevantChange('.git/index'), true);
  assert.equal(isRelevantChange('.git\\HEAD'), true);
  assert.equal(isRelevantChange('.git/refs/heads/main'), true);
  assert.equal(isRelevantChange('.git/MERGE_HEAD'), true);
  assert.equal(isRelevantChange('.git/index.lock'), false);
  assert.equal(isRelevantChange('.git/objects/ab/cdef'), false);
});

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('gitStatus/gitStage/gitDiff against a real repo', { skip: !hasGit() && 'git not installed' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewdeck-git-'));
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    git('config', 'core.autocrlf', 'false');
    git('config', 'core.fsmonitor', 'false');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    git('add', 'a.txt');
    git('commit', '-q', '-m', 'init');

    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'new\n');

    let s = await gitStatus(dir);
    assert.equal(s.isRepo, true);
    assert.equal(s.branch, 'main');
    const a = s.files.find((f) => f.path === 'a.txt');
    assert.ok(a && a.unstaged && !a.staged);
    assert.equal(s.files.find((f) => f.path === 'b.txt')?.state, 'untracked');

    const d = await gitDiff(s.root!, 'a.txt', 'unstaged');
    assert.match(d.patch, /^\+two$/m);
    const u = await gitDiff(s.root!, 'b.txt', 'untracked');
    assert.match(u.patch, /^\+new$/m);

    await gitStage(s.root!, 'a.txt');
    s = await gitStatus(dir);
    assert.ok(s.files.find((f) => f.path === 'a.txt')?.staged);
    assert.match((await gitDiff(s.root!, 'a.txt', 'staged')).patch, /^\+two$/m);

    await gitUnstage(s.root!, 'a.txt');
    s = await gitStatus(dir);
    assert.equal(s.files.find((f) => f.path === 'a.txt')?.staged, false);

    await assert.rejects(gitDiff(s.root!, '../escape', 'unstaged'), /outside repository/);
    assert.equal((await gitStatus(os.tmpdir())).isRepo, false);
  } finally {
    // Windows: a just-exited git child (or AV scanner) can briefly hold the dir.
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      /* temp dir leak is harmless */
    }
  }
});

test('worktreeAdd/worktreeRemove lifecycle against a real repo', { skip: !hasGit() && 'git not installed' }, async () => {
  // Parent dir holds both the repo and its sibling .crewdeck-worktrees folder, so one rm cleans all.
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'crewdeck-wt-'));
  const dir = path.join(parent, 'proj');
  fs.mkdirSync(dir);
  try {
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@example.com');
    git(dir, 'config', 'user.name', 'T');
    git(dir, 'config', 'core.autocrlf', 'false');
    git(dir, 'config', 'core.fsmonitor', 'false');

    await assert.rejects(worktreeAdd(dir, 'tab1', 'claude'), /no commits yet/);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    git(dir, 'add', 'a.txt');
    git(dir, 'commit', '-q', '-m', 'init');

    await assert.rejects(worktreeAdd(dir, '../evil', 'claude'), /invalid tab or agent id/);
    await assert.rejects(worktreeAdd(dir, 'tab1', 'bad agent'), /invalid tab or agent id/);

    const root = (await gitStatus(dir)).root!;
    const base = worktreesBase(root);

    // Clean worktree: add then remove without force, branch deleted.
    const wt = await worktreeAdd(dir, 'tab1', 'Claude');
    assert.equal(wt.path, path.join(base, 'tab1'));
    assert.match(wt.branch, /^crewdeck\/claude-[0-9a-f]{6}$/);
    assert.ok(fs.existsSync(path.join(wt.path, 'a.txt')));
    assert.equal(git(wt.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), wt.branch);
    await assert.rejects(worktreeAdd(dir, 'tab1', 'claude'), /already exists/);
    assert.deepEqual(await worktreeRemove(dir, wt.path, false), { removed: true });
    assert.equal(fs.existsSync(wt.path), false);
    assert.equal(git(root, 'branch', '--list', wt.branch).trim(), '');

    // Dirty worktree: refused without force, removed with force.
    const dirty = await worktreeAdd(dir, 'tab2', 'codex');
    fs.writeFileSync(path.join(dirty.path, 'scratch.txt'), 'wip\n');
    const refused = await worktreeRemove(dir, dirty.path, false);
    assert.deepEqual(refused, { removed: false, reason: 'worktree has uncommitted changes', needsForce: true });
    assert.ok(fs.existsSync(dirty.path));
    assert.deepEqual(await worktreeRemove(dir, dirty.path, true), { removed: true });
    assert.equal(fs.existsSync(dirty.path), false);
    assert.equal(git(root, 'branch', '--list', dirty.branch).trim(), '');

    // Unmerged commits: refused without force.
    const ahead = await worktreeAdd(dir, 'tab3', 'gemini');
    fs.writeFileSync(path.join(ahead.path, 'b.txt'), 'b\n');
    git(ahead.path, 'add', 'b.txt');
    git(ahead.path, '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '-m', 'work');
    const unmerged = await worktreeRemove(dir, ahead.path, false);
    assert.equal(unmerged.removed, false);
    assert.ok(!unmerged.removed && unmerged.needsForce && /not merged/.test(unmerged.reason));
    assert.deepEqual(await worktreeRemove(dir, ahead.path, true), { removed: true });

    // Folder deleted out from under git: remove prunes instead of failing.
    const gone = await worktreeAdd(dir, 'tab4', 'claude');
    fs.rmSync(gone.path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    assert.deepEqual(await worktreeRemove(dir, gone.path, false), { removed: true });
    assert.doesNotMatch(git(root, 'worktree', 'list', '--porcelain'), /tab4/);

    // Paths outside the crewdeck base are never touched.
    for (const bad of [root, base, path.join(base, '..', 'other', 'x'), path.join(parent, 'elsewhere')]) {
      await assert.rejects(worktreeRemove(dir, bad, true), /not a crewdeck worktree/, bad);
    }
    assert.ok(fs.existsSync(path.join(root, 'a.txt')));
  } finally {
    try {
      fs.rmSync(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      /* temp dir leak is harmless */
    }
  }
});

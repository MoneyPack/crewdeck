import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { GitDiffKind, GitDiffResult, GitFileState, GitFileStatus, GitStatus } from '../../shared/ipc';

/** Max changed files reported per status call. */
export const GIT_MAX_FILES = 5000;
/** Max characters of a single diff returned to the renderer. */
export const GIT_MAX_PATCH_CHARS = 2 * 1024 * 1024;
/** Max bytes read for an untracked file preview. */
const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024;
const MAX_BUFFER = 32 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
export const GIT_WATCH_DEBOUNCE_MS = 400;

// Hardening for untrusted repos: never run fsmonitor hooks, external diff drivers or textconv filters.
const SAFE_CONFIG = ['-c', 'core.fsmonitor=false', '-c', 'core.quotepath=off', '-c', 'color.ui=false'];

export class GitError extends Error {
  constructor(
    message: string,
    readonly code: number | string | null,
    readonly stderr: string,
  ) {
    super(message);
  }
}

interface RunResult {
  stdout: string;
  code: number;
}

/** Runs git; resolves for exit codes in `okCodes`, rejects otherwise. */
export function runGit(
  cwd: string,
  args: string[],
  okCodes: number[] = [0],
  opts: { write?: boolean } = {},
): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
  // Read-only commands must not take index.lock (agents run git concurrently); writes need normal locking.
  if (!opts.write) env.GIT_OPTIONAL_LOCKS = '0';
  else delete env.GIT_OPTIONAL_LOCKS;
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...SAFE_CONFIG, ...args],
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER,
        timeout: TIMEOUT_MS,
        windowsHide: true,
        env,
      },
      (err, stdout, stderr) => {
        if (!err) return resolve({ stdout, code: 0 });
        const code = (err as NodeJS.ErrnoException & { code?: number | string }).code ?? null;
        if (typeof code === 'number' && okCodes.includes(code)) return resolve({ stdout, code });
        const msg = code === 'ENOENT' ? 'git not found on PATH' : (stderr || err.message).trim();
        reject(new GitError(msg, code, stderr));
      },
    );
  });
}

/** Resolves the repository root containing `dir`, or null when `dir` is not inside a work tree. */
export async function repoRoot(dir: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(dir, ['rev-parse', '--show-toplevel']);
    const root = stdout.trim();
    return root ? path.resolve(root) : null;
  } catch (err) {
    if (err instanceof GitError && err.code === 'ENOENT') throw err;
    return null;
  }
}

function stateFor(x: string, y: string): GitFileState {
  if (x === '?' && y === '?') return 'untracked';
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) return 'conflicted';
  const c = x !== ' ' ? x : y;
  switch (c) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'T':
      return 'typechange';
    default:
      return 'modified';
  }
}

export interface ParsedStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
  truncated: boolean;
}

/** Parses `git status --porcelain=v1 -z --branch` output. */
export function parsePorcelain(out: string, maxFiles = GIT_MAX_FILES): ParsedStatus {
  const result: ParsedStatus = { branch: null, upstream: null, ahead: 0, behind: 0, files: [], truncated: false };
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    if (entry.startsWith('## ')) {
      parseBranch(entry.slice(3), result);
      continue;
    }
    if (entry.length < 4) continue;
    const x = entry[0];
    const y = entry[1];
    const file = entry.slice(3);
    let oldPath: string | undefined;
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') oldPath = parts[++i] || undefined;
    if (x === '!' && y === '!') continue;
    if (result.files.length >= maxFiles) {
      result.truncated = true;
      continue;
    }
    const state = stateFor(x, y);
    const untracked = state === 'untracked';
    result.files.push({
      path: file,
      ...(oldPath ? { oldPath } : {}),
      index: x,
      worktree: y,
      state,
      staged: !untracked && state !== 'conflicted' && x !== ' ',
      unstaged: untracked || state === 'conflicted' || y !== ' ',
    });
  }
  return result;
}

function parseBranch(line: string, into: ParsedStatus): void {
  // Forms: "main...origin/main [ahead 1, behind 2]", "No commits yet on main",
  // "Initial commit on main" (old git), "HEAD (no branch)".
  let m = /^(?:No commits yet on|Initial commit on) (.+)$/.exec(line);
  if (m) {
    into.branch = m[1];
    return;
  }
  if (line.startsWith('HEAD (no branch)')) {
    into.branch = 'HEAD (detached)';
    return;
  }
  m = /^(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/.exec(line);
  if (!m) return;
  into.branch = m[1];
  into.upstream = m[2] ?? null;
  const track = m[3] ?? '';
  const ahead = /ahead (\d+)/.exec(track);
  const behind = /behind (\d+)/.exec(track);
  into.ahead = ahead ? Number(ahead[1]) : 0;
  into.behind = behind ? Number(behind[1]) : 0;
}

/** Full status for `dir`. Never throws: non-repos and missing git report `isRepo: false`. */
export async function gitStatus(dir: string): Promise<GitStatus> {
  try {
    if (!fs.existsSync(dir)) return { isRepo: false, files: [], error: 'project folder not found' };
    const root = await repoRoot(dir);
    if (!root) return { isRepo: false, files: [] };
    const { stdout } = await runGit(root, ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all']);
    const parsed = parsePorcelain(stdout);
    return {
      isRepo: true,
      root,
      branch: parsed.branch,
      upstream: parsed.upstream,
      ahead: parsed.ahead,
      behind: parsed.behind,
      files: parsed.files,
      truncated: parsed.truncated,
    };
  } catch (err) {
    return { isRepo: false, files: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** Resolves a repo-relative path, rejecting anything that escapes `root`. */
export function resolveInRepo(root: string, rel: string): string | null {
  if (typeof rel !== 'string' || !rel || rel.length > 4096 || rel.includes('\0')) return null;
  if (path.isAbsolute(rel)) return null;
  const abs = path.resolve(root, rel);
  const back = path.relative(root, abs);
  if (!back || back.startsWith('..') || path.isAbsolute(back)) return null;
  // Never expose git internals.
  if (back.split(/[\\/]/)[0].toLowerCase() === '.git') return null;
  return abs;
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function capPatch(patch: string): { patch: string; truncated: boolean } {
  if (patch.length <= GIT_MAX_PATCH_CHARS) return { patch, truncated: false };
  const cut = patch.lastIndexOf('\n', GIT_MAX_PATCH_CHARS);
  return { patch: patch.slice(0, cut > 0 ? cut + 1 : GIT_MAX_PATCH_CHARS), truncated: true };
}

function isBinaryBuffer(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Builds a new-file patch for an untracked file without spawning `git diff --no-index`. */
function untrackedPatch(abs: string, rel: string): GitDiffResult {
  const st = fs.statSync(abs);
  if (!st.isFile()) return { path: rel, patch: '', binary: false, truncated: false };
  const fd = fs.openSync(abs, 'r');
  let buf: Buffer;
  try {
    const len = Math.min(st.size, MAX_UNTRACKED_BYTES);
    buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (isBinaryBuffer(buf)) return { path: rel, patch: '', binary: true, truncated: false };
  let text = buf.toString('utf8');
  const sizeTruncated = st.size > MAX_UNTRACKED_BYTES;
  if (sizeTruncated) text = text.slice(0, text.lastIndexOf('\n') + 1);
  const noEol = !sizeTruncated && text.length > 0 && !text.endsWith('\n');
  const lines = text.length ? text.replace(/\n$/, '').split('\n') : [];
  const header = `diff --git a/${rel} b/${rel}\nnew file mode 100644\n--- /dev/null\n+++ b/${rel}\n`;
  const body = lines.length
    ? `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n${noEol ? '\\ No newline at end of file\n' : ''}`
    : '';
  const capped = capPatch(header + body);
  return { path: rel, patch: capped.patch, binary: false, truncated: capped.truncated || sizeTruncated };
}

/**
 * Diff for one file. `kind`: 'staged' (index vs HEAD), 'unstaged' (worktree vs index),
 * 'untracked' (whole file as added). `oldPath` includes the rename source for staged renames.
 */
export async function gitDiff(root: string, rel: string, kind: GitDiffKind, oldPath?: string): Promise<GitDiffResult> {
  const abs = resolveInRepo(root, rel);
  if (!abs) throw new GitError('path outside repository', null, '');
  const relPosix = toPosix(path.relative(root, abs));
  if (kind === 'untracked') return untrackedPatch(abs, relPosix);

  const paths = [relPosix];
  if (oldPath) {
    const oldAbs = resolveInRepo(root, oldPath);
    if (oldAbs) paths.push(toPosix(path.relative(root, oldAbs)));
  }
  const args = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M', '--patch'];
  if (kind === 'staged') args.push('--cached');
  args.push('--', ...paths);
  const { stdout } = await runGit(root, args);
  const binary = /^Binary files .* differ$/m.test(stdout) || /^GIT binary patch$/m.test(stdout);
  const capped = capPatch(stdout);
  return { path: relPosix, patch: binary ? '' : capped.patch, binary, truncated: capped.truncated };
}

function repoRel(root: string, rel: string): { abs: string; rel: string } {
  const abs = resolveInRepo(root, rel);
  if (!abs) throw new GitError('path outside repository', null, '');
  return { abs, rel: toPosix(path.relative(root, abs)) };
}

async function hasHead(root: string): Promise<boolean> {
  const { code } = await runGit(root, ['rev-parse', '--verify', '-q', 'HEAD'], [0, 1]);
  return code === 0;
}

/** Stages one path (including deletions). */
export async function gitStage(root: string, rel: string): Promise<void> {
  const p = repoRel(root, rel);
  await runGit(root, ['add', '-A', '--', p.rel], [0], { write: true });
}

/** Unstages one path; works before the first commit too. */
export async function gitUnstage(root: string, rel: string, oldPath?: string): Promise<void> {
  const paths = [repoRel(root, rel).rel];
  if (oldPath) {
    const oldAbs = resolveInRepo(root, oldPath);
    if (oldAbs) paths.push(toPosix(path.relative(root, oldAbs)));
  }
  if (await hasHead(root)) await runGit(root, ['restore', '--staged', '--', ...paths], [0], { write: true });
  else await runGit(root, ['rm', '--cached', '-q', '-r', '--ignore-unmatch', '--', ...paths], [0], { write: true });
}

/** Discards worktree changes for one path. Untracked files are deleted. Irreversible. */
export async function gitDiscard(root: string, rel: string, untracked: boolean): Promise<void> {
  const p = repoRel(root, rel);
  if (untracked) {
    // Re-check git's view so a tracked file is never deleted by a stale renderer.
    const { stdout } = await runGit(root, ['ls-files', '-z', '--', p.rel]);
    if (stdout.length) throw new GitError('file is tracked; refusing to delete', null, '');
    await fs.promises.rm(p.abs, { force: true });
    return;
  }
  await runGit(root, ['restore', '--worktree', '--', p.rel], [0], { write: true });
}

const WORKTREE_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;
export const WORKTREE_BRANCH_PREFIX = 'crewdeck/';

/** Directory holding all crewdeck worktrees for the repo at `root`: `<root>/../.crewdeck-worktrees/<name>`. */
export function worktreesBase(root: string): string {
  return path.join(path.dirname(root), '.crewdeck-worktrees', path.basename(root));
}

/** True when `p` is strictly inside `base` (case-insensitive on Windows). */
function isInside(base: string, p: string): boolean {
  const norm = (s: string) => (process.platform === 'win32' ? path.resolve(s).toLowerCase() : path.resolve(s));
  const rel = path.relative(norm(base), norm(p));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Creates a worktree for one tab on a fresh `crewdeck/<agent>-<shortid>` branch based on HEAD.
 * `dir` is any path inside the repository.
 */
export async function worktreeAdd(
  dir: string,
  tabId: string,
  agentId: string,
): Promise<{ path: string; branch: string }> {
  if (!WORKTREE_SEGMENT.test(tabId) || !WORKTREE_SEGMENT.test(agentId))
    throw new GitError('invalid tab or agent id', null, '');
  const root = await repoRoot(dir);
  if (!root) throw new GitError('not a git repository', null, '');
  if (!(await hasHead(root))) throw new GitError('repository has no commits yet', null, '');
  const target = path.join(worktreesBase(root), tabId);
  if (fs.existsSync(target)) throw new GitError('worktree folder already exists', null, '');
  const short = crypto.randomBytes(3).toString('hex');
  const branch = `${WORKTREE_BRANCH_PREFIX}${agentId.toLowerCase()}-${short}`;
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await runGit(root, ['worktree', 'add', '-b', branch, target, 'HEAD'], [0], { write: true });
  return { path: target, branch };
}

export type WorktreeRemoveOutcome = { removed: true } | { removed: false; reason: string; needsForce: boolean };

/**
 * Removes a crewdeck worktree and deletes its `crewdeck/*` branch. Without `force`, refuses when the
 * worktree has uncommitted changes or its branch is not merged into the main checkout's HEAD.
 */
export async function worktreeRemove(
  dir: string,
  worktreePath: string,
  force: boolean,
): Promise<WorktreeRemoveOutcome> {
  const root = await repoRoot(dir);
  if (!root) throw new GitError('not a git repository', null, '');
  const base = worktreesBase(root);
  if (typeof worktreePath !== 'string' || !isInside(base, worktreePath))
    throw new GitError('not a crewdeck worktree', null, '');
  const target = path.resolve(worktreePath);

  let branch: string | null = null;
  if (fs.existsSync(target)) {
    const head = await runGit(target, ['rev-parse', '--abbrev-ref', 'HEAD'], [0, 128]);
    const name = head.code === 0 ? head.stdout.trim() : '';
    if (name.startsWith(WORKTREE_BRANCH_PREFIX)) branch = name;
    if (!force) {
      const { stdout } = await runGit(target, ['status', '--porcelain=v1', '--untracked-files=normal']);
      if (stdout.trim()) return { removed: false, reason: 'worktree has uncommitted changes', needsForce: true };
      if (branch) {
        const merged = await runGit(root, ['merge-base', '--is-ancestor', branch, 'HEAD'], [0, 1]);
        if (merged.code !== 0) return { removed: false, reason: `branch ${branch} is not merged`, needsForce: true };
      }
    }
    const args = ['worktree', 'remove'];
    if (force) args.push('--force', '--force');
    args.push(target);
    await runGit(root, args, [0], { write: true });
  } else {
    await runGit(root, ['worktree', 'prune'], [0], { write: true });
  }
  if (branch) await runGit(root, ['branch', '-D', branch], [0, 1], { write: true });
  return { removed: true };
}

const WATCH_IGNORE_SEGMENTS = new Set(['node_modules', '.venv', '__pycache__', '.next', 'dist', 'target']);

/** True when an fs.watch filename (relative to the watched root) should trigger a status refresh. */
export function isRelevantChange(filename: string | null): boolean {
  if (!filename) return true; // platform omitted it: be safe
  const parts = filename.split(/[\\/]/).filter(Boolean);
  if (!parts.length) return true;
  if (parts[0] === '.git') {
    const rest = parts.slice(1).join('/');
    if (rest.endsWith('.lock')) return false;
    return rest === 'HEAD' || rest === 'index' || rest.startsWith('refs/') || rest === 'MERGE_HEAD';
  }
  return !parts.some((p) => WATCH_IGNORE_SEGMENTS.has(p));
}

/**
 * Debounced recursive watcher. Calls `onChange` at most once per `debounceMs` burst.
 * Returns a disposer. Falls back to a no-op if the platform can't watch recursively.
 */
export function watchRepo(dir: string, onChange: () => void, debounceMs = GIT_WATCH_DEBOUNCE_MS): () => void {
  let timer: NodeJS.Timeout | null = null;
  let closed = false;
  let watcher: fs.FSWatcher | null = null;
  const fire = () => {
    if (closed || timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (!closed) onChange();
    }, debounceMs);
  };
  try {
    watcher = fs.watch(dir, { recursive: true, persistent: false }, (_event, filename) => {
      if (isRelevantChange(filename == null ? null : String(filename))) fire();
    });
    watcher.on('error', () => {
      /* folder removed etc.; renderer still refreshes on demand */
    });
  } catch {
    watcher = null;
  }
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    timer = null;
    watcher?.close();
  };
}

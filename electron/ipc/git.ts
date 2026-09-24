import { ipcMain, type WebContents } from 'electron';
import {
  GitChannels,
  type GitActionResult,
  type GitChangedEvent,
  type GitDiffKind,
  type GitDiffResult,
  type GitStatus,
} from '../../shared/ipc';
import { getDatabase } from '../services/db';
import { gitDiff, gitDiscard, gitStage, gitStatus, gitUnstage, repoRoot, watchRepo } from '../services/git';

const DIFF_KINDS: ReadonlySet<string> = new Set<GitDiffKind>(['staged', 'unstaged', 'untracked']);

function isId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 128;
}

function isRelPath(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 4096;
}

/** Project folder by id. The renderer never supplies raw filesystem paths. */
function projectPath(projectId: unknown): string | null {
  if (!isId(projectId)) return null;
  try {
    return getDatabase().getProject(projectId)?.path ?? null;
  } catch {
    return null;
  }
}

/** One FS watch per (webContents, project), ref-counted so independent renderer consumers can share it. */
interface WatchEntry {
  dispose: () => void;
  refs: number;
}

/** webContents id -> (projectId -> watch). */
const watchers = new Map<number, Map<string, WatchEntry>>();

function watchersFor(wc: WebContents): Map<string, WatchEntry> {
  let map = watchers.get(wc.id);
  if (!map) {
    map = new Map();
    watchers.set(wc.id, map);
    const id = wc.id;
    wc.once('destroyed', () => {
      for (const w of watchers.get(id)?.values() ?? []) w.dispose();
      watchers.delete(id);
    });
  }
  return map;
}

export function disposeAllGitWatchers(): void {
  for (const map of watchers.values()) for (const w of map.values()) w.dispose();
  watchers.clear();
}

export function registerGitIpc(): void {
  ipcMain.handle(GitChannels.status, async (_e, projectId: unknown): Promise<GitStatus> => {
    const dir = projectPath(projectId);
    if (!dir) return { isRepo: false, files: [], error: 'unknown project' };
    return gitStatus(dir);
  });

  ipcMain.handle(
    GitChannels.diff,
    async (_e, projectId: unknown, rel: unknown, kind: unknown, oldPath: unknown): Promise<GitDiffResult | null> => {
      const dir = projectPath(projectId);
      if (!dir || !isRelPath(rel) || typeof kind !== 'string' || !DIFF_KINDS.has(kind)) return null;
      if (oldPath !== undefined && oldPath !== null && !isRelPath(oldPath)) return null;
      try {
        const root = await repoRoot(dir);
        if (!root) return null;
        return await gitDiff(root, rel, kind as GitDiffKind, (oldPath as string | null) ?? undefined);
      } catch {
        return null;
      }
    },
  );

  ipcMain.handle(GitChannels.watch, (e, projectId: unknown): boolean => {
    const dir = projectPath(projectId);
    if (!dir || !isId(projectId)) return false;
    const map = watchersFor(e.sender);
    const existing = map.get(projectId);
    if (existing) {
      existing.refs++;
      return true;
    }
    const sender = e.sender;
    const event: GitChangedEvent = { projectId };
    const dispose = watchRepo(dir, () => {
      if (!sender.isDestroyed()) sender.send(GitChannels.changed, event);
    });
    map.set(projectId, { dispose, refs: 1 });
    return true;
  });

  ipcMain.handle(GitChannels.unwatch, (e, projectId: unknown): void => {
    if (!isId(projectId)) return;
    const map = watchers.get(e.sender.id);
    const entry = map?.get(projectId);
    if (entry && --entry.refs <= 0) {
      entry.dispose();
      map!.delete(projectId);
    }
  });

  const action = async (projectId: unknown, rel: unknown, fn: (root: string, rel: string) => Promise<void>): Promise<GitActionResult> => {
    const dir = projectPath(projectId);
    if (!dir) return { ok: false, error: 'unknown project' };
    if (!isRelPath(rel)) return { ok: false, error: 'invalid path' };
    try {
      const root = await repoRoot(dir);
      if (!root) return { ok: false, error: 'not a git repository' };
      await fn(root, rel);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  ipcMain.handle(GitChannels.stage, (_e, projectId: unknown, rel: unknown) =>
    action(projectId, rel, (root, p) => gitStage(root, p)),
  );

  ipcMain.handle(GitChannels.unstage, (_e, projectId: unknown, rel: unknown, oldPath: unknown) => {
    if (oldPath !== undefined && oldPath !== null && !isRelPath(oldPath)) return { ok: false, error: 'invalid path' };
    return action(projectId, rel, (root, p) => gitUnstage(root, p, (oldPath as string | null) ?? undefined));
  });

  ipcMain.handle(GitChannels.discard, (_e, projectId: unknown, rel: unknown, untracked: unknown) => {
    if (typeof untracked !== 'boolean') return { ok: false, error: 'invalid request' };
    return action(projectId, rel, (root, p) => gitDiscard(root, p, untracked));
  });
}

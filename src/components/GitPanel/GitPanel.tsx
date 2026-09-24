import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DiffViewer, type DiffMode } from './DiffViewer';
import type { GitActionResult, GitDiffKind, GitDiffResult, GitFileState, GitFileStatus, GitStatus } from '../../../shared/ipc';

type Section = 'staged' | 'unstaged';

interface Selection {
  section: Section;
  path: string;
}

interface Props {
  /** Current project id, or null when no project is open. */
  projectId: string | null;
  onClose: () => void;
  /** Best-effort guesses of which terminal changed each path (keyed by repo-relative path). */
  attributions?: Record<string, FileAttribution>;
}

export interface FileAttribution {
  name: string;
  reason: string;
}

const STATE_BADGE: Record<GitFileState, { letter: string; label: string }> = {
  untracked: { letter: 'U', label: 'Untracked' },
  conflicted: { letter: '!', label: 'Conflicted' },
  added: { letter: 'A', label: 'Added' },
  deleted: { letter: 'D', label: 'Deleted' },
  renamed: { letter: 'R', label: 'Renamed' },
  copied: { letter: 'C', label: 'Copied' },
  typechange: { letter: 'T', label: 'Type changed' },
  modified: { letter: 'M', label: 'Modified' },
};

/** Letter shown for a file in a given section (the porcelain column that applies to it). */
function badgeFor(f: GitFileStatus, section: Section): { letter: string; label: string; cls: string } {
  if (f.state === 'untracked' || f.state === 'conflicted') {
    const b = STATE_BADGE[f.state];
    return { ...b, cls: f.state };
  }
  const col = section === 'staged' ? f.index : f.worktree;
  const byCol: Record<string, GitFileState> = { A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'typechange', M: 'modified' };
  const state = byCol[col] ?? f.state;
  return { ...STATE_BADGE[state], cls: state };
}

function diffKind(f: GitFileStatus, section: Section): GitDiffKind {
  if (section === 'staged') return 'staged';
  return f.state === 'untracked' ? 'untracked' : 'unstaged';
}

function splitPath(p: string): { dir: string; name: string } {
  const i = p.lastIndexOf('/');
  return i < 0 ? { dir: '', name: p } : { dir: p.slice(0, i + 1), name: p.slice(i + 1) };
}

/** Git status + diff side panel for the current project. Owns its own watch subscription. */
export function GitPanel({ projectId, onClose, attributions }: Props) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [diff, setDiff] = useState<GitDiffResult | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [mode, setMode] = useState<DiffMode>('unified');
  // Monotonic tokens drop responses that were superseded while in flight.
  const statusToken = useRef(0);
  const diffToken = useRef(0);

  const refresh = useCallback(() => {
    if (!projectId) return;
    const token = ++statusToken.current;
    setLoading(true);
    window.crewdeck.git
      .status(projectId)
      .then((s) => {
        if (token === statusToken.current) setStatus(s);
      })
      .catch((err: unknown) => {
        if (token === statusToken.current) setStatus({ isRepo: false, files: [], error: String(err) });
      })
      .finally(() => {
        if (token === statusToken.current) setLoading(false);
      });
  }, [projectId]);

  const runAction = useCallback(
    async (fn: () => Promise<GitActionResult>) => {
      if (!projectId) return;
      setBusy(true);
      setActionError(null);
      try {
        const r = await fn();
        if (!r.ok) setActionError(r.error ?? 'Git action failed.');
      } catch (err) {
        setActionError(String(err));
      } finally {
        setBusy(false);
        refresh();
      }
    },
    [projectId, refresh],
  );

  const discard = useCallback(
    async (f: GitFileStatus) => {
      if (!projectId) return;
      const untracked = f.state === 'untracked';
      const msg = untracked
        ? `Delete untracked file "${f.path}"?\n\nThis permanently removes it from disk and cannot be undone.`
        : `Discard unstaged changes to "${f.path}"?\n\nThis cannot be undone.`;
      if (!window.confirm(msg)) return;
      await runAction(() => window.crewdeck.git.discard(projectId, f.path, untracked));
    },
    [projectId, runAction],
  );

  // Reset, load, and watch whenever the project changes; stop watching when closed.
  useEffect(() => {
    setStatus(null);
    setSelected(null);
    setDiff(null);
    setDiffError(null);
    if (!projectId) return;
    refresh();
    void window.crewdeck.git.watch(projectId).catch(() => false);
    const off = window.crewdeck.git.onChanged((e) => {
      if (e.projectId === projectId) refresh();
    });
    return () => {
      off();
      statusToken.current++;
      void window.crewdeck.git.unwatch(projectId).catch(() => undefined);
    };
  }, [projectId, refresh]);

  const { staged, unstaged } = useMemo(() => {
    const files = status?.files ?? [];
    return { staged: files.filter((f) => f.staged), unstaged: files.filter((f) => f.unstaged) };
  }, [status]);

  const selectedFile = useMemo(() => {
    if (!selected) return null;
    const list = selected.section === 'staged' ? staged : unstaged;
    return list.find((f) => f.path === selected.path) ?? null;
  }, [selected, staged, unstaged]);

  // (Re)load the diff when the selection changes or the status refreshes (file contents may differ).
  useEffect(() => {
    const token = ++diffToken.current;
    if (!projectId || !selected || !selectedFile) {
      setDiff(null);
      setDiffLoading(false);
      setDiffError(null);
      return;
    }
    const kind = diffKind(selectedFile, selected.section);
    const oldPath = kind === 'staged' ? selectedFile.oldPath : undefined;
    setDiffLoading(true);
    window.crewdeck.git
      .diff(projectId, selectedFile.path, kind, oldPath)
      .then((d) => {
        if (token !== diffToken.current) return;
        setDiff(d);
        setDiffError(d ? null : 'Could not load diff.');
      })
      .catch((err: unknown) => {
        if (token === diffToken.current) setDiffError(`Diff failed: ${String(err)}`);
      })
      .finally(() => {
        if (token === diffToken.current) setDiffLoading(false);
      });
  }, [projectId, selected, selectedFile]);

  // Drop a selection whose file disappeared (e.g. committed or reverted).
  useEffect(() => {
    if (selected && status && !selectedFile) setSelected(null);
  }, [selected, status, selectedFile]);

  const isOpen = !!selectedFile;
  const total = status?.files.length ?? 0;

  const renderSection = (section: Section, files: GitFileStatus[]) => {
    if (!files.length) return null;
    return (
      <section className="git-section">
        <h4>
          {section === 'staged' ? 'Staged' : 'Changes'} <span className="count">{files.length}</span>
        </h4>
        <ul>
          {files.map((f) => {
            const b = badgeFor(f, section);
            const { dir, name } = splitPath(f.path);
            const active = selected?.section === section && selected.path === f.path;
            const attr = attributions?.[f.path];
            return (
              <li key={`${section}:${f.path}`} className="git-file-row">
                <button
                  type="button"
                  className={active ? 'git-file selected' : 'git-file'}
                  title={`${f.oldPath ? `${f.oldPath} → ` : ''}${f.path}\n${b.label}`}
                  aria-pressed={active}
                  onClick={() => setSelected(active ? null : { section, path: f.path })}
                >
                  <span className="git-file-name">{name}</span>
                  <span className="git-file-dir">{dir}</span>
                  {attr && (
                    <span className="git-attr" title={`${attr.reason} (heuristic, may be wrong)`}>
                      @{attr.name}?
                    </span>
                  )}
                  <span className={`git-badge ${b.cls}`}>{b.letter}</span>
                </button>
                <span className="git-actions">
                  {section === 'unstaged' && f.state !== 'conflicted' && (
                    <button type="button" title="Discard changes" disabled={busy} onClick={() => void discard(f)}>
                      ↶
                    </button>
                  )}
                  {section === 'unstaged' ? (
                    <button type="button" title="Stage" disabled={busy} onClick={() => void runAction(() => window.crewdeck.git.stage(projectId!, f.path))}>
                      +
                    </button>
                  ) : (
                    <button
                      type="button"
                      title="Unstage"
                      disabled={busy}
                      onClick={() => void runAction(() => window.crewdeck.git.unstage(projectId!, f.path, f.oldPath))}
                    >
                      −
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      </section>
    );
  };

  let body: ReactNode;
  if (!projectId) body = <div className="git-empty">Open a project to see its git status.</div>;
  else if (!status) body = <div className="git-empty">Loading status…</div>;
  else if (status.error) body = <div className="git-empty error">{status.error}</div>;
  else if (!status.isRepo) body = <div className="git-empty">This project is not a git repository.</div>;
  else if (!total) body = <div className="git-empty">Working tree clean.</div>;
  else
    body = (
      <>
        {status.truncated && <div className="git-warning">Showing the first {total} files only.</div>}
        {actionError && (
          <div className="git-warning error" role="alert">
            {actionError}
            <button type="button" title="Dismiss" aria-label="Dismiss" onClick={() => setActionError(null)}>
              <i className="ri-close-line" aria-hidden="true" />
            </button>
          </div>
        )}
        {renderSection('staged', staged)}
        {renderSection('unstaged', unstaged)}
      </>
    );

  const tracking =
    status?.isRepo && status.upstream
      ? `${status.ahead ? `↑${status.ahead}` : ''}${status.behind ? ` ↓${status.behind}` : ''}`.trim()
      : '';

  return (
    <aside className={isOpen ? 'git-panel open' : 'git-panel'} aria-label="Git changes">
      <div className="git-panel-header">
        <span className="git-title">Git</span>
        {status?.isRepo && (
          <span className="git-branch" title={status.upstream ? `Tracking ${status.upstream}` : 'No upstream'}>
            <i className="ri-git-branch-line" aria-hidden="true" /> {status.branch ?? '(detached)'}
            {tracking && <span className="git-tracking"> {tracking}</span>}
          </span>
        )}
        {total > 0 && <span className="count">{total}</span>}
        <span className="spacer" />
        {isOpen && (
          <div className="diff-mode" role="group" aria-label="Diff layout">
            <button type="button" className={mode === 'unified' ? 'selected' : undefined} onClick={() => setMode('unified')}>
              Unified
            </button>
            <button type="button" className={mode === 'split' ? 'selected' : undefined} onClick={() => setMode('split')}>
              Split
            </button>
          </div>
        )}
        <button type="button" title="Refresh" aria-label="Refresh" disabled={!projectId || loading} onClick={refresh}>
          <i className="ri-refresh-line" aria-hidden="true" />
        </button>
        <button type="button" title="Close git panel" aria-label="Close git panel" onClick={onClose}>
          <i className="ri-close-line" aria-hidden="true" />
        </button>
      </div>
      <div className="git-panel-body">
        <div className="git-files">{body}</div>
        {isOpen && (
          <div className="git-diff">
            <div className="git-diff-path" title={selectedFile.path}>
              {selectedFile.oldPath && selected?.section === 'staged' ? `${selectedFile.oldPath} → ` : ''}
              {selectedFile.path}
              <span className="muted"> · {selected?.section === 'staged' ? 'staged' : selectedFile.state === 'untracked' ? 'untracked' : 'unstaged'}</span>
            </div>
            <DiffViewer diff={diff} loading={diffLoading} error={diffError} mode={mode} />
          </div>
        )}
      </div>
    </aside>
  );
}

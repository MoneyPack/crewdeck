import { useEffect, useState } from 'react';
import type { WorktreeDiffResult, WorktreeInfo } from '../../../shared/ipc';
import { splitPatch } from '../../../shared/reader';
import { DiffViewer } from '../GitPanel/DiffViewer';

export interface Racer {
  id: string;
  title: string;
  agent: string;
  worktree: WorktreeInfo;
  activity: string;
}

interface Props {
  projectId: string;
  task: string;
  racers: Racer[];
  onKeep: (racer: Racer) => Promise<string | void>;
  onDrop: (racer: Racer) => void;
  onClose: () => void;
}

/** Diff Race: the same task ran in N isolated worktrees; compare and keep one. */
export function RacePanel({ projectId, task, racers, onKeep, onDrop, onClose }: Props) {
  const [sel, setSel] = useState<string | null>(racers[0]?.id ?? null);
  const [diffs, setDiffs] = useState<Record<string, WorktreeDiffResult | { error: string }>>({});
  const [file, setFile] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = (r: Racer) =>
    window.crewdeck.git.worktreeDiff(projectId, r.worktree.path).then((d) => setDiffs((p) => ({ ...p, [r.id]: d })));

  useEffect(() => {
    racers.forEach((r) => void load(r));
    const t = window.setInterval(() => racers.forEach((r) => void load(r)), 5000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, racers.map((r) => r.id).join(',')]);

  useEffect(() => setFile(0), [sel]);

  const current = racers.find((r) => r.id === sel) ?? null;
  const cd = current ? diffs[current.id] : undefined;
  const files = cd && !('error' in cd) ? splitPatch(cd.patch) : [];

  return (
    <aside className="race" role="dialog" aria-label="Diff race">
      <header className="race-head">
        <span className="race-kicker">Diff race</span>
        <span className="race-task" title={task}>
          {task}
        </span>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close race view">
          <i className="ri-close-line" aria-hidden="true" />
        </button>
      </header>
      <div className="race-lanes">
        {racers.map((r) => {
          const d = diffs[r.id];
          const stat = d && !('error' in d) ? d : null;
          return (
            <button
              key={r.id}
              type="button"
              data-agent={r.agent}
              className={r.id === sel ? 'race-lane selected' : 'race-lane'}
              onClick={() => setSel(r.id)}
            >
              <span className="race-lane-title">{r.title}</span>
              <span className={`activity activity--${r.activity}`}>
                <i aria-hidden="true" />
                {r.activity === 'waiting' ? 'needs you' : r.activity}
              </span>
              <span className="race-stat">
                {stat ? (
                  <>
                    {stat.files} files <b className="add">+{stat.insertions}</b>{' '}
                    <b className="del">−{stat.deletions}</b>
                  </>
                ) : d && 'error' in d ? (
                  <span className="muted">{d.error}</span>
                ) : (
                  <span className="muted">reading…</span>
                )}
              </span>
            </button>
          );
        })}
      </div>
      {current && (
        <div className="race-body">
          <div className="race-files">
            {files.length === 0 && <span className="muted">No changes yet</span>}
            {files.map((f, i) => (
              <button key={f.path} type="button" className={i === file ? 'selected' : ''} onClick={() => setFile(i)}>
                {f.path}
              </button>
            ))}
          </div>
          <div className="race-diff">
            <DiffViewer
              diff={files[file] ?? null}
              loading={!cd}
              error={cd && 'error' in cd ? cd.error : null}
              mode="unified"
            />
          </div>
          <div className="race-actions">
            {note && <span className="race-note">{note}</span>}
            <button
              type="button"
              className="btn-pop"
              disabled={busy !== null || files.length === 0}
              onClick={async () => {
                setBusy(current.id);
                setNote(null);
                const err = await onKeep(current);
                setBusy(null);
                setNote(err ? err : `merged ${current.worktree.branch} into main checkout`);
              }}
            >
              {busy === current.id ? 'Merging…' : `Keep ${current.title}`}
            </button>
            <button type="button" disabled={busy !== null} onClick={() => onDrop(current)}>
              Drop {current.title}
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}

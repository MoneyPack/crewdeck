import { useState } from 'react';
import type { AgentId, AgentProfile } from '../../../shared/agents';

interface Props {
  profiles: AgentProfile[];
  installed: (id: AgentId) => boolean;
  onStart: (agents: AgentId[], task: string) => Promise<string | void>;
  onClose: () => void;
}

/** Pick 2–4 agents and a task; each runs in its own worktree. */
export function RaceDialog({ profiles, installed, onStart, onClose }: Props) {
  const ready = profiles.filter((p) => p.id !== 'shell' && installed(p.id));
  const [picked, setPicked] = useState<AgentId[]>(ready.slice(0, 2).map((p) => p.id));
  const [task, setTask] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toggle = (id: AgentId) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length < 4 ? [...p, id] : p));

  return (
    <div className="settings-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="race-dialog" role="dialog" aria-modal="true" aria-label="Start a diff race">
        <h2>
          Diff race <span className="muted">same task · isolated worktrees · you pick the winner</span>
        </h2>
        <div className="race-pick">
          {ready.length < 2 && <p className="muted">Install at least two agents to race.</p>}
          {ready.map((p) => (
            <label key={p.id} data-agent={p.id} className={picked.includes(p.id) ? 'on' : ''}>
              <input type="checkbox" checked={picked.includes(p.id)} onChange={() => toggle(p.id)} />
              {p.name}
            </label>
          ))}
        </div>
        <textarea
          rows={4}
          autoFocus
          value={task}
          placeholder="Describe the task once. Every racer gets the exact same prompt."
          onChange={(e) => setTask(e.target.value)}
        />
        {err && <div className="settings-error">{err}</div>}
        <div className="race-dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-pop"
            disabled={busy || picked.length < 2 || !task.trim()}
            onClick={async () => {
              setBusy(true);
              const e = await onStart(picked, task.trim());
              setBusy(false);
              if (e) setErr(e);
              else onClose();
            }}
          >
            {busy ? 'Starting…' : `Race ${picked.length} agents`}
          </button>
        </div>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { TerminalPane } from './components/Terminal/TerminalPane';
import { Composer } from './components/Composer/Composer';
import { RoutingLog } from './components/RoutingLog/RoutingLog';
import { GitPanel } from './components/GitPanel/GitPanel';
import { useGitAttribution, type LastRoute } from './hooks/useGitAttribution';
import { mentionHandles, type MentionTarget } from '../shared/mention';
import { INLINE_FORWARD_LIMIT, stripAnsi, utf8Length } from '../shared/ansi';
import { AGENT_PROFILES, getProfile, type AgentDetection, type AgentId } from '../shared/agents';
import type {
  PersistedLayout,
  PersistedTerminal,
  ProjectInfo,
  RestoreResult,
  RouteLogEntry,
  RouteLogInput,
  WorktreeInfo,
} from '../shared/ipc';

/** A terminal session. Spawn parameters are fixed at creation time. */
interface TermSpec {
  id: string;
  title: string;
  profileId: AgentId;
  shell?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Human-readable resume command recorded in session metadata (restored agents only). */
  resumeCommand?: string;
  /** Isolated git worktree this tab runs in (opt-in at creation). */
  worktree?: WorktreeInfo;
}

type LayoutSize = 1 | 2 | 4;
const LAYOUTS: readonly LayoutSize[] = [1, 2, 4];
const SLOT_COUNT = 4;

const SAVE_DEBOUNCE_MS = 500;

/** Grid placement for slot `i` within a layout (2 columns max, row-major). */
function slotGrid(layout: LayoutSize): { cols: number; rows: number } {
  return layout === 1 ? { cols: 1, rows: 1 } : layout === 2 ? { cols: 2, rows: 1 } : { cols: 2, rows: 2 };
}

/** Builds spawn parameters for a terminal from its profile and the detected launch command. */
function buildSpec(
  id: string,
  title: string,
  profileId: AgentId,
  cwd: string | undefined,
  detections: AgentDetection[],
  restored = false,
): TermSpec {
  const profile = getProfile(profileId);
  const launch = detections.find((d) => d.id === profileId)?.launch;
  // Resume args only apply when the agent itself is launched (not the shell fallback).
  const resume = restored && launch && profile.resumeArgs?.length ? profile.resumeArgs : null;
  return {
    id,
    title,
    profileId,
    // An agent that is no longer installed falls back to the default shell in its cwd.
    shell: launch?.shell,
    args: launch ? [...launch.args, ...(resume ?? [])] : undefined,
    env: Object.keys(profile.env).length ? profile.env : undefined,
    cwd,
    resumeCommand: resume ? [profile.command, ...resume].join(' ') : undefined,
  };
}

function toPersisted(terminals: TermSpec[], projectPath: string): PersistedTerminal[] {
  return terminals.map((t) => ({
    id: t.id,
    title: t.title,
    profileId: t.profileId,
    cwd: t.cwd ?? projectPath,
    ...(t.worktree ? { worktree: t.worktree } : {}),
  }));
}

/** Delay between pasting text and pressing Enter; agent TUIs treat a same-chunk \r as pasted text. */
const SUBMIT_DELAY_MS = 40;

/** Types `message` into a PTY and submits it. Multi-line text goes in as a bracketed paste. */
function submitToPty(ptyId: string, message: string) {
  const api = window.crewdeck.terminal;
  const body = message.includes('\n') ? `\x1b[200~${message.replace(/\r?\n/g, '\r')}\x1b[201~` : message;
  api.write(ptyId, body);
  setTimeout(() => api.write(ptyId, '\r'), SUBMIT_DELAY_MS);
}

function normalizeSlots(slots: (string | null)[]): (string | null)[] {
  return Array.from({ length: SLOT_COUNT }, (_, i) => slots[i] ?? null);
}

export function App() {
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [terminals, setTerminals] = useState<TermSpec[]>([]);
  const [layout, setLayout] = useState<LayoutSize>(1);
  // slots[i] = terminal id shown in slot i (only the first `layout` slots are visible).
  const [slots, setSlots] = useState<(string | null)[]>(() => Array(SLOT_COUNT).fill(null));
  const [activeSlot, setActiveSlot] = useState(0);
  const [detections, setDetections] = useState<AgentDetection[] | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  // Saves are suppressed until the last session has been restored (or restore found nothing).
  const [ready, setReady] = useState(false);
  const restoreStarted = useRef(false);
  // Pending debounced saves, flushed immediately on window unload.
  const pendingSaves = useRef(new Map<string, () => void>());
  // Terminal id → live PTY id (absent while a pane's process is not running).
  const ptyIds = useRef(new Map<string, string>());

  const [routeLog, setRouteLog] = useState<RouteLogEntry[]>([]);
  const [showLog, setShowLog] = useState(false);
  const [showGit, setShowGit] = useState(false);
  // Opt-in: new tabs get their own git worktree + branch instead of the shared project folder.
  const [isolateNext, setIsolateNext] = useState(false);
  const [worktreeError, setWorktreeError] = useState<string | null>(null);
  // Last single-target route, for CD-20 change attribution.
  const lastRoute = useRef<LastRoute | null>(null);
  // Read inside stable callbacks so routing doesn't need to be re-created per project.
  const projectIdRef = useRef<string | null>(null);
  projectIdRef.current = project?.id ?? null;

  // Load the persisted routing log whenever the project changes.
  const projectId = project?.id ?? null;
  useEffect(() => {
    setRouteLog([]);
    if (!projectId) return;
    let cancelled = false;
    window.crewdeck.routing
      .list(projectId)
      .then((entries) => {
        if (!cancelled) setRouteLog(entries);
      })
      .catch((err: unknown) => console.error('routing log load failed', err));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  /** Records a routed message; best-effort (routing already happened), no-op without a project. */
  const recordRoute = useCallback((input: RouteLogInput) => {
    const id = projectIdRef.current;
    if (!id) return;
    window.crewdeck.routing
      .log(id, input)
      .then((entry) => {
        // Drop the result if the user switched projects while the write was in flight.
        if (entry && projectIdRef.current === entry.projectId) setRouteLog((prev) => [entry, ...prev]);
      })
      .catch((err: unknown) => console.error('routing log write failed', err));
  }, []);

  const mentionTerminals = useMemo(() => terminals.map(({ id, title }) => ({ id, title })), [terminals]);

  const routeMessage = useCallback(
    (targets: MentionTarget[], message: string): string | void => {
      const idle = targets.filter((t) => !ptyIds.current.has(t.id));
      if (idle.length) return `${idle.map((t) => `@${t.handle}`).join(', ')} ${idle.length > 1 ? 'are' : 'is'} not running`;
      for (const t of targets) submitToPty(ptyIds.current.get(t.id)!, message);
      // Attribution only credits unambiguous single-target routes.
      lastRoute.current = targets.length === 1 ? { terminalId: targets[0].id, at: Date.now() } : null;
      recordRoute({
        kind: 'composer',
        fromLabel: 'you',
        targets: targets.map((t) => t.handle),
        preview: stripAnsi(message),
        bytes: utf8Length(message),
      });
    },
    [recordRoute],
  );

  const mentionTargets = useMemo(() => mentionHandles(mentionTerminals), [mentionTerminals]);

  /** Forwards selected terminal output to another agent; large payloads go through a temp file. */
  const forwardSelection = useCallback(
    async (fromTitle: string, target: MentionTarget, text: string): Promise<string | void> => {
      const ptyId = ptyIds.current.get(target.id);
      if (!ptyId) return `@${target.handle} is not running`;
      const clean = stripAnsi(text).trim();
      if (!clean) return 'selection is empty';
      const bytes = utf8Length(clean);
      lastRoute.current = { terminalId: target.id, at: Date.now() };
      const log = (viaFile: boolean) =>
        recordRoute({ kind: 'forward', fromLabel: fromTitle, targets: [target.handle], preview: clean, bytes, viaFile });
      if (bytes <= INLINE_FORWARD_LIMIT) {
        submitToPty(ptyId, clean);
        log(false);
        return;
      }
      try {
        const path = await window.crewdeck.routing.writeTemp(clean);
        submitToPty(ptyId, `Read the output from "${fromTitle}" saved in ${path}`);
        log(true);
      } catch (err) {
        return `forward failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    [recordRoute],
  );

  const refreshAgents = useCallback((refresh: boolean) => {
    window.crewdeck.agents
      .detect(refresh)
      .then(setDetections)
      .catch(() => setDetections([]));
  }, []);

  useEffect(() => refreshAgents(false), [refreshAgents]);

  /** Replaces all state with a restored project snapshot. */
  const applyRestore = useCallback((r: RestoreResult, dets: AgentDetection[]) => {
    const specs = r.terminals.map((t) => {
      const spec = buildSpec(t.id, t.title, t.profileId, t.cwd, dets, true);
      return t.worktree ? { ...spec, worktree: t.worktree } : spec;
    });
    setProject(r.project);
    setTerminals(specs);
    const saved: PersistedLayout = r.layout ?? { layout: 1, slots: [], activeSlot: 0 };
    const nextSlots = normalizeSlots(saved.slots);
    // No saved layout (or it was emptied): show the first terminals in the visible slots.
    if (!nextSlots.slice(0, saved.layout).some(Boolean)) {
      specs.slice(0, saved.layout).forEach((t, i) => (nextSlots[i] = t.id));
    }
    setLayout(saved.layout);
    setSlots(nextSlots);
    setActiveSlot(saved.activeSlot < saved.layout ? saved.activeSlot : 0);
  }, []);

  // Restore the last project once agent detection is known (needed to rebuild launch commands).
  useEffect(() => {
    if (!detections || restoreStarted.current) return;
    restoreStarted.current = true;
    const dets = detections;
    window.crewdeck.project
      .restore()
      .then((r) => {
        if (r) applyRestore(r, dets);
      })
      .catch((err: unknown) => console.error('restore failed', err))
      .finally(() => setReady(true));
  }, [detections, applyRestore]);

  /** Debounces `fn` under `key`; a newer call for the same key replaces the pending one. */
  const scheduleSave = useCallback((key: string, fn: () => void) => {
    pendingSaves.current.set(key, fn);
    const timer = setTimeout(() => {
      if (pendingSaves.current.get(key) === fn) {
        pendingSaves.current.delete(key);
        fn();
      }
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const flush = () => {
      for (const fn of pendingSaves.current.values()) fn();
      pendingSaves.current.clear();
    };
    window.addEventListener('beforeunload', flush);
    return () => window.removeEventListener('beforeunload', flush);
  }, []);

  useEffect(() => {
    if (!ready || !project) return;
    const p = project;
    const payload = toPersisted(terminals, p.path);
    return scheduleSave('terminals', () => {
      window.crewdeck.project.saveTerminals(p.id, payload).catch((err: unknown) => console.error(err));
    });
  }, [ready, project, terminals, scheduleSave]);

  useEffect(() => {
    if (!ready || !project) return;
    const id = project.id;
    const payload: PersistedLayout = { layout, slots, activeSlot };
    return scheduleSave('layout', () => {
      window.crewdeck.project.saveLayout(id, payload).catch((err: unknown) => console.error(err));
    });
  }, [ready, project, layout, slots, activeSlot, scheduleSave]);

  const activeId = slots[activeSlot] ?? null;
  const attributions = useGitAttribution(projectId, mentionTerminals, activeId, lastRoute);

  /** Show terminal `id` in the active slot, or just focus it if it is already visible. */
  const showTerminal = (id: string) => {
    const visibleAt = slots.slice(0, layout).indexOf(id);
    if (visibleAt >= 0) {
      setActiveSlot(visibleAt);
      return;
    }
    setSlots((prev) => {
      const next = prev.map((s) => (s === id ? null : s));
      next[activeSlot] = id;
      return next;
    });
  };

  /** Place terminal `id` into slot `slot`, swapping with wherever it currently lives. */
  const assignSlot = (slot: number, id: string | null) => {
    setSlots((prev) => {
      const next = [...prev];
      const from = id ? prev.indexOf(id) : -1;
      if (from >= 0) next[from] = prev[slot];
      next[slot] = id;
      return next;
    });
    setActiveSlot(slot);
  };

  const openTerminal = async (profileId: AgentId) => {
    const profile = getProfile(profileId);
    const dets = detections ?? [];
    const detection = dets.find((d) => d.id === profileId);
    if (profileId !== 'shell' && !detection?.launch) return;
    const n = terminals.filter((t) => t.profileId === profileId).length + 1;
    const id = crypto.randomUUID();
    let worktree: WorktreeInfo | undefined;
    if (isolateNext && project) {
      try {
        const r = await window.crewdeck.git.worktreeAdd(project.id, id, profileId);
        if (!r.ok) {
          setWorktreeError(`Worktree not created: ${r.error}`);
          return;
        }
        worktree = r.worktree;
      } catch (err) {
        setWorktreeError(`Worktree not created: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }
    setWorktreeError(null);
    const base = buildSpec(id, `${profile.name} ${n}`, profileId, worktree?.path ?? project?.path, dets);
    const spec: TermSpec = worktree ? { ...base, worktree } : base;
    // Persist the row before the pane mounts so its session can reference it (FK).
    if (project) {
      // A stale debounced save (without this terminal) must not land after ours and delete the row.
      pendingSaves.current.delete('terminals');
      try {
        await window.crewdeck.project.saveTerminals(project.id, toPersisted([...terminals, spec], project.path));
      } catch (err) {
        console.error('saveTerminals failed', err);
      }
    }
    setTerminals((prev) => [...prev, spec]);
    // Prefer an empty visible slot; otherwise replace what the active slot shows.
    const empty = slots.slice(0, layout).indexOf(null);
    const target = empty >= 0 ? empty : activeSlot;
    setSlots((prev) => {
      const next = [...prev];
      next[target] = spec.id;
      return next;
    });
    setActiveSlot(target);
  };

  const closeTerminal = (id: string) => {
    const remaining = terminals.filter((t) => t.id !== id);
    setTerminals(remaining);
    setSlots((prev) => {
      const next = prev.map((s) => (s === id ? null : s));
      // Backfill the vacated active slot with a terminal that isn't shown anywhere.
      if (prev[activeSlot] === id) {
        const unshown = remaining.find((t) => !next.includes(t.id));
        if (unshown) next[activeSlot] = unshown.id;
      }
      return next;
    });
  };

  /**
   * Closes a worktree tab and deletes its worktree. The pane's PTY is killed on unmount but
   * not awaited, and Windows refuses to remove a directory that is some process's cwd, so
   * busy-dir failures are retried with backoff. Dirty worktrees need a second confirmation.
   */
  const removeWorktree = async (id: string) => {
    const term = terminals.find((t) => t.id === id);
    if (!project || !term?.worktree) return;
    const { path, branch } = term.worktree;
    if (!window.confirm(`Close "${term.title}" and delete its worktree?\n\n${path}\n\nThe branch ${branch} is kept.`)) {
      return;
    }
    closeTerminal(id);
    let force = false;
    let lastError = 'unknown error';
    for (let attempt = 0, delay = 300; attempt < 6; attempt++, delay = Math.min(delay * 2, 2000)) {
      await new Promise((r) => setTimeout(r, delay));
      try {
        const r = await window.crewdeck.git.worktreeRemove(project.id, path, force);
        if (r.ok) {
          setWorktreeError(null);
          return;
        }
        lastError = r.error ?? lastError;
        if (r.needsForce && !force) {
          if (!window.confirm(`${lastError}.\n\nDelete the worktree anyway? Uncommitted changes will be lost.`)) {
            setWorktreeError(`Worktree kept: ${path}`);
            return;
          }
          force = true;
          attempt--; // the forced retry does not count against busy-dir retries
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    setWorktreeError(`Worktree not removed: ${lastError}`);
  };

  const renameTerminal = (id: string, title: string) => {
    const trimmed = title.trim();
    if (trimmed) setTerminals((prev) => prev.map((t) => (t.id === id ? { ...t, title: trimmed } : t)));
    setRenamingId(null);
  };

  const changeLayout = (size: LayoutSize) => {
    setLayout(size);
    if (activeSlot >= size) setActiveSlot(0);
    // Fill newly visible empty slots with terminals that aren't currently shown.
    setSlots((prev) => {
      const next = [...prev];
      const visible = new Set(next.slice(0, size).filter(Boolean));
      const spare = terminals.filter((t) => !visible.has(t.id)).map((t) => t.id);
      for (let i = 0; i < size; i++) {
        if (next[i] === null && spare.length) {
          const id = spare.shift()!;
          const from = next.indexOf(id);
          if (from >= 0) next[from] = null;
          next[i] = id;
        }
      }
      return next;
    });
  };

  const selectProject = async () => {
    const picked = await window.crewdeck.project.select();
    if (!picked || picked.id === project?.id) return;
    // Write out the old project's pending state before switching away from it.
    for (const fn of pendingSaves.current.values()) fn();
    pendingSaves.current.clear();
    setReady(false);
    // Terminals opened before any project was chosen are adopted by the picked project.
    const orphans = project ? [] : toPersisted(terminals, picked.path);
    const merge = (r: RestoreResult): RestoreResult => ({ ...r, terminals: [...r.terminals, ...orphans] });
    // Persist adopted orphans immediately so they survive a restart even without further edits.
    const adopt = async (r: RestoreResult) => {
      const merged = merge(r);
      if (orphans.length) {
        try {
          await window.crewdeck.project.saveTerminals(picked.id, merged.terminals);
        } catch (err) {
          console.error('saveTerminals failed', err);
        }
      }
      applyRestore(merged, detections ?? []);
    };
    try {
      // The picked project is now the most recently opened one, so restore loads its saved state.
      const r = await window.crewdeck.project.restore();
      await adopt(r && r.project.id === picked.id ? r : { project: picked, layout: null, terminals: [] });
    } catch (err) {
      console.error('restore failed', err);
      await adopt({ project: picked, layout: null, terminals: [] });
    } finally {
      setReady(true);
    }
  };

  const { cols, rows } = slotGrid(layout);
  const visibleSlots = slots.slice(0, layout);

  const paneStyle = (id: string): CSSProperties => {
    const slot = visibleSlots.indexOf(id);
    if (slot < 0) return { display: 'none' };
    return { gridColumn: (slot % cols) + 1, gridRow: Math.floor(slot / cols) + 1 };
  };

  const slotPicker = (slot: number) => (
    <select
      className="slot-picker"
      value={slots[slot] ?? ''}
      title="Terminal shown in this pane"
      onMouseDown={(e) => e.stopPropagation()}
      onChange={(e) => assignSlot(slot, e.target.value || null)}
    >
      <option value="">(empty)</option>
      {terminals.map((t) => (
        <option key={t.id} value={t.id}>
          {t.title}
        </option>
      ))}
    </select>
  );

  return (
    <div className="app">
      <div className="toolbar">
        <span className="title">crewdeck</span>
        <button type="button" className="project" onClick={() => void selectProject()} title={project?.path ?? 'Choose project folder'}>
          {project ? `📁 ${project.name}` : 'Open Project…'}
        </button>
        <span className="spacer" />
        <div className="layout-picker" role="group" aria-label="Layout">
          {LAYOUTS.map((size) => (
            <button
              key={size}
              type="button"
              className={layout === size ? 'selected' : undefined}
              onClick={() => changeLayout(size)}
              title={`${size}-pane layout`}
            >
              {size}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => void openTerminal('shell')}>
          + Terminal
        </button>
        <select
          className="agent-picker"
          value=""
          onChange={(e) => {
            if (e.target.value) void openTerminal(e.target.value as AgentId);
          }}
          disabled={!detections}
        >
          <option value="">{detections ? '+ Agent…' : 'Detecting agents…'}</option>
          {AGENT_PROFILES.filter((p) => p.id !== 'shell').map((p) => {
            const installed = detections?.find((d) => d.id === p.id)?.installed ?? false;
            return (
              <option key={p.id} value={p.id} disabled={!installed}>
                {installed ? p.name : `${p.name} (not installed)`}
              </option>
            );
          })}
        </select>
        <label
          className="worktree-toggle"
          title="Start new terminals and agents in their own git worktree on a crewdeck/* branch"
        >
          <input
            type="checkbox"
            checked={isolateNext}
            disabled={!project}
            onChange={(e) => setIsolateNext(e.target.checked)}
          />
          Worktree
        </label>
        <button type="button" title="Re-detect installed agents" onClick={() => refreshAgents(true)}>
          ↻
        </button>
        <button
          type="button"
          className={showLog ? 'log-toggle selected' : 'log-toggle'}
          aria-pressed={showLog}
          title="Routing log"
          onClick={() => setShowLog((v) => !v)}
        >
          Log{routeLog.length ? ` (${routeLog.length})` : ''}
        </button>
        <button
          type="button"
          className={showGit ? 'log-toggle selected' : 'log-toggle'}
          aria-pressed={showGit}
          title="Git changes"
          onClick={() => setShowGit((v) => !v)}
        >
          Git
        </button>
      </div>

      {worktreeError && (
        <div className="banner error" role="alert">
          <span>{worktreeError}</span>
          <button type="button" title="Dismiss" onClick={() => setWorktreeError(null)}>
            ✕
          </button>
        </div>
      )}

      <div className="tabs" role="tablist">
        {terminals.map((t) => (
          <div
            key={t.id}
            role="tab"
            aria-selected={t.id === activeId}
            className={['tab', t.id === activeId ? 'active' : '', visibleSlots.includes(t.id) ? 'visible' : '']
              .filter(Boolean)
              .join(' ')}
            onClick={() => showTerminal(t.id)}
            onDoubleClick={() => setRenamingId(t.id)}
            title={`${t.title}${t.cwd ? ` — ${t.cwd}` : ''}\nDouble-click to rename`}
          >
            {renamingId === t.id ? (
              <input
                autoFocus
                defaultValue={t.title}
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => renameTerminal(t.id, e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') renameTerminal(t.id, e.currentTarget.value);
                  else if (e.key === 'Escape') setRenamingId(null);
                }}
              />
            ) : (
              <span>{t.title}</span>
            )}
            {t.worktree && (
              <button
                type="button"
                className="branch-badge"
                title={`Worktree: ${t.worktree.path}\nBranch: ${t.worktree.branch}\nClick to close the tab and delete the worktree`}
                onClick={(e) => {
                  e.stopPropagation();
                  void removeWorktree(t.id);
                }}
              >
                ⎇ {t.worktree.branch.replace(/^crewdeck\//, '')}
              </button>
            )}
            <button
              type="button"
              title="Close terminal"
              onClick={(e) => {
                e.stopPropagation();
                closeTerminal(t.id);
              }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      <div className="workspace">
      {terminals.length === 0 ? (
        <div className="grid empty">
          {project ? 'No terminals. Use “+ Terminal” or “+ Agent”.' : 'Open a project, then start a terminal or agent.'}
        </div>
      ) : (
        <div
          className="grid"
          style={{
            gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
          }}
        >
          {/* Every terminal stays mounted so scrollback survives tab/layout switches. */}
          {terminals.map((t) => {
            const slot = visibleSlots.indexOf(t.id);
            return (
              <TerminalPane
                key={t.id}
                terminalId={project ? t.id : undefined}
                title={t.title}
                shell={t.shell}
                args={t.args}
                env={t.env}
                cwd={t.cwd}
                resumeCommand={t.resumeCommand}
                style={paneStyle(t.id)}
                active={slot >= 0 && slot === activeSlot}
                headerExtra={slot >= 0 && layout > 1 ? slotPicker(slot) : undefined}
                onActivate={() => slot >= 0 && setActiveSlot(slot)}
                onClose={() => closeTerminal(t.id)}
                onPtyId={(p) => (p ? ptyIds.current.set(t.id, p) : ptyIds.current.delete(t.id))}
                sendTargets={mentionTargets.filter((m) => m.id !== t.id)}
                onSendSelection={(target, text) => forwardSelection(t.title, target, text)}
              />
            );
          })}
          {visibleSlots.map((id, slot) =>
            id === null ? (
              <div
                key={`empty-${slot}`}
                className={slot === activeSlot ? 'pane empty-slot active' : 'pane empty-slot'}
                style={{ gridColumn: (slot % cols) + 1, gridRow: Math.floor(slot / cols) + 1 }}
                onMouseDown={() => setActiveSlot(slot)}
              >
                <div className="pane-header">
                  <span className="pane-title">Empty pane</span>
                  {slotPicker(slot)}
                </div>
                <div className="empty">Pick a terminal, or open a new one.</div>
              </div>
            ) : null,
          )}
        </div>
      )}
      {showLog && <RoutingLog entries={routeLog} hasProject={!!project} onClose={() => setShowLog(false)} />}
      {showGit && <GitPanel projectId={projectId} onClose={() => setShowGit(false)} attributions={attributions} />}
      </div>

      <Composer terminals={mentionTerminals} onSend={routeMessage} />
    </div>
  );
}

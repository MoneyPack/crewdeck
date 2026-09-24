// CD-20: best-effort per-agent attribution of working-tree changes.
// Heuristic: when a file's git state changes, credit the terminal that was last routed a message
// (if recent), otherwise the terminal that was focused. It can be wrong: agents run in parallel,
// users edit files by hand, and a file that is already dirty is not re-attributed on later edits.
import { useEffect, useRef, useState } from 'react';
import { mentionHandles, type MentionTerminal } from '../../shared/mention';
import type { GitFileStatus } from '../../shared/ipc';
import type { FileAttribution } from '../components/GitPanel/GitPanel';

/** A routed message credits its target for changes seen within this window. */
export const ROUTE_ATTRIBUTION_WINDOW_MS = 5 * 60_000;

export interface LastRoute {
  terminalId: string;
  at: number;
}

const fingerprint = (f: GitFileStatus) => `${f.index}${f.worktree}:${f.state}:${f.oldPath ?? ''}`;

export function useGitAttribution(
  projectId: string | null,
  terminals: readonly MentionTerminal[],
  activeId: string | null,
  lastRoute: { readonly current: LastRoute | null },
): Record<string, FileAttribution> {
  const [attributions, setAttributions] = useState<Record<string, FileAttribution>>({});
  // Latest inputs, read from the async change handler without re-subscribing.
  const inputs = useRef({ terminals, activeId });
  inputs.current = { terminals, activeId };

  useEffect(() => {
    setAttributions({});
    if (!projectId) return;
    const api = window.crewdeck.git;
    let disposed = false;
    let baseline: Map<string, string> | null = null;
    let inFlight = false;
    let again = false;

    const pickCulprit = (): FileAttribution | null => {
      const { terminals: terms, activeId: active } = inputs.current;
      const handles = mentionHandles(terms);
      const route = lastRoute.current;
      if (route && Date.now() - route.at <= ROUTE_ATTRIBUTION_WINDOW_MS) {
        const t = handles.find((h) => h.id === route.terminalId);
        if (t) return { name: t.handle, reason: 'last routed' };
      }
      const t = active ? handles.find((h) => h.id === active) : undefined;
      return t ? { name: t.handle, reason: 'active terminal' } : null;
    };

    const refresh = async () => {
      if (inFlight) {
        again = true;
        return;
      }
      inFlight = true;
      try {
        do {
          again = false;
          const status = await api.status(projectId);
          if (disposed) return;
          const next = new Map(status.isRepo ? status.files.map((f) => [f.path, fingerprint(f)] as const) : []);
          const prev = baseline;
          baseline = next;
          // The first snapshot is the baseline: pre-existing changes are not attributed.
          if (!prev) continue;
          const changed = [...next].filter(([p, fp]) => prev.get(p) !== fp).map(([p]) => p);
          const culprit = changed.length ? pickCulprit() : null;
          setAttributions((cur) => {
            const out: Record<string, FileAttribution> = {};
            let dirty = false;
            for (const [p, a] of Object.entries(cur)) {
              if (next.has(p)) out[p] = a;
              else dirty = true;
            }
            if (culprit) {
              for (const p of changed) {
                // Keep the first attribution for a file that stays dirty.
                if (!out[p]) {
                  out[p] = culprit;
                  dirty = true;
                }
              }
            }
            return dirty ? out : cur;
          });
        } while (again && !disposed);
      } catch (err) {
        console.error('git attribution refresh failed', err);
      } finally {
        inFlight = false;
      }
    };

    const off = api.onChanged((e) => {
      if (e.projectId === projectId) void refresh();
    });
    api
      .watch(projectId)
      .then(() => refresh())
      .catch((err: unknown) => console.error('git watch failed', err));
    return () => {
      disposed = true;
      off();
      api.unwatch(projectId).catch(() => {});
    };
  }, [projectId, lastRoute]);

  return attributions;
}

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { normalizeUrl, parseCliArgs, type BrowserResult, type BrowserState } from '../../../shared/browser';

interface Props {
  projectId: string | null;
  onClose: () => void;
  /** Hide the native view (e.g. while a modal overlays the workspace). */
  hidden?: boolean;
  /** URL to restore when the pane opens on a blank page. */
  initialUrl?: string | null;
  /** Called whenever the committed page URL changes (for persistence). */
  onUrlChange?: (url: string | null) => void;
}

const EMPTY_STATE: BrowserState = { url: '', title: '', loading: false, canGoBack: false, canGoForward: false, visible: false };
const MAX_HISTORY = 50;

function isBlank(url: string): boolean {
  return !url || url === 'about:blank';
}

/** Render the most useful part of a result as terminal-ish text. */
function formatResult(r: BrowserResult): string {
  if (!r.ok) return `✕ ${r.action}: ${r.error ?? 'failed'}`;
  const parts: string[] = [];
  if (r.text) parts.push(r.text);
  if (r.diff) parts.push(r.diff);
  if (r.screenshotPath) parts.push(`saved ${r.screenshotPath}`);
  if (!parts.length) parts.push(`✓ ${r.action}${r.title ? ` — ${r.title}` : ''}`);
  return parts.join('\n\n');
}

export function BrowserPane({ projectId, onClose, hidden = false, initialUrl = null, onUrlChange }: Props) {
  const api = window.crewdeck.browser;
  const viewportRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<BrowserState>(EMPTY_STATE);
  const [address, setAddress] = useState('');
  const [editing, setEditing] = useState(false);
  const [output, setOutput] = useState<{ text: string; ok: boolean; shot?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cmd, setCmd] = useState('');
  const history = useRef<string[]>([]);
  const historyIdx = useRef(-1);
  const onUrlChangeRef = useRef(onUrlChange);
  onUrlChangeRef.current = onUrlChange;
  const restored = useRef(false);

  // Live state from the main-process engine.
  useEffect(() => {
    let alive = true;
    void api.state().then((s) => alive && setState(s)).catch(() => undefined);
    const off = api.onState((s) => setState(s));
    return () => {
      alive = false;
      off();
    };
  }, [api]);

  useEffect(() => {
    if (!editing) setAddress(isBlank(state.url) ? '' : state.url);
  }, [state.url, editing]);

  useEffect(() => {
    if (state.loading) return;
    onUrlChangeRef.current?.(isBlank(state.url) || state.url.startsWith('data:') ? null : state.url);
  }, [state.url, state.loading]);

  const run = useCallback(
    async (command: unknown): Promise<BrowserResult | null> => {
      setBusy(true);
      setError(null);
      try {
        const r = await api.run(command, projectId);
        setOutput({ text: formatResult(r), ok: r.ok, shot: r.screenshotPath });
        if (!r.ok) setError(r.error ?? `${r.action} failed`);
        return r;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [api, projectId],
  );

  // Restore the persisted page once the engine reports a blank view.
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const url = normalizeUrl(initialUrl);
    if (!url) return;
    void api
      .state()
      .then((s) => (isBlank(s.url) ? run({ action: 'open', url }) : null))
      .catch(() => undefined);
  }, [api, initialUrl, run]);

  // Keep the native WebContentsView glued to the viewport placeholder.
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    let frame = 0;
    const push = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        const x = Math.round(r.left);
        const y = Math.round(r.top);
        api.setBounds({ x, y, width: Math.max(0, Math.round(r.right) - x), height: Math.max(0, Math.round(r.bottom) - y) });
      });
    };
    push();
    const ro = new ResizeObserver(push);
    ro.observe(el);
    ro.observe(document.body);
    window.addEventListener('resize', push);
    // The pane slides in with a CSS animation: track position until it settles.
    const pane = el.closest('.browser-pane');
    pane?.addEventListener('animationend', push);
    const settle = window.setInterval(push, 60);
    const stopSettle = window.setTimeout(() => window.clearInterval(settle), 600);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      window.removeEventListener('resize', push);
      pane?.removeEventListener('animationend', push);
      window.clearInterval(settle);
      window.clearTimeout(stopSettle);
    };
  }, [api]);

  useEffect(() => {
    api.setVisible(!hidden);
  }, [api, hidden]);
  useEffect(() => () => api.setVisible(false), [api]);

  const submitAddress = (e: FormEvent) => {
    e.preventDefault();
    const url = normalizeUrl(address);
    if (!url) {
      setError('Only http(s), data: and about:blank URLs are allowed');
      return;
    }
    setEditing(false);
    (document.activeElement as HTMLElement | null)?.blur();
    void run({ action: 'open', url });
  };

  const submitCmd = (e: FormEvent) => {
    e.preventDefault();
    const line = cmd.trim();
    if (!line) return;
    const parsed = parseCliArgs(line.split(/\s+/));
    if (!parsed) {
      setError(`Unknown command: ${line}`);
      return;
    }
    history.current = [line, ...history.current.filter((h) => h !== line)].slice(0, MAX_HISTORY);
    historyIdx.current = -1;
    setCmd('');
    void run(parsed);
  };

  const cmdKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const h = history.current;
    if (!h.length) return;
    const next = e.key === 'ArrowUp' ? Math.min(h.length - 1, historyIdx.current + 1) : historyIdx.current - 1;
    historyIdx.current = Math.max(-1, next);
    setCmd(historyIdx.current < 0 ? '' : h[historyIdx.current]!);
  };

  const blank = isBlank(state.url);
  let host = '';
  try {
    host = blank ? '' : state.url.startsWith('data:') ? 'data:' : new URL(state.url).host;
  } catch {
    host = '';
  }

  return (
    <aside className={state.loading ? 'browser-pane loading' : 'browser-pane'} aria-label="Browser" aria-busy={state.loading || busy}>
      <header className="browser-header">
        <span className="browser-title">Browser</span>
        <div className="browser-nav" role="group" aria-label="Navigation">
          <button type="button" disabled={!state.canGoBack} onClick={() => void run({ action: 'back' })} title="Back" aria-label="Back">
            <i className="ri-arrow-left-line" aria-hidden />
          </button>
          <button type="button" disabled={!state.canGoForward} onClick={() => void run({ action: 'forward' })} title="Forward" aria-label="Forward">
            <i className="ri-arrow-right-line" aria-hidden />
          </button>
          <button type="button" disabled={blank} onClick={() => void run({ action: 'reload' })} title="Reload" aria-label="Reload">
            <i className="ri-refresh-line" aria-hidden />
          </button>
        </div>
        <form className="browser-address" onSubmit={submitAddress} role="search">
          <i className="ri-global-line" aria-hidden />
          <input
            type="text"
            value={address}
            spellCheck={false}
            autoComplete="off"
            placeholder="Enter URL — agents drive this pane too"
            aria-label="Address"
            onFocus={(e) => {
              setEditing(true);
              e.currentTarget.select();
            }}
            onBlur={() => setEditing(false)}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setAddress(blank ? '' : state.url);
                e.currentTarget.blur();
              }
            }}
          />
        </form>
        <button type="button" className="browser-action" disabled={busy || blank} onClick={() => void run({ action: 'snapshot', interactiveOnly: true })} title="Accessibility snapshot (interactive refs)">
          <i className="ri-focus-3-line" aria-hidden /> Snap
        </button>
        <button type="button" className="browser-action" disabled={busy || blank} onClick={() => void run({ action: 'screenshot', fullPage: false, annotate: true })} title="Annotated screenshot">
          <i className="ri-camera-line" aria-hidden /> Shot
        </button>
        <button type="button" className="browser-close" onClick={onClose} title="Close browser" aria-label="Close browser">
          <i className="ri-close-line" aria-hidden />
        </button>
      </header>

      {error && (
        <div className="browser-warning" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss error">
            <i className="ri-close-line" aria-hidden />
          </button>
        </div>
      )}

      <div className="browser-viewport" ref={viewportRef} data-blank={blank || undefined}>
        {blank && (
          <div className="browser-empty">
            <strong>No page</strong>
            <span>Type a URL above, or let an agent drive it with <code>crewdeck-browser open &lt;url&gt;</code>.</span>
          </div>
        )}
      </div>

      <footer className="browser-console">
        <div className="browser-status">
          <span className="browser-host">{host || '—'}</span>
          <span className="browser-page-title">{state.title}</span>
          {(state.loading || busy) && <span className="browser-busy">{state.loading ? 'loading' : 'running'}</span>}
        </div>
        {output && (
          <pre className={output.ok ? 'browser-output' : 'browser-output error'} tabIndex={0} aria-label="Command output">
            {output.text}
          </pre>
        )}
        <form className="browser-cmd" onSubmit={submitCmd}>
          <span aria-hidden>&gt;</span>
          <input
            type="text"
            value={cmd}
            spellCheck={false}
            autoComplete="off"
            placeholder="snapshot -i · click @e3 · fill @e2 text · press Enter · screenshot --annotate"
            aria-label="Browser command"
            onChange={(e) => {
              setCmd(e.target.value);
              historyIdx.current = -1;
            }}
            onKeyDown={cmdKey}
          />
        </form>
      </footer>
    </aside>
  );
}

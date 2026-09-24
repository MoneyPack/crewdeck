import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { RESTORED_DIVIDER, type TerminalDataEvent, type TerminalExitEvent } from '../../../shared/ipc';
import type { MentionTarget } from '../../../shared/mention';

export interface TerminalPaneProps {
  title: string;
  shell?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Persisted terminal id; when set, main records a session row for this PTY. Read at mount only. */
  terminalId?: string;
  /** Resume command line recorded in session metadata (CD-13). Read at mount only. */
  resumeCommand?: string;
  /** Session id this pane restores from, recorded in session metadata. Read at mount only. */
  restoredFrom?: string;
  /** Whether this pane has keyboard focus in the layout. Becoming active focuses xterm. */
  active?: boolean;
  /** Positioning/visibility from the layout. Hidden panes stay mounted to keep scrollback. */
  style?: CSSProperties;
  /** Extra controls rendered in the header (e.g. the slot's terminal picker). */
  headerExtra?: ReactNode;
  onActivate?: () => void;
  onClose?: () => void;
  /** Reports the live PTY id (null once the process exits or the pane unmounts). */
  onPtyId?: (ptyId: string | null) => void;
  /** Other terminals the current selection can be forwarded to (CD-16). */
  sendTargets?: MentionTarget[];
  /** Forwards the raw selected text to `target`. Resolves an error message on failure. */
  onSendSelection?: (target: MentionTarget, text: string) => Promise<string | void> | string | void;
}

/**
 * Make recorded output safe to replay into a fresh terminal: drop alternate-screen switches
 * (a TUI running at quit would otherwise leave the replay stranded in the alt buffer) and
 * scrollback erases (ESC[3J) that would discard earlier history.
 */
function sanitizeReplay(data: string): string {
  // eslint-disable-next-line no-control-regex
  return data.replace(/\x1b\[\?(?:1049|1047|47)[hl]/g, '').replace(/\x1b\[3J/g, '');
}

/** A nonzero exit this soon after spawn almost always means the command could not start. */
const FAST_EXIT_MS = 1500;

type Status = { kind: 'starting' } | { kind: 'running'; pid: number } | { kind: 'exited'; code: number } | { kind: 'error'; message: string };

export function TerminalPane({ title, shell, args, cwd, env, terminalId, resumeCommand, restoredFrom, active, style, headerExtra, onActivate, onClose, onPtyId, sendTargets, onSendSelection }: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onPtyIdRef = useRef(onPtyId);
  onPtyIdRef.current = onPtyId;
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'starting' });
  const [hasSelection, setHasSelection] = useState(false);
  const [sendNote, setSendNote] = useState<string | null>(null);
  const hidden = style?.display === 'none';

  useEffect(() => {
    if (!sendNote) return;
    const timer = setTimeout(() => setSendNote(null), 2500);
    return () => clearTimeout(timer);
  }, [sendNote]);

  const sendSelection = async (handle: string) => {
    const target = sendTargets?.find((t) => t.handle === handle);
    const text = termRef.current?.getSelection() ?? '';
    if (!target || !onSendSelection || !text) return;
    try {
      const error = await onSendSelection(target, text);
      setSendNote(error ? error : `sent to @${target.handle}`);
      if (!error) termRef.current?.clearSelection();
    } catch (err) {
      setSendNote(err instanceof Error ? err.message : String(err));
    }
  };

  // Refit when the pane becomes visible (hidden panes have zero size), and focus when active.
  useEffect(() => {
    if (hidden) return;
    const frame = requestAnimationFrame(() => {
      if (fitRef.current) safeFit(fitRef.current);
      if (active) termRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, hidden]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const api = window.crewdeck.terminal;
    const term = new Terminal({
      fontFamily: "'Cascadia Mono', Consolas, monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 10_000,
      allowProposedApi: false,
      // ConPTY clears the screen (ESC[2J) when a new session starts; push the replayed
      // history into scrollback instead of erasing it.
      scrollOnEraseInDisplay: true,
      windowsPty: window.crewdeck.platform === 'win32' ? { backend: 'conpty' } : undefined,
      theme: { background: '#0f1115', foreground: '#d6dae1' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(host);
    // Expose the instance for automated (CDP) checks that need the full buffer, not just visible rows.
    (host as HTMLDivElement & { __xterm?: Terminal }).__xterm = term;
    safeFit(fit);
    termRef.current = term;
    fitRef.current = fit;

    let disposed = false;
    let ptyId: string | null = null;
    // Events that arrive before create() resolves are held until we know our id.
    const pending: TerminalDataEvent[] = [];

    // CD-23: coalesce PTY chunks and hand them to xterm once per animation frame, so many
    // concurrently streaming panes cost one parse/render per frame instead of one per IPC event.
    let outBuf: string[] = [];
    let outFrame = 0;
    const flushOut = () => {
      outFrame = 0;
      if (!outBuf.length) return;
      const data = outBuf.length === 1 ? outBuf[0] : outBuf.join('');
      outBuf = [];
      term.write(data);
    };
    const queueOut = (data: string) => {
      outBuf.push(data);
      // Hidden panes get no rAF ticks in background windows; cap buffered size and flush directly.
      if (outBuf.length > 512) flushOut();
      else if (!outFrame) outFrame = requestAnimationFrame(flushOut);
    };
    let spawnedAt = 0;

    const offData = window.crewdeck.terminal.onData((event) => {
      if (ptyId === null) pending.push(event);
      else if (event.id === ptyId) queueOut(event.data);
    });
    const offExit = window.crewdeck.terminal.onExit((event: TerminalExitEvent) => {
      if (event.id !== ptyId) return;
      cancelAnimationFrame(outFrame);
      flushOut();
      term.write(`\r\n\x1b[90m[process exited with code ${event.exitCode}]\x1b[0m\r\n`);
      if (event.exitCode !== 0 && performance.now() - spawnedAt < FAST_EXIT_MS) {
        const what = args?.length ? `"${[shell, ...args].filter(Boolean).join(' ')}"` : `"${shell ?? 'default shell'}"`;
        term.write(
          `\x1b[33m${what} exited immediately. If it printed "not recognized" or "not found", the command is not installed or not on PATH — install it or pick another agent, then reopen this terminal.\x1b[0m\r\n`,
        );
      }
      setStatus({ kind: 'exited', code: event.exitCode });
      ptyId = null;
      onPtyIdRef.current?.(null);
    });

    const inputSub = term.onData((data) => {
      if (ptyId) api.write(ptyId, data);
    });
    const resizeSub = term.onResize(({ cols, rows }) => {
      if (ptyId) api.resize(ptyId, cols, rows);
    });
    const selectionSub = term.onSelectionChange(() => setHasSelection(term.hasSelection()));

    let resizeFrame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => safeFit(fit));
    });
    observer.observe(host);

    // Replay the previous session's scrollback before spawning, so new output lands below the divider.
    const replay: Promise<void> = terminalId
      ? api
          .scrollback(terminalId)
          .then((prev) => {
            if (!disposed && prev) term.write(sanitizeReplay(prev) + RESTORED_DIVIDER);
          })
          .catch(() => undefined)
      : Promise.resolve();

    replay
      .then(() => {
        if (disposed) throw new Error('disposed');
        return api.create({ shell, args, cwd, env, terminalId, resumeCommand, restoredFrom, cols: term.cols, rows: term.rows });
      })
      .then((result) => {
        if (disposed) {
          void api.kill(result.id);
          return;
        }
        ptyId = result.id;
        spawnedAt = performance.now();
        for (const event of pending.splice(0)) {
          if (event.id === ptyId) queueOut(event.data);
        }
        setStatus({ kind: 'running', pid: result.pid });
        onPtyIdRef.current?.(result.id);
      })
      .catch((err: unknown) => {
        if (disposed) return;
        const message = err instanceof Error ? err.message : String(err);
        term.write(`\x1b[31m${message}\x1b[0m\r\n`);
        setStatus({ kind: 'error', message });
      });

    return () => {
      disposed = true;
      observer.disconnect();
      cancelAnimationFrame(resizeFrame);
      cancelAnimationFrame(outFrame);
      inputSub.dispose();
      resizeSub.dispose();
      selectionSub.dispose();
      offData();
      offExit();
      if (ptyId) void api.kill(ptyId);
      onPtyIdRef.current?.(null);
      termRef.current = null;
      fitRef.current = null;
      term.dispose();
    };
    // Shell/args/cwd are fixed for the life of a pane.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className={active ? 'pane active' : 'pane'}
      style={style}
      onMouseDown={onActivate}
      onFocus={onActivate}
    >
      <div className="pane-header">
        <span className="pane-title">{title}</span>
        {headerExtra}
        {onSendSelection && sendTargets && sendTargets.length > 0 && (
          <select
            className="send-selection"
            title={hasSelection ? 'Send selected text to another terminal' : 'Select text in this terminal first'}
            disabled={!hasSelection}
            value=""
            onMouseDown={(e) => e.stopPropagation()}
            onChange={(e) => void sendSelection(e.target.value)}
          >
            <option value="" disabled>
              Send to…
            </option>
            {sendTargets.map((t) => (
              <option key={t.id} value={t.handle}>
                @{t.handle}
              </option>
            ))}
          </select>
        )}
        {sendNote && <span className="send-note">{sendNote}</span>}
        <span className="status">{describe(status)}</span>
        {onClose && (
          <button type="button" title="Close terminal" onClick={onClose}>
            ✕
          </button>
        )}
      </div>
      {status.kind === 'error' && <div className="pane-error">Failed to start: {status.message}</div>}
      <div className="pane-body" ref={hostRef} />
    </div>
  );
}

function safeFit(fit: FitAddon): void {
  try {
    fit.fit();
  } catch {
    // Host not laid out yet (zero size); next ResizeObserver tick will retry.
  }
}

function describe(status: Status): string {
  switch (status.kind) {
    case 'starting':
      return 'starting…';
    case 'running':
      return `pid ${status.pid}`;
    case 'exited':
      return `exited (${status.code})`;
    case 'error':
      return 'error';
  }
}

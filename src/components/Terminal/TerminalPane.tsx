import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import {
  RESTORED_DIVIDER,
  type AppSettings,
  type TerminalDataEvent,
  type TerminalExitEvent,
} from '../../../shared/ipc';

export type TerminalSettings = Pick<
  AppSettings,
  'fontSize' | 'cursorStyle' | 'cursorBlink' | 'scrollback' | 'fontFamily' | 'lineHeight'
>;
import type { MentionTarget } from '../../../shared/mention';
import { findShortcut } from '../../../shared/shortcuts';
import { ACTIVITY_LABEL, classify, type Activity } from '../../../shared/activity';
import { fmtTokens, NO_USAGE, scanUsage, type Usage } from '../../../shared/usage';
import { stripAnsi } from '../../../shared/ansi';
import { Reader } from './Reader';
import logo from '../../assets/logo.svg';

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
  /** Agent profile id; drives the pane's accent color via `[data-agent]`. */
  agent?: string;
  terminalSettings?: TerminalSettings;
  /** Reports working / waiting / idle transitions plus the recent output tail (for pipelines). */
  onActivity?: (activity: Activity, tail: string) => void;
}

/** xterm palette from styles.css design tokens: [xterm key, CSS custom property, fallback literal]. */
const XTERM_THEME_TOKENS = [
  ['background', '--ink', '#0c0c0a'],
  ['foreground', '--paper', '#e8e4da'],
  ['cursor', '--signal', '#ff4d00'],
  ['cursorAccent', '--ink', '#0c0c0a'],
  ['selectionBackground', '--term-selection', 'rgba(255, 77, 0, 0.28)'],
  ['selectionInactiveBackground', '--term-selection-inactive', 'rgba(255, 77, 0, 0.14)'],
  ['scrollbarSliderBackground', '--term-scrollbar', 'rgba(232, 228, 218, 0.10)'],
  ['scrollbarSliderHoverBackground', '--term-scrollbar-hover', 'rgba(232, 228, 218, 0.20)'],
  ['scrollbarSliderActiveBackground', '--term-scrollbar-active', 'rgba(255, 77, 0, 0.45)'],
  ['black', '--ink-3', '#1d1d1a'],
  ['red', '--err', '#ff3b3b'],
  ['green', '--ok', '#c6f432'],
  ['yellow', '--warn', '#ffc233'],
  ['blue', '--term-blue', '#5b9dff'],
  ['magenta', '--term-magenta', '#b69cff'],
  ['cyan', '--info', '#3fe0ff'],
  ['white', '--term-white', '#c9c4b8'],
  ['brightBlack', '--paper-mute', '#5d5a52'],
  ['brightRed', '--term-bright-red', '#ff6b5b'],
  ['brightGreen', '--term-bright-green', '#d8ff6a'],
  ['brightYellow', '--term-bright-yellow', '#ffd466'],
  ['brightBlue', '--term-bright-blue', '#8bbaff'],
  ['brightMagenta', '--term-bright-magenta', '#cfbcff'],
  ['brightCyan', '--term-bright-cyan', '#7cecff'],
  ['brightWhite', '--term-bright-white', '#f4f1ea'],
] as const;

type XtermThemeKey = (typeof XTERM_THEME_TOKENS)[number][0];

/** Resolve design tokens to concrete colors (xterm cannot consume var()). */
function readXtermTheme(): Record<XtermThemeKey, string> {
  const style = typeof document === 'undefined' ? null : getComputedStyle(document.documentElement);
  const theme = {} as Record<XtermThemeKey, string>;
  for (const [key, prop, fallback] of XTERM_THEME_TOKENS) {
    theme[key] = style?.getPropertyValue(prop).trim() || fallback;
  }
  return theme;
}

const XTERM_FONT = "'JetBrains Mono Variable', 'JetBrains Mono', monospace";

/** Terminal font from the `--mono` token, falling back to XTERM_FONT. */
function readXtermFont(): string {
  if (typeof document === 'undefined') return XTERM_FONT;
  return getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() || XTERM_FONT;
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

type Status =
  | { kind: 'starting' }
  | { kind: 'running'; pid: number }
  | { kind: 'exited'; code: number }
  | { kind: 'error'; message: string };

export function TerminalPane({
  title,
  shell,
  args,
  cwd,
  env,
  terminalId,
  resumeCommand,
  restoredFrom,
  active,
  style,
  headerExtra,
  onActivate,
  onClose,
  onPtyId,
  sendTargets,
  onSendSelection,
  agent,
  terminalSettings,
  onActivity,
}: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onPtyIdRef = useRef(onPtyId);
  onPtyIdRef.current = onPtyId;
  const onActivityRef = useRef(onActivity);
  onActivityRef.current = onActivity;
  const terminalSettingsRef = useRef(terminalSettings);
  terminalSettingsRef.current = terminalSettings;
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'starting' });
  const [activity, setActivity] = useState<Activity>('off');
  const [usage, setUsage] = useState<Usage>(NO_USAGE);
  const [reader, setReader] = useState(false);
  const [readerText, setReaderText] = useState('');
  const readerRef = useRef(false);
  readerRef.current = reader;
  // Recent output tail + timestamp, used by the activity heuristic.
  const tailRef = useRef({ buf: '', at: 0 });
  const [hasSelection, setHasSelection] = useState(false);
  const [sendNote, setSendNote] = useState<string | null>(null);
  const hidden = style?.display === 'none';

  useEffect(() => {
    if (!sendNote) return;
    const timer = setTimeout(() => setSendNote(null), 2500);
    return () => clearTimeout(timer);
  }, [sendNote]);

  // Activity heuristic: re-classify on a slow tick; only report transitions.
  useEffect(() => {
    const alive = status.kind === 'running';
    let last: Activity | null = null;
    const tick = () => {
      const t = tailRef.current;
      const next = classify(performance.now(), t.at, t.buf, alive);
      if (next !== last) {
        last = next;
        setActivity(next);
        onActivityRef.current?.(next, t.buf.slice(-400));
      }
    };
    tick();
    const timer = window.setInterval(tick, 700);
    return () => window.clearInterval(timer);
  }, [status.kind]);

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

  // Apply terminal settings changes live to the existing xterm instance.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = terminalSettings?.fontSize ?? 13;
    term.options.lineHeight = terminalSettings?.lineHeight ?? 1.15;
    term.options.cursorBlink = terminalSettings?.cursorBlink ?? true;
    term.options.cursorStyle = terminalSettings?.cursorStyle ?? 'block';
    term.options.scrollback = terminalSettings?.scrollback ?? 10_000;
    term.options.fontFamily = terminalSettings?.fontFamily || readXtermFont();
    if (fitRef.current) safeFit(fitRef.current);
  }, [
    terminalSettings?.fontSize,
    terminalSettings?.lineHeight,
    terminalSettings?.cursorBlink,
    terminalSettings?.cursorStyle,
    terminalSettings?.scrollback,
    terminalSettings?.fontFamily,
  ]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const api = window.crewdeck.terminal;
    const term = new Terminal({
      fontFamily: terminalSettingsRef.current?.fontFamily || readXtermFont(),
      fontSize: terminalSettingsRef.current?.fontSize ?? 13,
      lineHeight: terminalSettingsRef.current?.lineHeight ?? 1.15,
      cursorBlink: terminalSettingsRef.current?.cursorBlink ?? true,
      cursorStyle: terminalSettingsRef.current?.cursorStyle ?? 'block',
      cursorInactiveStyle: 'outline',
      minimumContrastRatio: 1,
      scrollback: terminalSettingsRef.current?.scrollback ?? 10_000,
      allowProposedApi: false,
      // ConPTY clears the screen (ESC[2J) when a new session starts; push the replayed
      // history into scrollback instead of erasing it.
      scrollOnEraseInDisplay: true,
      windowsPty: window.crewdeck.platform === 'win32' ? { backend: 'conpty' } : undefined,
      theme: readXtermTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(host);
    // App-level shortcuts are handled by the window capture listener; keep xterm from also
    // forwarding them to the PTY.
    const mac = window.crewdeck.platform === 'darwin';
    term.attachCustomKeyEventHandler((e) => !findShortcut(e, mac));
    // GPU renderer; falls back to the DOM renderer if WebGL2 is unavailable or the context is lost.
    // `localStorage['crewdeck.renderer'] = 'dom'` forces the DOM renderer (A/B + troubleshooting).
    let webgl: WebglAddon | null = null;
    if (localStorage.getItem('crewdeck.renderer') !== 'dom') {
      try {
        const addon = new WebglAddon();
        addon.onContextLoss(() => {
          addon.dispose();
          if (webgl === addon) webgl = null;
        });
        term.loadAddon(addon);
        webgl = addon;
      } catch {
        webgl = null;
      }
    }
    host.dataset.renderer = webgl ? 'webgl' : 'dom';
    // Expose the instance for automated (CDP) checks that need the full buffer, not just visible rows.
    (host as HTMLDivElement & { __xterm?: Terminal }).__xterm = term;
    safeFit(fit);
    termRef.current = term;
    fitRef.current = fit;

    let disposed = false;
    // The variable webfont may finish loading after open(); re-measure cells once it has.
    const fontSpec = "13px 'JetBrains Mono Variable'";
    if (document.fonts && !document.fonts.check(fontSpec)) {
      void document.fonts.load(fontSpec).then(() => {
        if (disposed) return;
        // xterm skips no-op option writes, so bounce the value to force a glyph re-measure.
        term.options.fontFamily = 'monospace';
        term.options.fontFamily = readXtermFont();
        safeFit(fit);
      });
    }
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
      term.write(data, () => {
        if (readerRef.current) setReaderText(bufferText(term));
      });
    };
    const queueOut = (data: string) => {
      const t = tailRef.current;
      t.at = performance.now();
      t.buf = (t.buf + data).slice(-2000);
      // Usage lines are short; scan the stripped chunk plus a little context.
      setUsage((u) => scanUsage(u, stripAnsi(t.buf.slice(-600))));
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
        return api.create({
          shell,
          args,
          cwd,
          env,
          terminalId,
          resumeCommand,
          restoredFrom,
          cols: term.cols,
          rows: term.rows,
        });
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
      webgl?.dispose();
      webgl = null;
      term.dispose();
    };
    // Shell/args/cwd are fixed for the life of a pane.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className={active ? 'pane active' : 'pane'}
      data-agent={agent}
      data-activity={activity}
      style={style}
      onMouseDown={onActivate}
      onFocus={onActivate}
    >
      <div className="pane-header">
        <img className="pane-logo" src={logo} alt="" title="crewdeck" />
        <span className="pane-title">{title}</span>
        {headerExtra}
        <span className="pane-actions">
          <button
            type="button"
            className="icon-btn"
            title="Clear screen"
            aria-label="Clear screen"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => termRef.current?.clear()}
          >
            <i className="ri-eraser-line" aria-hidden="true" />
          </button>
          <button
            type="button"
            className={reader ? 'icon-btn selected' : 'icon-btn'}
            aria-pressed={reader}
            title="Reader mode: show output as readable text"
            aria-label="Toggle reader mode"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => {
              const next = !reader;
              setReader(next);
              if (next && termRef.current) setReaderText(bufferText(termRef.current));
            }}
          >
            <i className="ri-article-line" aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Copy visible output"
            aria-label="Copy visible output"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => {
              const term = termRef.current;
              if (!term) return;
              const buf = term.buffer.active;
              const lines: string[] = [];
              for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
              void navigator.clipboard.writeText(lines.join('\n').trimEnd());
            }}
          >
            <i className="ri-file-copy-line" aria-hidden="true" />
          </button>
        </span>
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
        <span className="status">
          {(usage.usd !== null || usage.tokens !== null) && (
            <span className="usage" title="Usage scraped from this agent's own output (approximate)">
              {usage.tokens !== null && <>{fmtTokens(usage.tokens)} tok</>}
              {usage.tokens !== null && usage.usd !== null && ' · '}
              {usage.usd !== null && <>${usage.usd.toFixed(2)}</>}
            </span>
          )}
          {status.kind === 'running' && (
            <span className={`activity activity--${activity}`} title={ACTIVITY_LABEL[activity]}>
              <i aria-hidden="true" />
              {ACTIVITY_LABEL[activity]}
            </span>
          )}
          {describe(status)}
        </span>
        {onClose && (
          <button
            type="button"
            className="icon-btn"
            title="Close terminal"
            aria-label="Close terminal"
            onClick={onClose}
          >
            <i className="ri-close-line" aria-hidden="true" />
          </button>
        )}
      </div>
      {status.kind === 'error' && <div className="pane-error">Failed to start: {status.message}</div>}
      <div className="pane-body" ref={hostRef} />
      {reader && <Reader text={readerText} onClose={() => setReader(false)} />}
    </div>
  );
}

/** Whole xterm buffer as plain text (trailing blank lines trimmed). */
function bufferText(term: Terminal): string {
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
  return lines.join('\n').replace(/\s+$/, '');
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

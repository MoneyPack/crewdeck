import { app, BrowserWindow, ipcMain, Notification, shell, type WebContents } from 'electron';
import { getSettings } from '../services/settings';
import path from 'node:path';
import { RESTORED_DIVIDER, TerminalChannels, type TerminalCreateOptions } from '../../shared/ipc';
import { getDatabase, type Json } from '../services/db';
import { describeSpawnError, log } from '../services/logger';
import { PtyManager } from '../services/ptyManager';
import { ScrollbackStore } from '../services/scrollback';

export interface TerminalIpc {
  manager: PtyManager;
  scrollback: ScrollbackStore;
  endAll: () => void;
}

/**
 * Wires the PTY manager to IPC. Each PTY is owned by the WebContents that created it,
 * so output only goes to that window and PTYs die when the window goes away.
 */
export function registerTerminalIpc(): TerminalIpc {
  const owners = new Map<string, WebContents>();
  /** PTY id -> DB session id, for PTYs bound to a persisted terminal. */
  const sessions = new Map<string, string>();
  const store = new ScrollbackStore(path.join(app.getPath('userData'), 'scrollback'));

  const manager = new PtyManager(
    (event) => {
      if (sessions.has(event.id)) store.append(event.id, event.data);
      const owner = owners.get(event.id);
      if (owner && !owner.isDestroyed()) owner.send(TerminalChannels.data, event);
    },
    (event) => {
      const owner = owners.get(event.id);
      owners.delete(event.id);
      const sessionId = sessions.get(event.id);
      sessions.delete(event.id);
      if (sessionId) {
        store.detach(event.id);
        try {
          getDatabase().endSession(sessionId, event.exitCode);
        } catch (err) {
          log.warn('[terminal] endSession failed:', err);
        }
      }
      const s = getSettings();
      if (s.notifications && !BrowserWindow.getFocusedWindow() && Notification.isSupported())
        new Notification({ title: 'Terminal exited', body: `exit code ${event.exitCode}` }).show();
      if (s.sound) shell.beep();
      if (owner && !owner.isDestroyed()) owner.send(TerminalChannels.exit, event);
    },
  );

  /** Stored output of the terminal's most recent session, or null. */
  const previousScrollback = (terminalId: string): string | null => {
    const prev = getDatabase().latestSession(terminalId);
    return prev?.scrollbackPath ? store.read(prev.scrollbackPath) : null;
  };

  ipcMain.handle(TerminalChannels.create, (e, options: TerminalCreateOptions | undefined) => {
    const opts = sanitizeOptions(options);
    let result;
    try {
      result = manager.create(opts);
    } catch (err) {
      const error = describeSpawnError(opts.shell, err);
      log.error('[terminal] spawn failed:', { shell: opts.shell, args: opts.args, cwd: opts.cwd }, err);
      return { error };
    }
    log.info(`[terminal] spawned ${result.shell} pid=${result.pid} id=${result.id}`);
    owners.set(result.id, e.sender);
    const terminalId = opts.terminalId;
    if (terminalId) {
      try {
        const db = getDatabase();
        const prevSession = db.latestSession(terminalId);
        const prev = prevSession?.scrollbackPath ? store.read(prevSession.scrollbackPath) : null;
        const metadata: Record<string, Json> = {};
        if (opts.resumeCommand) metadata.resumeCommand = opts.resumeCommand;
        const restoredFrom = opts.restoredFrom ?? prevSession?.id;
        if (restoredFrom) metadata.restoredFrom = restoredFrom;
        const sid = db.startSession(terminalId, result.pid, metadata).id;
        sessions.set(result.id, sid);
        // Carry history forward so repeated restarts keep accumulating (ring-capped).
        const seed = prev ? prev + RESTORED_DIVIDER : '';
        db.setSessionScrollback(sid, store.attach(result.id, sid, seed));
      } catch (err) {
        // Terminal row not saved yet (FK) or DB closed: the PTY still works, just untracked.
        log.warn('[terminal] startSession failed:', err);
      }
    }
    e.sender.once('destroyed', () => {
      if (owners.get(result.id) === e.sender) manager.kill(result.id);
    });
    return result;
  });

  ipcMain.handle(TerminalChannels.scrollback, (_e, terminalId: unknown) => {
    if (typeof terminalId !== 'string' || terminalId.length === 0 || terminalId.length > 128) return null;
    try {
      return previousScrollback(terminalId);
    } catch (err) {
      log.warn('[terminal] scrollback read failed:', err);
      return null;
    }
  });

  ipcMain.on(TerminalChannels.write, (e, id: unknown, data: unknown) => {
    if (typeof id !== 'string' || typeof data !== 'string') return;
    if (owners.get(id) !== e.sender) return;
    manager.write(id, data);
  });

  ipcMain.on(TerminalChannels.resize, (e, id: unknown, cols: unknown, rows: unknown) => {
    if (typeof id !== 'string' || typeof cols !== 'number' || typeof rows !== 'number') return;
    if (owners.get(id) !== e.sender) return;
    manager.resize(id, cols, rows);
  });

  ipcMain.handle(TerminalChannels.kill, (e, id: unknown) => {
    if (typeof id !== 'string' || owners.get(id) !== e.sender) return;
    manager.kill(id);
  });

  /**
   * Synchronously closes every tracked session. PTY exit events arrive asynchronously,
   * after the DB is closed on quit, so the quit path must record session ends itself.
   */
  const endAll = (): void => {
    for (const [ptyId, sessionId] of sessions) {
      store.detach(ptyId);
      try {
        getDatabase().endSession(sessionId, null);
      } catch (err) {
        log.warn('[terminal] endSession failed:', err);
      }
    }
    sessions.clear();
  };

  return { manager, scrollback: store, endAll };
}

function sanitizeOptions(raw: unknown): TerminalCreateOptions {
  if (!raw || typeof raw !== 'object') return {};
  const o = raw as Record<string, unknown>;
  const out: TerminalCreateOptions = {};
  if (typeof o.shell === 'string') out.shell = o.shell;
  if (Array.isArray(o.args) && o.args.every((a) => typeof a === 'string')) out.args = o.args as string[];
  if (typeof o.cwd === 'string') out.cwd = o.cwd;
  if (typeof o.cols === 'number') out.cols = o.cols;
  if (typeof o.rows === 'number') out.rows = o.rows;
  if (typeof o.terminalId === 'string' && o.terminalId.length > 0 && o.terminalId.length <= 128) {
    out.terminalId = o.terminalId;
  }
  if (typeof o.resumeCommand === 'string' && o.resumeCommand.length <= 1024) out.resumeCommand = o.resumeCommand;
  if (typeof o.restoredFrom === 'string' && o.restoredFrom.length <= 128) out.restoredFrom = o.restoredFrom;
  if (o.env && typeof o.env === 'object') {
    out.env = Object.fromEntries(
      Object.entries(o.env as Record<string, unknown>).filter(([, v]) => typeof v === 'string'),
    ) as Record<string, string>;
  }
  return out;
}

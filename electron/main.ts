import { app, BrowserWindow, dialog, session, shell } from 'electron';
import path from 'node:path';
import { closeDatabase, openDatabase } from './services/db';
import { registerAgentIpc } from './ipc/agents';
import { registerBrowserIpc } from './ipc/browser';
import { disposeAllGitWatchers, registerGitIpc } from './ipc/git';
import { registerProjectIpc } from './ipc/project';
import { registerRoutingIpc } from './ipc/routing';
import { registerTerminalIpc } from './ipc/terminal';
import { browserEngine } from './services/browserEngine';
import { startBrowserTooling, stopBrowserTooling } from './services/browserTooling';
import { log } from './services/logger';
import { autoUpdater } from 'electron-updater';

const devServerUrl = process.env.VITE_DEV_SERVER_URL;

// Test hook: isolate profile/DB/scrollback. Must run before app is ready.
if (process.env.CREWDECK_USER_DATA) app.setPath('userData', path.resolve(process.env.CREWDECK_USER_DATA));

try {
  log.init(path.join(app.getPath('userData'), 'logs'));
} catch (err) {
  console.error('[app] could not open log file:', err);
}
log.info(
  `[app] crewdeck ${app.getVersion()} starting (electron ${process.versions.electron}, ${process.platform}-${process.arch})`,
);
process.on('uncaughtException', (err) => log.error('[process] uncaughtException:', err));
process.on('unhandledRejection', (reason) => log.error('[process] unhandledRejection:', reason));
app.on('render-process-gone', (_event, _contents, details) => log.error('[renderer] process gone:', details));
app.on('child-process-gone', (_event, details) => log.warn('[child] process gone:', details));

function applyContentSecurityPolicy(): void {
  const csp = devServerUrl
    ? // Vite dev needs inline preamble + HMR websocket.
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:5173 http://localhost:5173"
    : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'";
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
  });
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#0f1115',
    title: 'crewdeck',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Never open new Electron windows from content; send http(s) links to the OS browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (devServerUrl && url.startsWith(devServerUrl)) return;
    event.preventDefault();
  });

  if (devServerUrl) {
    void win.loadURL(devServerUrl);
  } else {
    void win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
  browserEngine.attachWindow(win);
  return win;
}

const { manager: ptys, scrollback, endAll } = registerTerminalIpc();
registerAgentIpc();
registerProjectIpc();
registerRoutingIpc();
registerGitIpc();
registerBrowserIpc();

function initDatabase(): boolean {
  const file = path.join(app.getPath('userData'), 'crewdeck.db');
  try {
    const db = openDatabase(file);
    if (db.appliedMigrations.length) log.info(`[db] migrated to v${db.schemaVersion}`);
    const dangling = db.closeDanglingSessions();
    if (dangling) log.info(`[db] closed ${dangling} dangling session(s)`);
    try {
      const swept = scrollback.sweep(db.liveScrollbackPaths());
      if (swept) log.info(`[scrollback] removed ${swept} stale file(s)`);
    } catch (err) {
      log.warn('[scrollback] sweep failed:', err);
    }
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('[db] open failed:', file, err);
    dialog.showErrorBox('crewdeck: database error', `Could not open ${file}\n\n${message}`);
    return false;
  }
}

app.whenReady().then(() => {
  if (app.isPackaged) autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  if (!initDatabase()) {
    app.exit(1);
    return;
  }
  applyContentSecurityPolicy();
  createWindow();
  startBrowserTooling().catch((err: unknown) => log.error('browser bridge failed to start', err));
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  // Flush first: PTY exit callbacks would otherwise race the final debounced write.
  scrollback.flushAll();
  endAll();
  ptys.killAll();
  disposeAllGitWatchers();
  browserEngine.dispose();
  void stopBrowserTooling();
});
app.on('will-quit', () => closeDatabase());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

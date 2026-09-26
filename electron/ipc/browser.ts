import { BrowserWindow, ipcMain } from 'electron';
import { parseBrowserCommand, type BrowserResult, type BrowserState } from '../../shared/browser';
import { BrowserChannels, type BrowserBridgeInfo } from '../../shared/ipc';
import { browserEngine } from '../services/browserEngine';

function isId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 128;
}

function isRect(v: unknown): v is { x: number; y: number; width: number; height: number } {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (['x', 'y', 'width', 'height'] as const).every(
    (k) => typeof o[k] === 'number' && Number.isFinite(o[k]) && Math.abs(o[k]) < 100_000,
  );
}

let bridgeInfo: (() => BrowserBridgeInfo | null) | null = null;

/** Lets the agent bridge publish its endpoint for the renderer (token is never exposed). */
export function setBrowserBridgeInfo(provider: () => BrowserBridgeInfo | null): void {
  bridgeInfo = provider;
}

export function registerBrowserIpc(): void {
  ipcMain.handle(BrowserChannels.run, async (_e, command: unknown, projectId: unknown): Promise<BrowserResult> => {
    const cmd = parseBrowserCommand(command);
    const state = browserEngine.state();
    const rawAction =
      command && typeof command === 'object' && typeof (command as { action?: unknown }).action === 'string'
        ? String((command as { action: string }).action).slice(0, 32)
        : 'unknown';
    if (!cmd) {
      return { ok: false, action: rawAction as BrowserResult['action'], url: state.url, title: state.title, error: 'invalid command' };
    }
    try {
      return await browserEngine.run(cmd, { projectId: isId(projectId) ? projectId : null, from: 'ui' });
    } catch (err) {
      const s = browserEngine.state();
      return { ok: false, action: cmd.action, url: s.url, title: s.title, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.on(BrowserChannels.setBounds, (_e, bounds: unknown) => {
    if (!isRect(bounds)) return;
    browserEngine.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(0, Math.round(bounds.width)),
      height: Math.max(0, Math.round(bounds.height)),
    });
  });

  ipcMain.on(BrowserChannels.setVisible, (_e, visible: unknown) => {
    if (typeof visible === 'boolean') browserEngine.setVisible(visible);
  });

  ipcMain.handle(BrowserChannels.state, (): BrowserState => browserEngine.state());
  ipcMain.handle(BrowserChannels.bridge, (): BrowserBridgeInfo | null => bridgeInfo?.() ?? null);

  browserEngine.onState((s) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(BrowserChannels.stateChanged, s);
    }
  });
}

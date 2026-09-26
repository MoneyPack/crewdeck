/**
 * crewdeck's agent-drivable browser: a WebContentsView hosted inside the main
 * window and driven over the Chrome DevTools Protocol (webContents.debugger).
 *
 * Agents address elements by snapshot refs (@e1, @e2 …) derived from the
 * accessibility tree; every action resolves a ref to a backend DOM node,
 * computes its box and dispatches trusted input events. Commands run through a
 * single serial queue so concurrent callers (UI, HTTP bridge, MCP) never
 * interleave input.
 */
import { BrowserWindow, WebContentsView, type NativeImage, type Rectangle, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  MAX_BROWSER_TEXT,
  MAX_WAIT_MS,
  MUTATING_ACTIONS,
  buildSnapshot,
  diffSnapshots,
  layoutAnnotations,
  normalizeUrl,
  parseKey,
  parseRef,
  summarizeCommand,
  type AXNode,
  type Box,
  type BrowserCommand,
  type BrowserResult,
  type BrowserState,
  type Snapshot,
} from '../../shared/browser';
import { forwardTempDir } from '../ipc/routing';
import { RoutingChannels } from '../../shared/ipc';
import { getDatabase, type Json } from './db';

export const BROWSER_PARTITION = 'persist:crewdeck-browser';
const CONSOLE_LIMIT = 500;
const SIGNAL_MS = 600;
const ANNOTATE_LIMIT = 120;
const POLL_MS = 150;

export type { BrowserState };

export interface CommandContext {
  /** Project to attribute the routing-log entry to (skipped when absent). */
  projectId?: string | null;
  /** Who issued the command: "ui", "agent", "mcp" … */
  from: string;
}

type Debugger = WebContents['debugger'];
type StateListener = (state: BrowserState) => void;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clip(text: string): string {
  return text.length > MAX_BROWSER_TEXT ? `${text.slice(0, MAX_BROWSER_TEXT)}\n… (truncated)` : text;
}

function quadCenter(quad: readonly number[]): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (let i = 0; i < 8; i += 2) {
    x += quad[i]!;
    y += quad[i + 1]!;
  }
  return { x: x / 4, y: y / 4 };
}

function quadBox(quad: readonly number[]): Box {
  const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!];
  const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function isNavigable(url: string): boolean {
  return /^(https?:|about:blank$|data:)/i.test(url);
}

export class BrowserEngine {
  private view: WebContentsView | null = null;
  private win: BrowserWindow | null = null;
  private bounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 };
  private visible = false;
  private snapshot: Snapshot | null = null;
  private consoleLines: string[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<StateListener>();
  private ready: Promise<void> | null = null;

  /** Bind to the host window. The view is created lazily on first use. */
  attachWindow(win: BrowserWindow): void {
    this.win = win;
    win.on('closed', () => this.dispose());
  }

  onState(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  state(): BrowserState {
    const wc = this.view?.webContents;
    const alive = wc && !wc.isDestroyed();
    return {
      url: alive ? wc.getURL() : '',
      title: alive ? wc.getTitle() : '',
      loading: alive ? wc.isLoading() : false,
      canGoBack: alive ? wc.navigationHistory.canGoBack() : false,
      canGoForward: alive ? wc.navigationHistory.canGoForward() : false,
      visible: this.visible,
    };
  }

  /** Position the native view (window content coordinates, DIP). */
  setBounds(rect: Rectangle): void {
    this.bounds = {
      x: Math.max(0, Math.round(rect.x)),
      y: Math.max(0, Math.round(rect.y)),
      width: Math.max(0, Math.round(rect.width)),
      height: Math.max(0, Math.round(rect.height)),
    };
    this.view?.setBounds(this.bounds);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible) this.ensureView();
    this.view?.setVisible(visible && this.bounds.width > 0 && this.bounds.height > 0);
    this.emit();
  }

  /** Run a command through the serial queue and log it. */
  run(cmd: BrowserCommand, ctx: CommandContext): Promise<BrowserResult> {
    const task = this.queue.then(() => this.execute(cmd, ctx));
    this.queue = task.catch(() => undefined);
    return task;
  }

  dispose(): void {
    const view = this.view;
    this.view = null;
    this.snapshot = null;
    this.ready = null;
    if (!view) return;
    try {
      if (this.win && !this.win.isDestroyed()) this.win.contentView.removeChildView(view);
    } catch {
      /* window already gone */
    }
    const wc = view.webContents;
    if (!wc.isDestroyed()) {
      try {
        if (wc.debugger.isAttached()) wc.debugger.detach();
      } catch {
        /* ignore */
      }
      wc.close();
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  private emit(): void {
    const s = this.state();
    for (const l of this.listeners) l(s);
  }

  private ensureView(): WebContentsView {
    if (this.view && !this.view.webContents.isDestroyed()) return this.view;
    const win = this.win;
    if (!win || win.isDestroyed()) throw new Error('browser host window is not available');

    const view = new WebContentsView({
      webPreferences: {
        partition: BROWSER_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });
    view.setBackgroundColor('#ffffff');
    const wc = view.webContents;
    const ses = wc.session;
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
    ses.on('will-download', (event) => event.preventDefault());

    wc.setWindowOpenHandler(({ url }) => {
      if (isNavigable(url)) void wc.loadURL(url);
      return { action: 'deny' };
    });
    wc.on('will-navigate', (event, url) => {
      if (!isNavigable(url)) event.preventDefault();
    });
    for (const ev of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading'] as const) {
      wc.on(ev as 'did-stop-loading', () => {
        if (ev === 'did-navigate') this.snapshot = null;
        this.emit();
      });
    }

    this.attachDebugger(wc.debugger);
    win.contentView.addChildView(view);
    view.setBounds(this.bounds);
    view.setVisible(false);
    this.view = view;
    this.ready = wc.loadURL('about:blank').then(() => undefined, () => undefined);
    return view;
  }

  private attachDebugger(dbg: Debugger): void {
    dbg.attach('1.3');
    dbg.on('message', (_event, method, params: Record<string, unknown>) => this.onCdpEvent(method, params));
    dbg.on('detach', () => {
      this.snapshot = null;
    });
    for (const domain of ['Page.enable', 'Runtime.enable', 'Log.enable', 'DOM.enable', 'Accessibility.enable']) {
      dbg.sendCommand(domain).catch(() => undefined);
    }
  }

  private onCdpEvent(method: string, params: Record<string, unknown>): void {
    if (method === 'Runtime.consoleAPICalled') {
      const args = (params.args as Array<{ value?: unknown; description?: string; type?: string }> | undefined) ?? [];
      const text = args
        .map((a) => (a.value !== undefined ? (typeof a.value === 'string' ? a.value : JSON.stringify(a.value)) : (a.description ?? a.type ?? '')))
        .join(' ');
      this.pushConsole(String(params.type ?? 'log'), text);
    } else if (method === 'Runtime.exceptionThrown') {
      const d = params.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
      this.pushConsole('exception', d?.exception?.description ?? d?.text ?? 'uncaught exception');
    } else if (method === 'Log.entryAdded') {
      const e = params.entry as { level?: string; text?: string; url?: string } | undefined;
      if (e) this.pushConsole(e.level ?? 'log', e.url ? `${e.text ?? ''} (${e.url})` : (e.text ?? ''));
    }
  }

  private pushConsole(level: string, text: string): void {
    this.consoleLines.push(`[${level}] ${text}`);
    if (this.consoleLines.length > CONSOLE_LIMIT) this.consoleLines.splice(0, this.consoleLines.length - CONSOLE_LIMIT);
  }

  private wc(): WebContents {
    return this.ensureView().webContents;
  }

  private send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>, timeoutMs = 10_000): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`CDP ${method} timed out`)), timeoutMs);
    });
    return (Promise.race([this.wc().debugger.sendCommand(method, params), timeout]) as Promise<T>).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  private async takeSnapshot(interactiveOnly: boolean): Promise<Snapshot> {
    const { nodes } = await this.send<{ nodes: AXNode[] }>('Accessibility.getFullAXTree');
    const snap = buildSnapshot(nodes, { interactiveOnly });
    this.snapshot = snap;
    return snap;
  }

  private async resolveRef(ref: string): Promise<number> {
    const id = parseRef(ref);
    if (!id) throw new Error(`invalid ref "${ref}"`);
    if (!this.snapshot) await this.takeSnapshot(false);
    const entry = this.snapshot?.refs[id];
    if (!entry) throw new Error(`unknown ref @${id}; take a fresh snapshot`);
    return entry.backendNodeId;
  }

  private async nodeCenter(backendNodeId: number): Promise<{ x: number; y: number }> {
    await this.send('DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => undefined);
    const { model } = await this.send<{ model: { content: number[]; border: number[] } }>('DOM.getBoxModel', { backendNodeId });
    return quadCenter(model.border.length === 8 ? model.border : model.content);
  }

  private async callOn(backendNodeId: number, fn: string): Promise<void> {
    const { object } = await this.send<{ object: { objectId?: string } }>('DOM.resolveNode', { backendNodeId });
    if (!object.objectId) return;
    await this.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: fn, silent: true });
    await this.send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => undefined);
  }

  private async callOnValue<T>(backendNodeId: number, fn: string, args: Json[] = []): Promise<T | undefined> {
    const { object } = await this.send<{ object: { objectId?: string } }>('DOM.resolveNode', { backendNodeId });
    if (!object.objectId) return undefined;
    try {
      const { result } = await this.send<{ result: { value?: T } }>('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: fn,
        arguments: args.map((value) => ({ value })),
        returnByValue: true,
        silent: true
      });
      return result.value;
    } finally {
      await this.send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => undefined);
    }
  }

  /** Brief --signal outline so a watching human sees what the agent touched. */
  private signal(backendNodeId: number): void {
    const fn = `function(){var s=this.style;if(!s)return;var o=s.outline,f=s.outlineOffset;s.outline='2px solid #ff4d00';s.outlineOffset='2px';setTimeout(function(){s.outline=o;s.outlineOffset=f},${SIGNAL_MS})}`;
    this.callOn(backendNodeId, fn).catch(() => undefined);
  }

  private async mouse(type: string, x: number, y: number, extra: Record<string, unknown> = {}): Promise<void> {
    await this.send('Input.dispatchMouseEvent', { type, x, y, ...extra });
  }

  private async evaluate<T>(expression: string): Promise<T | undefined> {
    const { result } = await this.send<{ result: { value?: T } }>('Runtime.evaluate', { expression, returnByValue: true, silent: true });
    return result.value;
  }

  private async waitForLoad(timeoutMs: number): Promise<void> {
    const wc = this.wc();
    const deadline = Date.now() + timeoutMs;
    await sleep(50);
    while (wc.isLoading() && Date.now() < deadline) await sleep(POLL_MS);
  }

  private async viewport(): Promise<{ width: number; height: number; contentWidth: number; contentHeight: number }> {
    const m = await this.send<{
      cssLayoutViewport: { clientWidth: number; clientHeight: number };
      cssContentSize: { width: number; height: number };
    }>('Page.getLayoutMetrics');
    return {
      width: m.cssLayoutViewport.clientWidth,
      height: m.cssLayoutViewport.clientHeight,
      contentWidth: Math.ceil(m.cssContentSize.width),
      contentHeight: Math.ceil(m.cssContentSize.height),
    };
  }

  private async screenshot(fullPage: boolean, annotate: boolean): Promise<{ file: string; legend: string }> {
    const view = this.ensureView();
    const hidden = !this.visible || this.bounds.width <= 0 || this.bounds.height <= 0;
    if (hidden) {
      view.setBounds({ x: 0, y: 0, width: 1280, height: 800 });
      view.setVisible(true);
    }
    const host = this.win;
    if (host && !host.isDestroyed()) {
      if (host.isMinimized()) host.restore();
      if (!host.isVisible()) host.showInactive();
      host.contentView.addChildView(view);
    }
    if (!view.webContents.isDestroyed()) view.webContents.invalidate();
    await this.send('Page.bringToFront').catch(() => undefined);
    await this.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined);
    await this.waitForPaint();
    try {
      return await this.captureShot(fullPage, annotate);
    } finally {
      if (hidden && !view.webContents.isDestroyed()) {
        view.setBounds(this.bounds);
        view.setVisible(this.visible && this.bounds.width > 0 && this.bounds.height > 0);
      }
    }
  }

  private async waitForPaint(timeoutMs = 1_500): Promise<void> {
    const wc = this.wc();
    if (wc.isDestroyed()) return;
    wc.invalidate();
    await Promise.race([
      wc
        .executeJavaScript('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))', true)
        .catch(() => undefined),
      sleep(timeoutMs),
    ]);
  }

  /** Fallback when the on-screen view refuses to paint (occluded/hidden host): re-render the page in an offscreen window. */
  private async offscreenCapture(params: NonNullable<Parameters<BrowserEngine['send']>[1]>): Promise<Buffer> {
    const live = this.wc();
    const url = live.getURL() || 'about:blank';
    if (!isNavigable(url)) throw new Error('offscreen: url not navigable');
    const overlay = String(
      (await live
        .executeJavaScript("(() => { const n = document.getElementById('__crewdeck_annot'); return n ? n.outerHTML : ''; })()", true)
        .catch(() => '')) ?? '',
    );
    const scroll = ((await live.executeJavaScript('[window.scrollX, window.scrollY]', true).catch(() => [0, 0])) ?? [0, 0]) as [number, number];
    const b = this.view?.getBounds();
    const clip = (params as { clip?: { x?: number; y?: number; width?: number; height?: number } }).clip;
    const width = Math.max(320, Math.round(clip?.width ?? (b && b.width > 0 ? b.width : 1280)));
    const height = Math.max(200, Math.min(16_384, Math.round(clip?.height ?? (b && b.height > 0 ? b.height : 800))));
    const sx = Math.round(clip?.x ?? scroll[0] ?? 0);
    const sy = Math.round(clip?.y ?? scroll[1] ?? 0);
    const isPng = (buf: Buffer): boolean =>
      buf.length > 100 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const timeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(what + ' timed out')), ms);
        p.then(
          (v) => { clearTimeout(t); resolve(v); },
          (e: unknown) => { clearTimeout(t); reject(e instanceof Error ? e : new Error(String(e))); },
        );
      });
    const win = new BrowserWindow({
      show: false,
      width,
      height,
      useContentSize: true,
      paintWhenInitiallyHidden: true,
      backgroundColor: '#ffffff',
      webPreferences: {
        offscreen: true,
        partition: BROWSER_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        spellcheck: false,
      },
    });
    try {
      const wc = win.webContents;
      wc.setWindowOpenHandler(() => ({ action: 'deny' }));
      wc.on('will-navigate', (e) => e.preventDefault());
      let latest: NativeImage | undefined;
      wc.on('paint', (_e, _dirty, image: NativeImage) => {
        if (!image.isEmpty()) latest = image;
      });
      wc.setFrameRate(30);
      await timeout(wc.loadURL(url), 8_000, 'offscreen load');
      await wc
        .executeJavaScript(
          `(() => { ${overlay ? `document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(overlay)});` : ''} window.scrollTo(${sx}, ${sy}); return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))); })()`,
          true,
        )
        .catch(() => undefined);
      const deadline = Date.now() + 4_000;
      const errs: string[] = [];
      while (Date.now() < deadline) {
        wc.invalidate();
        await new Promise((r) => setTimeout(r, 150));
        if (latest) {
          const buf = latest.toPNG();
          if (isPng(buf)) return buf;
        }
        const shot = await timeout(wc.capturePage(), 2_000, 'offscreen capturePage').catch((e: unknown) => {
          errs.push((e as Error).message);
          return undefined;
        });
        if (shot && !shot.isEmpty()) {
          const buf = shot.toPNG();
          if (isPng(buf)) return buf;
        }
      }
      throw new Error('no frame' + (errs.length ? ' (' + errs[errs.length - 1] + ')' : ''));
    } finally {
      if (!win.isDestroyed()) win.destroy();
    }
  }


  private async capturePng(params: NonNullable<Parameters<BrowserEngine['send']>[1]>): Promise<{ png: Buffer; via: string }> {
    const errors: string[] = [];
    const valid = (buf: Buffer): boolean =>
      buf.length > 100 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    const fullPage = Boolean((params as { captureBeyondViewport?: boolean }).captureBeyondViewport);
    // Hard ceiling for the whole capture so callers (bridge/CLI/MCP) never hang.
    const deadline = Date.now() + 10_000;
    const remaining = (): number => deadline - Date.now();
    const bounded = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(what + ' timed out')), Math.max(1, ms));
        p.then(
          (v) => { clearTimeout(timer); resolve(v); },
          (e: unknown) => { clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))); },
        );
      });
    const tryCdp = async (label: string, ms: number): Promise<Buffer | null> => {
      try {
        const res = await this.send<{ data: string }>('Page.captureScreenshot', params, Math.max(250, ms));
        const buf = Buffer.from(res.data ?? '', 'base64');
        if (valid(buf)) return buf;
        errors.push(label + ': invalid image (' + buf.length + 'B)');
      } catch (err) {
        errors.push(label + ': ' + (err instanceof Error ? err.message : String(err)));
      }
      return null;
    };
    const tryNative = async (label: string, ms: number): Promise<Buffer | null> => {
      const wc = this.wc();
      if (!wc || wc.isDestroyed()) {
        errors.push(label + ': webContents destroyed');
        return null;
      }
      try {
        const img = await bounded(wc.capturePage(), ms, 'capturePage');
        const buf = img.isEmpty() ? Buffer.alloc(0) : img.toPNG();
        if (valid(buf)) return buf;
        errors.push(label + ': invalid image (' + buf.length + 'B)');
      } catch (err) {
        errors.push(label + ': ' + (err instanceof Error ? err.message : String(err)));
      }
      return null;
    };
    // First valid PNG wins; resolves null only once every contender failed.
    const firstValid = (contenders: Array<Promise<{ png: Buffer | null; via: string }>>): Promise<{ png: Buffer; via: string } | null> =>
      new Promise((resolve) => {
        let pending = contenders.length;
        for (const c of contenders) {
          void c.then((r) => {
            pending -= 1;
            if (r.png) resolve({ png: r.png, via: r.via });
            else if (pending === 0) resolve(null);
          });
        }
      });

    for (let attempt = 1; attempt <= 4 && remaining() > 400; attempt += 1) {
      const budget = Math.min(3_000 + 1_000 * (attempt - 1), remaining());
      if (!fullPage) {
        const won = await firstValid([
          tryCdp('cdp#' + attempt, budget).then((png) => ({ png, via: 'cdp' })),
          tryNative('native#' + attempt, budget).then((png) => ({ png, via: 'native' })),
        ]);
        if (won) return won;
      } else {
        const cdp = await tryCdp('cdp#' + attempt, budget);
        if (cdp) return { png: cdp, via: 'cdp' };
        if (remaining() > 400) {
          const native = await tryNative('native#' + attempt, Math.min(3_000, remaining()));
          if (native) return { png: native, via: 'native' };
        }
      }
      if (remaining() > 900) {
        await sleep(100 * attempt);
        await this.waitForPaint(Math.min(800, Math.max(100, remaining() - 500)));
      }
    }
    if (errors.length === 0) errors.push('deadline exceeded before any attempt');
    throw new Error('screenshot failed: ' + errors.join('; '));
  }

  private async captureShot(fullPage: boolean, annotate: boolean): Promise<{ file: string; legend: string }> {
    const vp = await this.viewport();
    let legend = '';
    if (annotate) {
      const snap = await this.takeSnapshot(true);
      const targets: Array<{ ref: string; box: Box }> = [];
      const lines: string[] = [];
      for (const entry of Object.values(snap.refs)) {
        if (targets.length >= ANNOTATE_LIMIT) break;
        try {
          const { model } = await this.send<{ model: { border: number[] } }>('DOM.getBoxModel', { backendNodeId: entry.backendNodeId });
          const box = quadBox(model.border);
          if (box.width < 1 || box.height < 1) continue;
          if (!fullPage && (box.y + box.height < 0 || box.y > vp.height || box.x + box.width < 0 || box.x > vp.width)) continue;
          targets.push({ ref: entry.ref, box });
          lines.push(`@${entry.ref} ${entry.role}${entry.name ? ` "${entry.name}"` : ''}`);
        } catch {
          /* node without layout */
        }
      }
      const notes = layoutAnnotations(targets, { width: fullPage ? vp.contentWidth : vp.width, height: fullPage ? vp.contentHeight : vp.height });
      const payload = JSON.stringify(notes);
      await this.evaluate(`(function(){var n=${payload};var sx=window.scrollX,sy=window.scrollY;var root=document.createElement('div');root.id='__crewdeck_annot';root.style.cssText='position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none';n.forEach(function(a){var b=document.createElement('div');b.style.cssText='position:absolute;box-sizing:border-box;border:2px solid #ff4d00;left:'+(a.box.x+sx)+'px;top:'+(a.box.y+sy)+'px;width:'+a.box.width+'px;height:'+a.box.height+'px';var l=document.createElement('div');l.textContent=a.label.text;l.style.cssText='position:absolute;font:600 11px/14px monospace;padding:0 3px;background:#ff4d00;color:#0b0b0b;left:'+(a.label.x+sx)+'px;top:'+(a.label.y+sy)+'px;height:'+a.label.height+'px';root.appendChild(b);root.appendChild(l);});document.documentElement.appendChild(root);return n.length})()`);
      legend = lines.join('\n');
    }
    try {
      const params: Record<string, unknown> = { format: 'png' };
      if (fullPage) {
        params.captureBeyondViewport = true;
        params.clip = { x: 0, y: 0, width: Math.max(1, vp.contentWidth), height: Math.max(1, Math.min(vp.contentHeight, 16_384)), scale: 1 };
      }
      let png: Buffer;
      try {
        ({ png } = await this.capturePng(params));
      } catch (err) {
        try {
          png = await this.offscreenCapture(params);
        } catch (err2) {
          throw new Error(`${(err as Error).message}; offscreen: ${(err2 as Error).message}`);
        }
      }
      const dir = path.join(forwardTempDir(), 'shots');
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}.png`);
      writeFileSync(file, png, { mode: 0o600 });
      return { file, legend };
    } finally {
      if (annotate) await this.evaluate(`(function(){var r=document.getElementById('__crewdeck_annot');if(r)r.remove()})()`).catch(() => undefined);
    }
  }

  private async execute(cmd: BrowserCommand, ctx: CommandContext): Promise<BrowserResult> {
    let result: BrowserResult;
    try {
      const mutating = MUTATING_ACTIONS.has(cmd.action);
      const before = mutating ? (this.snapshot ?? (await this.takeSnapshot(false))).text : null;
      const partial = await this.dispatch(cmd);
      if (before !== null) {
        await sleep(120);
        await this.waitForLoad(5_000);
        const after = await this.takeSnapshot(false);
        const d = diffSnapshots(before, after.text);
        partial.diff = d.changed ? clip(d.text) : 'no change';
      }
      const s = this.state();
      result = { ok: true, action: cmd.action, url: s.url, title: s.title, ...partial };
      if (result.text !== undefined) result.text = clip(result.text);
    } catch (err) {
      const s = this.state();
      result = { ok: false, action: cmd.action, url: s.url, title: s.title, error: err instanceof Error ? err.message : String(err) };
    }
    this.log(cmd, ctx, result);
    this.emit();
    return result;
  }

  private async dispatch(cmd: BrowserCommand): Promise<Omit<BrowserResult, 'ok' | 'action' | 'url' | 'title'>> {
    switch (cmd.action) {
      case 'open': {
        const url = normalizeUrl(cmd.url);
        if (!url) throw new Error(`refusing to open "${cmd.url}"`);
        this.wc();
        if (this.ready) await this.ready;
        this.snapshot = null;
        await this.wc().loadURL(url).catch((e: unknown) => {
          // ERR_ABORTED fires on redirects / in-page navigations; not fatal.
          if (!(e instanceof Error) || !/ERR_ABORTED/.test(e.message)) throw e;
        });
        await this.waitForLoad(10_000).catch(() => undefined);
        if (this.wc().getURL() === 'about:blank' && url !== 'about:blank') {
          await this.wc().loadURL(url).catch((e: unknown) => {
            if (!/ERR_ABORTED/.test(String(e))) throw e;
          });
          await this.waitForLoad(10_000).catch(() => undefined);
          if (this.wc().getURL() === 'about:blank') throw new Error(`open failed: ${cmd.url}`);
        }
        return { text: `opened ${this.wc().getURL()}` };
      }
      case 'back':
      case 'forward': {
        const hist = this.wc().navigationHistory;
        const can = cmd.action === 'back' ? hist.canGoBack() : hist.canGoForward();
        if (!can) throw new Error(`cannot go ${cmd.action}`);
        this.snapshot = null;
        if (cmd.action === 'back') hist.goBack();
        else hist.goForward();
        await this.waitForLoad(10_000);
        return {};
      }
      case 'reload':
        this.snapshot = null;
        this.wc().reload();
        await this.waitForLoad(15_000);
        return {};
      case 'snapshot': {
        const snap = await this.takeSnapshot(cmd.interactiveOnly);
        return { text: snap.text || '(empty page)' };
      }
      case 'click': {
        const id = await this.resolveRef(cmd.ref);
        const { x, y } = await this.nodeCenter(id);
        this.signal(id);
        const hit = await this.callOnValue<boolean>(
          id,
          'function(x,y){var el=document.elementFromPoint(x,y);return !!el&&(el===this||this.contains(el))}',
          [x, y],
        );
        if (!hit) {
          await this.callOn(id, 'function(){this.click()}');
          return { text: `clicked @${parseRef(cmd.ref)} (dom)` };
        }
        await this.mouse('mouseMoved', x, y);
        await this.mouse('mousePressed', x, y, { button: 'left', buttons: 1, clickCount: 1 });
        await this.mouse('mouseReleased', x, y, { button: 'left', buttons: 0, clickCount: 1 });
        return { text: `clicked @${parseRef(cmd.ref)}` };
      }
      case 'fill': {
        const id = await this.resolveRef(cmd.ref);
        await this.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: id }).catch(() => undefined);
        await this.send('DOM.focus', { backendNodeId: id });
        this.signal(id);
        await this.callOn(
          id,
          `function(){if('value' in this){this.value='';this.dispatchEvent(new Event('input',{bubbles:true}))}else if(this.isContentEditable){this.textContent=''}}`,
        );
        if (cmd.text) await this.send('Input.insertText', { text: cmd.text });
        await this.callOn(id, `function(){this.dispatchEvent(new Event('change',{bubbles:true}))}`);
        return { text: `filled @${parseRef(cmd.ref)} (${cmd.text.length} chars)` };
      }
      case 'type':
        await this.send('Input.insertText', { text: cmd.text });
        return { text: `typed ${cmd.text.length} chars` };
      case 'press': {
        const k = parseKey(cmd.key);
        if (!k) throw new Error(`unknown key "${cmd.key}"`);
        const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers: k.modifiers };
        await this.send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...base, ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}) });
        await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
        return { text: `pressed ${cmd.key}` };
      }
      case 'hover': {
        const id = await this.resolveRef(cmd.ref);
        const { x, y } = await this.nodeCenter(id);
        this.signal(id);
        await this.mouse('mouseMoved', x, y);
        return { text: `hovering @${parseRef(cmd.ref)}` };
      }
      case 'scroll': {
        let point: { x: number; y: number };
        if (cmd.ref) {
          point = await this.nodeCenter(await this.resolveRef(cmd.ref));
        } else {
          const vp = await this.viewport();
          point = { x: vp.width / 2, y: vp.height / 2 };
        }
        await this.mouse('mouseWheel', point.x, point.y, { deltaX: cmd.dx, deltaY: cmd.dy });
        await sleep(80);
        this.snapshot = null;
        return { text: `scrolled ${cmd.dx},${cmd.dy}` };
      }
      case 'wait': {
        const timeout = Math.min(Math.max(0, cmd.timeoutMs), MAX_WAIT_MS);
        const deadline = Date.now() + timeout;
        if (cmd.text === null && cmd.ref === null) {
          await this.waitForLoad(timeout);
          return { text: 'page settled' };
        }
        const refId = cmd.ref !== null ? parseRef(cmd.ref) : null;
        if (cmd.ref !== null && !refId) throw new Error(`invalid ref "${cmd.ref}"`);
        const needle = JSON.stringify(cmd.text ?? '');
        for (;;) {
          if (cmd.text !== null) {
            const found = await this.evaluate<boolean>(`!!(document.body&&document.body.innerText.includes(${needle}))`).catch(() => false);
            if (found) return { text: `found text ${needle}` };
          } else if (refId) {
            const snap = await this.takeSnapshot(false).catch(() => null);
            if (snap?.refs[refId]) return { text: `found @${refId}` };
          }
          if (Date.now() >= deadline) throw new Error(`timed out after ${timeout}ms`);
          await sleep(POLL_MS * 2);
        }
      }
      case 'screenshot': {
        const { file, legend } = await this.screenshot(cmd.fullPage, cmd.annotate);
        return { screenshotPath: file, text: legend ? `${file}\n${legend}` : file };
      }
      case 'console': {
        const text = this.consoleLines.join('\n') || '(no console output)';
        if (cmd.clear) this.consoleLines = [];
        return { text };
      }
      case 'status': {
        const s = this.state();
        return {
          text: `url=${s.url || '-'}\ntitle=${s.title || '-'}\nloading=${s.loading}\nvisible=${s.visible}\nrefs=${this.snapshot?.count ?? 0}\nconsole=${this.consoleLines.length}`,
        };
      }
    }
  }

  private log(cmd: BrowserCommand, ctx: CommandContext, result: BrowserResult): void {
    if (!ctx.projectId) return;
    try {
      const preview = `${summarizeCommand(cmd)}${result.ok ? '' : ` ✗ ${result.error ?? ''}`}`;
      const entry = getDatabase().logRoute(ctx.projectId, {
        kind: 'browser',
        fromLabel: ctx.from,
        targets: [result.url || 'about:blank'],
        preview,
        bytes: Buffer.byteLength(preview),
      });
      if (entry) {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) win.webContents.send(RoutingChannels.appended, entry);
        }
      }
    } catch {
      /* logging must never break a browser action */
    }
  }
}

export const browserEngine = new BrowserEngine();

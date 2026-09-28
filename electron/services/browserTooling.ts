/**
 * Glue between the agent browser bridge and crewdeck terminals.
 *
 * Starts the loopback HTTP bridge, writes per-process `crewdeck-browser` /
 * `crewdeck-mcp` shims (run through Electron-as-Node, so no system Node is
 * required), and injects the bridge URL + token into every new PTY.
 */
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { setBrowserBridgeInfo } from '../ipc/browser';
import { forwardTempDir } from '../ipc/routing';
import { startBrowserBridge, type BridgeHandle } from './browserBridge';
import { setExtraPtyEnv } from './ptyManager';

let bridge: BridgeHandle | null = null;
let shimDir: string | null = null;

function toolPath(file: string): string {
  const p = path.join(__dirname, 'cli', file);
  return app.isPackaged ? p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`) : p;
}

function writeShims(dir: string, name: string, script: string): void {
  const exe = process.execPath;
  const cmd = ['@echo off', 'setlocal', 'set ELECTRON_RUN_AS_NODE=1', `"${exe}" "${script}" %*`, ''].join('\r\n');
  const sh = [
    '#!/bin/sh',
    `ELECTRON_RUN_AS_NODE=1 exec "${exe.replace(/\\/g, '/')}" "${script.replace(/\\/g, '/')}" "$@"`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, `${name}.cmd`), cmd);
  fs.writeFileSync(path.join(dir, name), sh, { mode: 0o755 });
}

export async function startBrowserTooling(): Promise<void> {
  bridge = await startBrowserBridge();
  const cliPath = toolPath('crewdeck-browser.cjs');
  const mcpPath = toolPath('crewdeck-mcp.cjs');

  shimDir = path.join(forwardTempDir(), 'bin', String(process.pid));
  fs.mkdirSync(shimDir, { recursive: true });
  writeShims(shimDir, 'crewdeck-browser', cliPath);
  writeShims(shimDir, 'crewdeck-mcp', mcpPath);

  setExtraPtyEnv({ CREWDECK_BROWSER_URL: bridge.url, CREWDECK_BROWSER_TOKEN: bridge.token }, shimDir);
  const bridgeUrl = bridge.url;
  bridge.onRotate((t) => {
    setExtraPtyEnv({ CREWDECK_BROWSER_URL: bridgeUrl, CREWDECK_BROWSER_TOKEN: t }, shimDir);
    const hook = (globalThis as unknown as { __crewdeckBridge?: { token: string } }).__crewdeckBridge;
    if (hook) hook.token = t;
  });
  const url = bridge.url;
  setBrowserBridgeInfo(() => ({ url, cliPath, mcpPath }));
  // Test-only hook: exposes the bridge to Playwright's main-process evaluate. Never set in production.
  if (process.env.CREWDECK_E2E_BRIDGE === '1') {
    (globalThis as Record<string, unknown>).__crewdeckBridge = { url, token: bridge.token };
  }
}

export async function stopBrowserTooling(): Promise<void> {
  setBrowserBridgeInfo(() => null);
  delete (globalThis as Record<string, unknown>).__crewdeckBridge;
  const b = bridge;
  bridge = null;
  if (shimDir) {
    try {
      fs.rmSync(shimDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    shimDir = null;
  }
  await b?.close();
}

import { ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RoutingChannels, type RouteLogEntry } from '../../shared/ipc';
import { parseRouteInput } from '../../shared/routeLog';
import { getDatabase } from '../services/db';

/** Hard cap on a single forwarded payload written to disk. */
const MAX_TEMP_BYTES = 8 * 1024 * 1024;

export function forwardTempDir(): string {
  return path.join(os.tmpdir(), 'crewdeck');
}

/** Writes `text` to a fresh file under the crewdeck temp dir and returns its path. */
export function writeForwardTemp(text: string, dir = forwardTempDir()): string {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  if (Buffer.byteLength(text, 'utf8') > MAX_TEMP_BYTES) throw new RangeError('payload too large');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${randomUUID()}.txt`);
  writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
  return file;
}

function isId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 128;
}

export function registerRoutingIpc(): void {
  ipcMain.handle(RoutingChannels.writeTemp, (_e, text: unknown) => writeForwardTemp(text as string));

  ipcMain.handle(RoutingChannels.log, (_e, projectId: unknown, input: unknown): RouteLogEntry | null => {
    const parsed = parseRouteInput(input);
    if (!isId(projectId) || !parsed) return null;
    try {
      return getDatabase().logRoute(projectId, parsed);
    } catch {
      return null; // unknown project (FK) etc. — logging must never break routing
    }
  });

  ipcMain.handle(RoutingChannels.list, (_e, projectId: unknown): RouteLogEntry[] =>
    isId(projectId) ? getDatabase().listRoutes(projectId) : [],
  );
}

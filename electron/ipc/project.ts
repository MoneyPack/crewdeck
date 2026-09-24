import fs from 'node:fs';
import path from 'node:path';
import { BrowserWindow, dialog, ipcMain } from 'electron';
import { AGENT_PROFILES, type AgentId } from '../../shared/agents';
import {
  ProjectChannels,
  type PersistedLayout,
  type PersistedTerminal,
  type ProjectInfo,
  type RestoreResult,
} from '../../shared/ipc';
import { getDatabase, type Json } from '../services/db';

const AGENT_IDS = new Set<string>(AGENT_PROFILES.map((p) => p.id));
const MAX_TERMINALS = 64;
const MAX_TEXT = 4096;

export function registerProjectIpc(): void {
  ipcMain.handle(ProjectChannels.select, async (e): Promise<ProjectInfo | null> => {
    const win = BrowserWindow.fromWebContents(e.sender);
    let selected: string | undefined;
    // Test hook: native dialogs can't be driven over CDP. Only honoured for an existing folder.
    const testPath = process.env.CREWDECK_TEST_PROJECT;
    if (testPath && isDirectory(testPath)) {
      selected = path.resolve(testPath);
    } else {
      const options: Electron.OpenDialogOptions = {
        title: 'Open project folder',
        properties: ['openDirectory'],
      };
      const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      if (result.canceled) return null;
      selected = result.filePaths[0];
    }
    if (!selected) return null;
    const name = path.basename(selected) || selected;
    const row = getDatabase().openProject(selected, name);
    win?.setTitle(`crewdeck — ${row.name}`);
    return { id: row.id, path: row.path, name: row.name };
  });

  ipcMain.handle(ProjectChannels.restore, (e): RestoreResult | null => {
    const db = getDatabase();
    const row = db.getLastProject();
    if (!row) return null;
    // A project whose folder vanished is not restored; the user picks a new one.
    if (!isDirectory(row.path)) return null;
    // Bump last_opened_at so the restored project stays "last".
    db.openProject(row.path, row.name);

    const terminals: PersistedTerminal[] = db.listTerminals(row.id).map((t) => ({
      id: t.id,
      title: t.title,
      profileId: t.profileId,
      cwd: isDirectory(t.cwd) ? t.cwd : row.path,
    }));
    const layout = parseLayout(row.layout, new Set(terminals.map((t) => t.id)));

    BrowserWindow.fromWebContents(e.sender)?.setTitle(`crewdeck — ${row.name}`);
    return { project: { id: row.id, path: row.path, name: row.name }, layout, terminals };
  });

  ipcMain.handle(ProjectChannels.saveLayout, (_e, projectId: unknown, layout: unknown): void => {
    if (!isId(projectId)) return;
    const parsed = parseLayout(layout, null);
    if (!parsed) return;
    getDatabase().saveProjectLayout(projectId, parsed as unknown as Record<string, Json>);
  });

  ipcMain.handle(ProjectChannels.saveTerminals, (_e, projectId: unknown, terminals: unknown): void => {
    if (!isId(projectId) || !Array.isArray(terminals) || terminals.length > MAX_TERMINALS) return;
    const clean: PersistedTerminal[] = [];
    for (const raw of terminals) {
      const t = parseTerminal(raw);
      if (!t) return; // reject the whole batch rather than silently dropping terminals
      clean.push(t);
    }
    getDatabase().saveTerminals(projectId, clean);
  });
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 128;
}

function isText(v: unknown): v is string {
  return typeof v === 'string' && v.length <= MAX_TEXT;
}

function parseTerminal(raw: unknown): PersistedTerminal | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!isId(o.id) || !isText(o.title) || !isText(o.cwd)) return null;
  if (typeof o.profileId !== 'string' || !AGENT_IDS.has(o.profileId)) return null;
  return { id: o.id, title: o.title, profileId: o.profileId as AgentId, cwd: o.cwd };
}

/**
 * Validates a layout blob. When `known` is given, slot ids not in the set are cleared
 * (terminals deleted since the layout was saved).
 */
function parseLayout(raw: unknown, known: Set<string> | null): PersistedLayout | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const size = o.layout;
  if (size !== 1 && size !== 2 && size !== 4) return null;
  if (!Array.isArray(o.slots) || o.slots.length > 16) return null;
  const slots = o.slots.map((s) => (isId(s) && (!known || known.has(s)) ? s : null));
  const active = typeof o.activeSlot === 'number' && Number.isInteger(o.activeSlot) ? o.activeSlot : 0;
  return { layout: size, slots, activeSlot: Math.min(Math.max(active, 0), size - 1) };
}

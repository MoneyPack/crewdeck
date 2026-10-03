import { app, safeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AppSettings, CustomAgent, ProviderKeyInfo } from '../../shared/ipc';

interface StoredSettings extends AppSettings {
  keys: Record<string, string>;
}

const DEFAULTS: StoredSettings = {
  theme: 'dark',
  animations: true,
  fontSize: 13,
  defaultAgent: '',
  confirmOnClose: true,
  autoUpdate: true,
  telemetry: false,
  shell: '',
  customAgents: [],
  cursorStyle: 'block',
  cursorBlink: true,
  scrollback: 5000,
  fontFamily: '',
  lineHeight: 1.2,
  accent: '#ff4d00',
  density: 'comfortable',
  restoreSessions: true,
  startup: 'last',
  notifications: true,
  sound: false,
  updateChannel: 'stable',
  defaultCwd: '',
  reduceMotion: false,
  keys: {},
};

let cache: StoredSettings | null = null;

function file(): string {
  return join(app.getPath('userData'), 'settings.json');
}

function load(): StoredSettings {
  if (cache) return cache;
  try {
    const p = file();
    const raw = existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Partial<StoredSettings>) : {};
    cache = { ...DEFAULTS, ...raw, customAgents: raw.customAgents ?? [], keys: raw.keys ?? {} };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function save(s: StoredSettings): void {
  cache = s;
  const p = file();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
  renameSync(tmp, p);
}

export function getSettings(): AppSettings {
  const { keys: _keys, ...pub } = load();
  return pub;
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const cur = load();
  const next: StoredSettings = { ...cur, ...patch, keys: cur.keys };
  if (typeof next.fontSize !== 'number' || next.fontSize < 9 || next.fontSize > 28) next.fontSize = 13;
  const pick = <T extends string>(v: unknown, ok: readonly T[], d: T): T => (ok.includes(v as T) ? (v as T) : d);
  const num = (v: unknown, lo: number, hi: number, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
  const str = (v: unknown, d: string): string => (typeof v === 'string' ? v.slice(0, 500) : d);
  next.cursorStyle = pick(next.cursorStyle, ['block', 'bar', 'underline'] as const, DEFAULTS.cursorStyle);
  next.cursorBlink = bool(next.cursorBlink, DEFAULTS.cursorBlink);
  next.scrollback = Math.round(num(next.scrollback, 500, 100000, DEFAULTS.scrollback));
  next.fontFamily = str(next.fontFamily, DEFAULTS.fontFamily);
  next.lineHeight = num(next.lineHeight, 1, 2, DEFAULTS.lineHeight);
  next.accent = typeof next.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(next.accent) ? next.accent : DEFAULTS.accent;
  next.density = pick(next.density, ['compact', 'comfortable'] as const, DEFAULTS.density);
  next.restoreSessions = bool(next.restoreSessions, DEFAULTS.restoreSessions);
  next.startup = pick(next.startup, ['empty', 'last', 'palette'] as const, DEFAULTS.startup);
  next.notifications = bool(next.notifications, DEFAULTS.notifications);
  next.sound = bool(next.sound, DEFAULTS.sound);
  next.updateChannel = pick(next.updateChannel, ['stable', 'beta'] as const, DEFAULTS.updateChannel);
  next.defaultCwd = str(next.defaultCwd, DEFAULTS.defaultCwd);
  next.reduceMotion = bool(next.reduceMotion, DEFAULTS.reduceMotion);
  save(next);
  return getSettings();
}

export function listKeys(): ProviderKeyInfo[] {
  const s = load();
  return Object.keys(s.keys).map((provider) => {
    const v = revealKey(provider) ?? '';
    return { provider, hint: v.length > 4 ? `…${v.slice(-4)}` : '••••' };
  });
}

export function setKey(provider: string, value: string): ProviderKeyInfo[] {
  const s = load();
  const name = provider.trim();
  if (!name) throw new Error('Provider name required');
  if (!value) {
    delete s.keys[name];
  } else if (safeStorage.isEncryptionAvailable()) {
    s.keys[name] = `enc:${safeStorage.encryptString(value).toString('base64')}`;
  } else {
    throw new Error('Secure storage unavailable on this system');
  }
  save(s);
  return listKeys();
}

export function revealKey(provider: string): string | null {
  const v = load().keys[provider];
  if (!v) return null;
  try {
    return v.startsWith('enc:') ? safeStorage.decryptString(Buffer.from(v.slice(4), 'base64')) : null;
  } catch {
    return null;
  }
}

/** Environment variables injected into agent PTYs (BYOK). */
export function keyEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const provider of Object.keys(load().keys)) {
    const v = revealKey(provider);
    if (v) env[provider.toUpperCase().replace(/[^A-Z0-9_]/g, '_')] = v;
  }
  return env;
}

export function saveCustomAgent(agent: CustomAgent): CustomAgent[] {
  const s = load();
  if (!agent.name.trim() || !agent.command.trim()) throw new Error('Name and command required');
  const id = agent.id || `custom-${Date.now().toString(36)}`;
  const clean: CustomAgent = {
    id,
    name: agent.name.trim(),
    command: agent.command.trim(),
    args: agent.args.filter((a) => a.length > 0),
    env: agent.env ?? {},
  };
  const list = s.customAgents.filter((a) => a.id !== id);
  list.push(clean);
  save({ ...s, customAgents: list });
  return list;
}

export function removeCustomAgent(id: string): CustomAgent[] {
  const s = load();
  const list = s.customAgents.filter((a) => a.id !== id);
  save({ ...s, customAgents: list });
  return list;
}

import { execFile } from 'node:child_process';
import { ipcMain } from 'electron';
import { AGENT_PROFILES, type AgentDetection, type AgentProfile } from '../../shared/agents';
import { AgentChannels } from '../../shared/ipc';

const SPAWNABLE = /\.(exe|cmd|bat|com)$/i;
const SHIM = /\.(cmd|bat)$/i;

/** Runs `where.exe <command>` and returns every matching path (empty if not found). */
function whereAll(command: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile('where.exe', [command], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err) return resolve([]); // nonzero exit => "INFO: Could not find ..."
      resolve(
        stdout
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('INFO:')),
      );
    });
  });
}

async function detectOne(profile: AgentProfile): Promise<AgentDetection> {
  if (!profile.command) return { id: profile.id, installed: true };
  if (process.platform !== 'win32') {
    // MVP targets Windows; elsewhere rely on PATH resolution by the PTY.
    return { id: profile.id, installed: true, launch: { shell: profile.command, args: profile.args } };
  }
  // where.exe can return extensionless npm shell scripts first; only keep things Windows can spawn.
  const path = (await whereAll(profile.command)).find((p) => SPAWNABLE.test(p));
  if (!path) return { id: profile.id, installed: false };
  const launch = SHIM.test(path)
    ? { shell: 'cmd.exe', args: ['/d', '/c', path, ...profile.args] }
    : { shell: path, args: [...profile.args] };
  return { id: profile.id, installed: true, path, launch };
}

export function registerAgentIpc(): void {
  let cache: Promise<AgentDetection[]> | undefined;
  ipcMain.handle(AgentChannels.detect, (_e, refresh: unknown) => {
    if (!cache || refresh === true) {
      cache = Promise.all(AGENT_PROFILES.map(detectOne));
      cache.catch(() => (cache = undefined));
    }
    return cache;
  });
}

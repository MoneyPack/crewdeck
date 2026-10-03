import { execFile } from 'node:child_process';
import { ipcMain } from 'electron';
import { AGENT_PROFILES, type AgentDetection, type AgentInstallResult, type AgentProfile } from '../../shared/agents';
import { AgentChannels } from '../../shared/ipc';
import { getSettings } from '../services/settings';
import { getDatabase } from '../services/db';
import { listAgentSessions } from '../services/agentSessions';

const SPAWNABLE = /\.(exe|cmd|bat|com)$/i;
const SHIM = /\.(cmd|bat)$/i;

function whereAll(command: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile('where.exe', [command], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err) return resolve([]);
      resolve(
        String(stdout)
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
    return { id: profile.id, installed: true, launch: { shell: profile.command, args: [...profile.args] } };
  }
  const path = (await whereAll(profile.command)).find((p) => SPAWNABLE.test(p));
  if (!path) return { id: profile.id, installed: false };
  const launch = SHIM.test(path)
    ? { shell: 'cmd.exe', args: ['/d', '/c', path, ...profile.args] }
    : { shell: path, args: [...profile.args] };
  return { id: profile.id, installed: true, path, launch };
}

export function allProfiles(): AgentProfile[] {
  const custom: AgentProfile[] = (getSettings().customAgents ?? []).map((a) => ({
    id: a.id,
    name: a.name,
    command: a.command,
    args: a.args ?? [],
    env: a.env ?? {},
    custom: true,
  }));
  return [...AGENT_PROFILES, ...custom];
}

function runInstall(cmd: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', cmd] : ['-c', cmd];
    execFile(
      shell,
      args,
      { windowsHide: true, timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const output = `${String(stdout)}${String(stderr)}`.slice(-8000);
        resolve({ ok: !err, output: err ? `${output}\n${err.message}` : output });
      },
    );
  });
}

export function registerAgentIpc(): void {
  let cache: Promise<AgentDetection[]> | null = null;
  const detectAll = () => Promise.all(allProfiles().map(detectOne));

  ipcMain.handle(AgentChannels.detect, (_e, refresh?: boolean) => {
    if (!cache || refresh) cache = detectAll();
    return cache;
  });

  ipcMain.handle(AgentChannels.sessions, (_e, projectId: unknown) => {
    if (typeof projectId !== 'string') return [];
    const p = getDatabase().getProject(projectId);
    return p ? listAgentSessions(p.path) : [];
  });

  ipcMain.handle(AgentChannels.install, async (_e, ids: unknown): Promise<AgentInstallResult[]> => {
    const list = Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
    const results: AgentInstallResult[] = [];
    for (const id of list) {
      const profile = AGENT_PROFILES.find((p) => p.id === id);
      if (!profile?.install) {
        results.push({ id, ok: false, output: 'No install command for this agent.' });
        continue;
      }
      const r = await runInstall(profile.install);
      results.push({ id, ...r });
    }
    cache = null;
    return results;
  });
}

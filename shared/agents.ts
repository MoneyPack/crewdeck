// Built-in agent profiles. `command` is resolved on PATH by the main process
// (where.exe on Windows); the renderer never guesses executable paths.

export type AgentId = 'shell' | 'claude' | 'codex' | 'gemini';

export interface AgentProfile {
  id: AgentId;
  name: string;
  /** Bare command looked up on PATH. Empty for the default shell. */
  command: string;
  args: string[];
  env: Record<string, string>;
  /**
   * Extra args appended when a terminal is re-spawned after an app restart, so the agent
   * resumes its previous conversation (e.g. `claude --continue`). Live process state itself
   * is never preserved: the process is restarted, only the agent's own history is reloaded.
   */
  resumeArgs?: string[];
}

export const AGENT_PROFILES: readonly AgentProfile[] = [
  { id: 'shell', name: 'Shell', command: '', args: [], env: {} },
  { id: 'claude', name: 'Claude Code', command: 'claude', args: [], env: {}, resumeArgs: ['--continue'] },
  { id: 'codex', name: 'Codex', command: 'codex', args: [], env: {} },
  { id: 'gemini', name: 'Gemini CLI', command: 'gemini', args: [], env: {} },
];

export function getProfile(id: AgentId): AgentProfile {
  const profile = AGENT_PROFILES.find((p) => p.id === id);
  if (!profile) throw new Error(`Unknown agent profile: ${id}`);
  return profile;
}

export interface AgentDetection {
  id: AgentId;
  installed: boolean;
  /** Resolved executable path, when installed. */
  path?: string;
  /** How to spawn it (e.g. .cmd shims go through cmd.exe). Omitted for the default shell. */
  launch?: { shell: string; args: string[] };
}

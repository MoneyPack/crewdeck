export type AgentId = string;

export interface AgentProfile {
  id: AgentId;
  name: string;
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  resumeArgs?: readonly string[];
  /** One-line install command (run through the system shell). */
  install?: string;
  homepage?: string;
  custom?: boolean;
}

const npm = (pkg: string) => `npm i -g ${pkg}`;

export const AGENT_PROFILES: readonly AgentProfile[] = [
  { id: 'shell', name: 'Shell', command: '', args: [], env: {} },
  {
    id: 'claude',
    name: 'Claude Code',
    command: 'claude',
    args: [],
    env: {},
    resumeArgs: ['--continue'],
    install: npm('@anthropic-ai/claude-code'),
    homepage: 'https://docs.anthropic.com/claude-code',
  },
  { id: 'codex', name: 'Codex', command: 'codex', args: [], env: {}, install: npm('@openai/codex') },
  { id: 'gemini', name: 'Gemini CLI', command: 'gemini', args: [], env: {}, install: npm('@google/gemini-cli') },
  { id: 'opencode', name: 'OpenCode', command: 'opencode', args: [], env: {}, install: npm('opencode-ai') },
  { id: 'qwen', name: 'Qwen Code', command: 'qwen', args: [], env: {}, install: npm('@qwen-code/qwen-code') },
  { id: 'amp', name: 'Amp', command: 'amp', args: [], env: {}, install: npm('@sourcegraph/amp') },
  { id: 'copilot', name: 'Copilot CLI', command: 'copilot', args: [], env: {}, install: npm('@github/copilot') },
  {
    id: 'aider',
    name: 'Aider',
    command: 'aider',
    args: [],
    env: {},
    install: 'pip install -U aider-install && aider-install',
  },
  { id: 'goose', name: 'Goose', command: 'goose', args: [], env: {}, install: 'pipx install goose-ai' },
];

export function getProfile(id: AgentId, extra: readonly AgentProfile[] = []): AgentProfile {
  const profile = [...AGENT_PROFILES, ...extra].find((p) => p.id === id);
  if (!profile) throw new Error(`Unknown agent profile: ${id}`);
  return profile;
}

export interface AgentDetection {
  id: AgentId;
  installed: boolean;
  path?: string;
  launch?: { shell: string; args: string[] };
}

export interface AgentInstallResult {
  id: AgentId;
  ok: boolean;
  output: string;
}

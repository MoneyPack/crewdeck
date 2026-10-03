// Types and channel names shared between main, preload and renderer.
import type { AgentDetection, AgentId, AgentInstallResult } from './agents';
import type { BrowserResult, BrowserState } from './browser';

export const TerminalChannels = {
  create: 'terminal:create',
  write: 'terminal:write',
  resize: 'terminal:resize',
  kill: 'terminal:kill',
  data: 'terminal:data',
  exit: 'terminal:exit',
  scrollback: 'terminal:scrollback',
} as const;

/** Written between replayed scrollback and the new session's output. */
export const RESTORED_DIVIDER = '\r\n\x1b[2m── restored session ──\x1b[0m\r\n';

export interface TerminalCreateOptions {
  /** Executable to run. Defaults to pwsh.exe (fallback powershell.exe). */
  shell?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  /** Persisted terminal id (DB `terminals.id`). When set, main records a session row. */
  terminalId?: string;
  /** Resume command line used when re-spawning an agent on restore (recorded in session metadata). */
  resumeCommand?: string;
  /** Previous session id this spawn restores (recorded in session metadata). */
  restoredFrom?: string;
}

export interface TerminalCreateResult {
  id: string;
  pid: number;
  shell: string;
}

/** Wire shape of `terminal:create`: main returns `{ error }` instead of throwing (clean messages). */
export type TerminalCreateResponse = TerminalCreateResult | { error: string };

export interface TerminalDataEvent {
  id: string;
  data: string;
}

export interface TerminalExitEvent {
  id: string;
  exitCode: number;
  signal?: number;
}

export type Unsubscribe = () => void;

export interface CrewdeckTerminalApi {
  create(options?: TerminalCreateOptions): Promise<TerminalCreateResult>;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  kill(id: string): Promise<void>;
  /** Stored output of the persisted terminal's last session. Call BEFORE `create`. */
  scrollback(terminalId: string): Promise<string | null>;
  onData(listener: (event: TerminalDataEvent) => void): Unsubscribe;
  onExit(listener: (event: TerminalExitEvent) => void): Unsubscribe;
}

export const AgentChannels = {
  detect: 'agents:detect',
  install: 'agents:install',
  sessions: 'agents:sessions',
} as const;

/** A past agent CLI session found on disk for a project folder. */
export interface AgentSession {
  agent: 'claude' | 'codex';
  id: string;
  /** First user prompt, trimmed. */
  title: string;
  cwd: string;
  /** mtime, ms since epoch. */
  at: number;
  file: string;
  /** CLI args that resume this session. */
  resumeArgs: string[];
}

export const ProjectChannels = {
  select: 'project:select',
  restore: 'project:restore',
  saveLayout: 'project:saveLayout',
  saveTerminals: 'terminals:save',
  preset: 'project:preset',
} as const;

/** `.crewdeck.json` in a project root: agents to open when the project has no saved terminals. */
export interface ProjectPreset {
  /** Agent profile ids (built-in or custom), e.g. ["claude", "codex", "shell"]. */
  agents: string[];
  /** Optional grid size 1-4; defaults to the agent count. */
  layout?: number;
}

export interface CrewdeckAgentsApi {
  /** Detects which built-in agent CLIs are installed. Cached in main after the first call unless `refresh`. */
  detect(refresh?: boolean): Promise<AgentDetection[]>;
  install(ids: string[]): Promise<AgentInstallResult[]>;
  /** Past Claude Code / Codex sessions recorded for the project folder, newest first. */
  sessions(projectId: string): Promise<AgentSession[]>;
}

export interface ProjectInfo {
  id: string;
  path: string;
  name: string;
}

export type PersistedLayoutSize = 1 | 2 | 4;

/** Split layout state stored in `projects.layout`. Slots hold persisted terminal ids. */
export interface PersistedLayout {
  layout: PersistedLayoutSize;
  slots: (string | null)[];
  activeSlot: number;
  /** Last page shown in the browser pane (http(s) only; omitted when blank). */
  browserUrl?: string;
}

export interface PersistedTerminal {
  id: string;
  title: string;
  profileId: AgentId;
  cwd: string;
  /** Set when the tab runs in its own git worktree (opt-in). */
  worktree?: WorktreeInfo;
}

export interface WorktreeInfo {
  /** Absolute worktree path. */
  path: string;
  /** Branch checked out in the worktree, e.g. `crewdeck/claude-1a2b3c`. */
  branch: string;
}

export interface RestoreResult {
  project: ProjectInfo;
  layout: PersistedLayout | null;
  terminals: PersistedTerminal[];
}

export interface CrewdeckProjectApi {
  /** Opens a folder picker. Resolves null if the user cancels. */
  select(): Promise<ProjectInfo | null>;
  /** Returns the most recently opened project with its terminals and layout, or null. */
  restore(): Promise<RestoreResult | null>;
  saveLayout(projectId: string, layout: PersistedLayout): Promise<void>;
  saveTerminals(projectId: string, terminals: PersistedTerminal[]): Promise<void>;
  /** Reads and validates `<projectPath>/.crewdeck.json`; null when absent or invalid. */
  preset(projectPath: string): Promise<ProjectPreset | null>;
}

export const RoutingChannels = {
  writeTemp: 'routing:writeTemp',
  log: 'routing:log',
  list: 'routing:list',
  appended: 'routing:appended',
} as const;

export type RouteLogKind = 'composer' | 'forward' | 'browser';

/** Max characters of routed text kept as the log preview. */
export const ROUTE_PREVIEW_LIMIT = 300;

export interface RouteLogEntry {
  id: string;
  projectId: string;
  kind: RouteLogKind;
  fromLabel: string;
  targets: string[];
  preview: string;
  bytes: number;
  viaFile: boolean;
  createdAt: number;
}

export interface RouteLogInput {
  kind: RouteLogKind;
  fromLabel: string;
  targets: string[];
  preview: string;
  bytes?: number;
  viaFile?: boolean;
}

export interface CrewdeckRoutingApi {
  /** Writes a large forward payload to a temp file; resolves its absolute path. */
  writeTemp(text: string): Promise<string>;
  /** Records a routed message. Resolves the stored entry, or null if the input was rejected. */
  log(projectId: string, input: RouteLogInput): Promise<RouteLogEntry | null>;
  /** Most recent entries first. */
  list(projectId: string): Promise<RouteLogEntry[]>;
  /** Subscribes to entries written by the main process (e.g. agent browser actions). */
  onAppended(listener: (entry: RouteLogEntry) => void): () => void;
}

export const GitChannels = {
  status: 'git:status',
  diff: 'git:diff',
  watch: 'git:watch',
  unwatch: 'git:unwatch',
  changed: 'git:changed',
  stage: 'git:stage',
  unstage: 'git:unstage',
  discard: 'git:discard',
  worktreeAdd: 'git:worktreeAdd',
  worktreeRemove: 'git:worktreeRemove',
  worktreeDiff: 'git:worktreeDiff',
  worktreeKeep: 'git:worktreeKeep',
} as const;

export type WorktreeAddResult = { ok: true; worktree: WorktreeInfo } | { ok: false; error: string };

export interface WorktreeDiffResult {
  patch: string;
  files: number;
  insertions: number;
  deletions: number;
  truncated: boolean;
}
export type WorktreeKeepResult = { ok: true; merged: string } | { ok: false; error: string };

export interface WorktreeRemoveResult {
  ok: boolean;
  error?: string;
  /** True when removal was refused because of uncommitted or unmerged work; retry with `force`. */
  needsForce?: boolean;
}

export interface GitActionResult {
  ok: boolean;
  error?: string;
}

export type GitDiffKind = 'staged' | 'unstaged' | 'untracked';

export type GitFileState =
  'untracked' | 'conflicted' | 'added' | 'deleted' | 'renamed' | 'copied' | 'typechange' | 'modified';

export interface GitFileStatus {
  /** Repo-relative path, forward slashes. */
  path: string;
  /** Source path for renames/copies. */
  oldPath?: string;
  /** Porcelain index (X) column. */
  index: string;
  /** Porcelain worktree (Y) column. */
  worktree: string;
  state: GitFileState;
  staged: boolean;
  unstaged: boolean;
}

export interface GitStatus {
  isRepo: boolean;
  root?: string;
  branch?: string | null;
  upstream?: string | null;
  ahead?: number;
  behind?: number;
  files: GitFileStatus[];
  truncated?: boolean;
  error?: string;
}

export interface GitDiffResult {
  path: string;
  patch: string;
  binary: boolean;
  truncated: boolean;
}

export interface GitChangedEvent {
  projectId: string;
}

export interface CrewdeckGitApi {
  /** Never rejects; non-repo projects resolve `{ isRepo: false }`. */
  status(projectId: string): Promise<GitStatus>;
  /** Resolves null on invalid input or git failure. */
  diff(projectId: string, path: string, kind: GitDiffKind, oldPath?: string): Promise<GitDiffResult | null>;
  /** Starts a debounced FS watch; `onChanged` fires when the working tree or index changes. */
  watch(projectId: string): Promise<boolean>;
  unwatch(projectId: string): Promise<void>;
  onChanged(listener: (event: GitChangedEvent) => void): Unsubscribe;
  stage(projectId: string, path: string): Promise<GitActionResult>;
  unstage(projectId: string, path: string, oldPath?: string): Promise<GitActionResult>;
  /** Irreversible. `untracked` deletes the file; otherwise restores it from the index. */
  discard(projectId: string, path: string, untracked: boolean): Promise<GitActionResult>;
  /** Creates `<project>/../.crewdeck-worktrees/<project>/<tabId>` on a new `crewdeck/<agent>-<shortid>` branch. */
  worktreeAdd(projectId: string, tabId: string, agentId: string): Promise<WorktreeAddResult>;
  /** Removes a crewdeck worktree and its branch. Refuses dirty/unmerged work unless `force`. */
  worktreeRemove(projectId: string, worktreePath: string, force: boolean): Promise<WorktreeRemoveResult>;
  /** Full patch of everything a worktree changed vs the main checkout's HEAD (Diff Race). */
  worktreeDiff(projectId: string, worktreePath: string): Promise<WorktreeDiffResult | { error: string }>;
  /** Commits the worktree's WIP and merges its branch into the main checkout. */
  worktreeKeep(projectId: string, worktreePath: string, message: string): Promise<WorktreeKeepResult>;
}

export const BrowserChannels = {
  run: 'browser:run',
  setBounds: 'browser:setBounds',
  setVisible: 'browser:setVisible',
  state: 'browser:state',
  stateChanged: 'browser:stateChanged',
  bridge: 'browser:bridge',
} as const;

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Connection info for the local agent bridge (HTTP on 127.0.0.1). */
export interface BrowserBridgeInfo {
  url: string;
  cliPath: string;
  mcpPath: string;
}

export interface CrewdeckBrowserApi {
  /** Runs a browser command (validated in main). `projectId` attributes the routing-log entry. */
  run(command: unknown, projectId: string | null): Promise<BrowserResult>;
  /** Positions the native view in window content coordinates (CSS px at zoom 1 == DIP). */
  setBounds(bounds: BrowserBounds): void;
  setVisible(visible: boolean): void;
  state(): Promise<BrowserState>;
  onState(listener: (state: BrowserState) => void): Unsubscribe;
  /** Agent bridge endpoint (token excluded), or null if not running. */
  bridge(): Promise<BrowserBridgeInfo | null>;
}

export interface CustomAgent {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface AppSettings {
  theme: 'dark' | 'light' | 'system';
  animations: boolean;
  fontSize: number;
  defaultAgent: string;
  confirmOnClose: boolean;
  autoUpdate: boolean;
  telemetry: boolean;
  shell: string;
  customAgents: CustomAgent[];
  cursorStyle: 'block' | 'bar' | 'underline';
  cursorBlink: boolean;
  scrollback: number;
  fontFamily: string;
  lineHeight: number;
  accent: string;
  density: 'compact' | 'comfortable';
  restoreSessions: boolean;
  startup: 'empty' | 'last' | 'palette';
  notifications: boolean;
  sound: boolean;
  updateChannel: 'stable' | 'beta';
  defaultCwd: string;
  reduceMotion: boolean;
  /** Global accelerator that shows/hides the window from anywhere. Empty disables. */
  summonHotkey: string;
}

export interface ProviderKeyInfo {
  provider: string;
  hint: string;
}

export const SettingsChannels = {
  get: 'settings:get',
  update: 'settings:update',
  listKeys: 'settings:listKeys',
  setKey: 'settings:setKey',
  saveAgent: 'settings:saveAgent',
  removeAgent: 'settings:removeAgent',
} as const;

export interface CrewdeckSettingsApi {
  get(): Promise<AppSettings>;
  update(patch: Partial<AppSettings>): Promise<AppSettings>;
  listKeys(): Promise<ProviderKeyInfo[]>;
  setKey(provider: string, value: string): Promise<ProviderKeyInfo[]>;
  saveAgent(agent: Omit<CustomAgent, 'id'> & { id?: string }): Promise<AppSettings>;
  removeAgent(id: string): Promise<AppSettings>;
}

export interface CrewdeckApi {
  terminal: CrewdeckTerminalApi;
  agents: CrewdeckAgentsApi;
  settings: CrewdeckSettingsApi;
  project: CrewdeckProjectApi;
  routing: CrewdeckRoutingApi;
  git: CrewdeckGitApi;
  browser: CrewdeckBrowserApi;
  platform: string;
}

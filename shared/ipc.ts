// Types and channel names shared between main, preload and renderer.
import type { AgentDetection, AgentId } from './agents';

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
} as const;

export const ProjectChannels = {
  select: 'project:select',
  restore: 'project:restore',
  saveLayout: 'project:saveLayout',
  saveTerminals: 'terminals:save',
} as const;

export interface CrewdeckAgentsApi {
  /** Detects which built-in agent CLIs are installed. Cached in main after the first call unless `refresh`. */
  detect(refresh?: boolean): Promise<AgentDetection[]>;
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
}

export const RoutingChannels = {
  writeTemp: 'routing:writeTemp',
  log: 'routing:log',
  list: 'routing:list',
} as const;

export type RouteLogKind = 'composer' | 'forward';

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
} as const;

export type WorktreeAddResult = { ok: true; worktree: WorktreeInfo } | { ok: false; error: string };

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
  | 'untracked'
  | 'conflicted'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'typechange'
  | 'modified';

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
}

export interface CrewdeckApi {
  terminal: CrewdeckTerminalApi;
  agents: CrewdeckAgentsApi;
  project: CrewdeckProjectApi;
  routing: CrewdeckRoutingApi;
  git: CrewdeckGitApi;
  platform: string;
}

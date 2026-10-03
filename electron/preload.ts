import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  AgentChannels,
  BrowserChannels,
  SettingsChannels,
  GitChannels,
  ProjectChannels,
  RoutingChannels,
  TerminalChannels,
  type CrewdeckApi,
  type GitChangedEvent,
  type TerminalCreateResponse,
  type TerminalDataEvent,
  type TerminalExitEvent,
  type RouteLogEntry,
} from '../shared/ipc';
import type { BrowserState } from '../shared/browser';

const api: CrewdeckApi = {
  platform: process.platform,
  terminal: {
    create: async (options) => {
      const res = (await ipcRenderer.invoke(TerminalChannels.create, options)) as TerminalCreateResponse;
      if ('error' in res) throw new Error(res.error);
      return res;
    },
    write: (id, data) => ipcRenderer.send(TerminalChannels.write, id, data),
    resize: (id, cols, rows) => ipcRenderer.send(TerminalChannels.resize, id, cols, rows),
    kill: (id) => ipcRenderer.invoke(TerminalChannels.kill, id),
    scrollback: (terminalId) => ipcRenderer.invoke(TerminalChannels.scrollback, terminalId),
    onData: (listener) => {
      const handler = (_e: IpcRendererEvent, event: TerminalDataEvent) => listener(event);
      ipcRenderer.on(TerminalChannels.data, handler);
      return () => ipcRenderer.removeListener(TerminalChannels.data, handler);
    },
    onExit: (listener) => {
      const handler = (_e: IpcRendererEvent, event: TerminalExitEvent) => listener(event);
      ipcRenderer.on(TerminalChannels.exit, handler);
      return () => ipcRenderer.removeListener(TerminalChannels.exit, handler);
    },
  },
  agents: {
    detect: (refresh) => ipcRenderer.invoke(AgentChannels.detect, refresh === true),
    install: (ids) => ipcRenderer.invoke(AgentChannels.install, ids),
    sessions: (projectId) => ipcRenderer.invoke(AgentChannels.sessions, projectId),
  },
  project: {
    select: () => ipcRenderer.invoke(ProjectChannels.select),
    restore: () => ipcRenderer.invoke(ProjectChannels.restore),
    saveLayout: (projectId, layout) => ipcRenderer.invoke(ProjectChannels.saveLayout, projectId, layout),
    saveTerminals: (projectId, terminals) => ipcRenderer.invoke(ProjectChannels.saveTerminals, projectId, terminals),
    preset: (projectPath) => ipcRenderer.invoke(ProjectChannels.preset, projectPath),
  },
  routing: {
    writeTemp: (text) => ipcRenderer.invoke(RoutingChannels.writeTemp, text),
    log: (projectId, input) => ipcRenderer.invoke(RoutingChannels.log, projectId, input),
    list: (projectId) => ipcRenderer.invoke(RoutingChannels.list, projectId),
    onAppended: (listener) => {
      const handler = (_e: IpcRendererEvent, entry: RouteLogEntry) => listener(entry);
      ipcRenderer.on(RoutingChannels.appended, handler);
      return () => ipcRenderer.removeListener(RoutingChannels.appended, handler);
    },
  },
  git: {
    status: (projectId) => ipcRenderer.invoke(GitChannels.status, projectId),
    diff: (projectId, path, kind, oldPath) => ipcRenderer.invoke(GitChannels.diff, projectId, path, kind, oldPath),
    watch: (projectId) => ipcRenderer.invoke(GitChannels.watch, projectId),
    unwatch: (projectId) => ipcRenderer.invoke(GitChannels.unwatch, projectId),
    onChanged: (listener) => {
      const handler = (_e: IpcRendererEvent, event: GitChangedEvent) => listener(event);
      ipcRenderer.on(GitChannels.changed, handler);
      return () => ipcRenderer.removeListener(GitChannels.changed, handler);
    },
    stage: (projectId, path) => ipcRenderer.invoke(GitChannels.stage, projectId, path),
    unstage: (projectId, path, oldPath) => ipcRenderer.invoke(GitChannels.unstage, projectId, path, oldPath),
    discard: (projectId, path, untracked) => ipcRenderer.invoke(GitChannels.discard, projectId, path, untracked),
    worktreeAdd: (projectId, tabId, agentId) => ipcRenderer.invoke(GitChannels.worktreeAdd, projectId, tabId, agentId),
    worktreeDiff: (projectId, worktreePath) => ipcRenderer.invoke(GitChannels.worktreeDiff, projectId, worktreePath),
    worktreeKeep: (projectId, worktreePath, message) =>
      ipcRenderer.invoke(GitChannels.worktreeKeep, projectId, worktreePath, message),
    worktreeRemove: (projectId, worktreePath, force) =>
      ipcRenderer.invoke(GitChannels.worktreeRemove, projectId, worktreePath, force),
  },
  browser: {
    run: (command, projectId) => ipcRenderer.invoke(BrowserChannels.run, command, projectId),
    setBounds: (bounds) => ipcRenderer.send(BrowserChannels.setBounds, bounds),
    setVisible: (visible) => ipcRenderer.send(BrowserChannels.setVisible, visible),
    state: () => ipcRenderer.invoke(BrowserChannels.state),
    bridge: () => ipcRenderer.invoke(BrowserChannels.bridge),
    onState: (listener) => {
      const handler = (_e: IpcRendererEvent, state: BrowserState) => listener(state);
      ipcRenderer.on(BrowserChannels.stateChanged, handler);
      return () => ipcRenderer.removeListener(BrowserChannels.stateChanged, handler);
    },
  },
  settings: {
    get: () => ipcRenderer.invoke(SettingsChannels.get),
    update: (patch) => ipcRenderer.invoke(SettingsChannels.update, patch),
    listKeys: () => ipcRenderer.invoke(SettingsChannels.listKeys),
    setKey: (provider, value) => ipcRenderer.invoke(SettingsChannels.setKey, provider, value),
    saveAgent: (agent) => ipcRenderer.invoke(SettingsChannels.saveAgent, agent),
    removeAgent: (id) => ipcRenderer.invoke(SettingsChannels.removeAgent, id),
  },
};

contextBridge.exposeInMainWorld('crewdeck', api);

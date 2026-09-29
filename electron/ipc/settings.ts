import { ipcMain } from 'electron';
import { SettingsChannels, type AppSettings, type CustomAgent } from '../../shared/ipc';
import {
  getSettings,
  updateSettings,
  listKeys,
  setKey,
  saveCustomAgent,
  removeCustomAgent,
} from '../services/settings';

export function registerSettingsIpc(): void {
  ipcMain.handle(SettingsChannels.get, () => getSettings());
  ipcMain.handle(SettingsChannels.update, (_e, patch: Partial<AppSettings>) => {
    updateSettings(patch ?? {});
    return getSettings();
  });
  ipcMain.handle(SettingsChannels.listKeys, () => listKeys());
  ipcMain.handle(SettingsChannels.setKey, (_e, provider: string, value: string) =>
    setKey(String(provider ?? ''), String(value ?? '')),
  );
  ipcMain.handle(SettingsChannels.saveAgent, (_e, agent: Omit<CustomAgent, 'id'> & { id?: string }) => {
    const id = agent.id || `custom-${Date.now().toString(36)}`;
    saveCustomAgent({ ...agent, id } as CustomAgent);
    return getSettings();
  });
  ipcMain.handle(SettingsChannels.removeAgent, (_e, id: string) => {
    removeCustomAgent(String(id ?? ''));
    return getSettings();
  });
}

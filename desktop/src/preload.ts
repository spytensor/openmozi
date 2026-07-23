import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('moziDesktop', Object.freeze({
  selectDirectory: async (): Promise<{ canceled: boolean; path?: string }> => (
    ipcRenderer.invoke('mozi:select-directory')
  ),
  getBuildInfo: async (): Promise<{ version: string; surface: 'desktop' }> => (
    ipcRenderer.invoke('mozi:build-info')
  ),
}));

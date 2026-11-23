import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('jarekingAPI', {
  ping: () => ipcRenderer.invoke('app:ping'),
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  },
  file: {
    open: () => ipcRenderer.invoke('file:open'),
    save: (data: ArrayBuffer, filePath?: string) =>
      ipcRenderer.invoke('file:save', data, filePath),
    readByPath: (filePath: string) =>
      ipcRenderer.invoke('file:read-by-path', filePath),
  },
  recentFiles: {
    get: () => ipcRenderer.invoke('recent-files:get'),
    clear: () => ipcRenderer.invoke('recent-files:clear'),
  },
})

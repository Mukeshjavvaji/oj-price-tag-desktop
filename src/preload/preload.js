const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  configRead: () => ipcRenderer.invoke('config:read'),
  getVersion: () => ipcRenderer.invoke('app:version'),
  unlock: (password) => ipcRenderer.invoke('auth:unlock', password),
  changePassword: (next) => ipcRenderer.invoke('auth:change', next),
  configWrite: (next) => ipcRenderer.invoke('config:write', next),
  shopifyTest: (creds) => ipcRenderer.invoke('shopify:test', creds),
  shopifySearch: (params) => ipcRenderer.invoke('shopify:search', params),
  shopifyFilters: () => ipcRenderer.invoke('shopify:filters'),
  print: (payload) => ipcRenderer.invoke('print:open', payload),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  onUpdateStatus: (cb) => ipcRenderer.on('update:status', (_e, payload) => cb(payload)),
});

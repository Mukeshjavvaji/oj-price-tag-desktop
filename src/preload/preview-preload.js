const { contextBridge, ipcRenderer } = require('electron');

// Exposed to the print-preview window only.
contextBridge.exposeInMainWorld('previewApi', {
  getPrinters: () => ipcRenderer.invoke('print:printers'),
  print: (deviceName, paper) => ipcRenderer.invoke('print:run', { deviceName, paper }),
  cancel: () => ipcRenderer.invoke('print:cancel'),
});

const { contextBridge, ipcRenderer } = require('electron');

// Exposed to the print-preview window only.
contextBridge.exposeInMainWorld('previewApi', {
  getPrinters: () => ipcRenderer.invoke('print:printers'),
  print: (deviceName) => ipcRenderer.invoke('print:run', deviceName),
  cancel: () => ipcRenderer.invoke('print:cancel'),
});

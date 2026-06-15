const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const config = require('./config');
const shopify = require('./shopify');
const { renderPrintHTML } = require('./render');
const { setupUpdates } = require('./update');

let mainWindow;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 800,
    minHeight: 600,
    title: 'Olive Print Tags',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createMainWindow();
  setupUpdates(() => mainWindow);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

const auth = require('./auth');

// IPC ----------------------------------------------------------------------

ipcMain.handle('config:read', () => config.read());

ipcMain.handle('auth:unlock', (_e, password) => ({ ok: auth.verify(password) }));

ipcMain.handle('auth:change', (_e, next) => ({ ok: auth.change(next) }));

ipcMain.handle('config:write', (_e, next) => {
  config.write(next);
  return { ok: true };
});

ipcMain.handle('shopify:test', async (_e, { shop, apiKey, apiSecret }) => {
  try {
    const info = await shopify.testConnection({ shop, apiKey, apiSecret });
    return { ok: true, info };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('shopify:search', async (_e, { term, collectionIds = [], tags = [] }) => {
  const { shop, apiKey, apiSecret } = config.read();
  if (!shop || !apiKey || !apiSecret) return { ok: false, error: 'Not configured' };
  try {
    const products = await shopify.searchProducts({ shop, apiKey, apiSecret, term, collectionIds, tags, limit: 50 });
    return { ok: true, products };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('shopify:filters', async () => {
  const { shop, apiKey, apiSecret } = config.read();
  if (!shop || !apiKey || !apiSecret) return { ok: false, error: 'Not configured' };
  try {
    const filters = await shopify.getFilters({ shop, apiKey, apiSecret });
    return { ok: true, ...filters };
  } catch (err) {
    console.error('[filters] error:', err.message);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('print:open', async (_e, payload) => {
  const html = await renderPrintHTML(payload);
  const printWindow = new BrowserWindow({
    width: 800,
    height: 400,
    show: false,
    parent: mainWindow,
    webPreferences: { contextIsolation: true },
  });
  await printWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  printWindow.webContents.on('did-finish-load', () => {
    printWindow.show();
  });
  printWindow.on('closed', () => {});
  return { ok: true };
});

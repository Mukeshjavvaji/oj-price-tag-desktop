const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const shopify = require('./shopify');
const { renderPrintHTML } = require('./render');
const { setupUpdates } = require('./update');

let mainWindow;

const ICON_PATH = path.join(__dirname, '..', '..', 'assets', 'logo', 'icon.png');

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 800,
    minHeight: 600,
    title: 'OJ Label Printer',
    icon: ICON_PATH,
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
  if (process.platform === 'darwin' && app.dock) app.dock.setIcon(ICON_PATH);
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

ipcMain.handle('app:version', () => app.getVersion());

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

let previewWin = null;
let previewPageSize = null; // microns, set per print run

ipcMain.handle('print:open', async (_e, payload) => {
  const html = await renderPrintHTML(payload);
  const mode = Array.isArray(payload) ? 'box' : (payload.mode || 'box');
  const heightMm = (mode === 'tail' || mode === 'tail-rotated') ? 15 : 25;
  previewPageSize = { width: 100000, height: heightMm * 1000 }; // 100mm x heightMm in microns

  if (previewWin && !previewWin.isDestroyed()) previewWin.close();
  previewWin = new BrowserWindow({
    width: 840,
    height: 560,
    parent: mainWindow,
    title: 'Print preview',
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preview-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  previewWin.setMenuBarVisibility(false);
  // Load from a temp file (no data: URL size cap, so large print runs work).
  const tmpPath = path.join(app.getPath('temp'), 'oj-print-preview.html');
  fs.writeFileSync(tmpPath, html);
  await previewWin.loadFile(tmpPath);
  previewWin.on('closed', () => { previewWin = null; });
  return { ok: true };
});

// List installed printers (from the OS) for the preview dropdown, with the
// remembered default. getPrintersAsync can return [] on the first call on
// Windows (print backend not ready), so retry a few times.
ipcMain.handle('print:printers', async (e) => {
  let printers = [];
  for (let i = 0; i < 6; i++) {
    try { printers = await e.sender.getPrintersAsync(); } catch { printers = []; }
    if (printers && printers.length) break;
    await new Promise(r => setTimeout(r, 300));
  }
  const { defaultPrinter } = config.read();
  return {
    printers: (printers || []).map(p => ({ name: p.name, displayName: p.displayName || p.name, isDefault: p.isDefault })),
    defaultPrinter: defaultPrinter || '',
  };
});

// Silent print to the chosen printer + paper; remember the printer.
ipcMain.handle('print:run', async (e, { deviceName, paper }) => {
  try { config.write({ ...config.read(), defaultPrinter: deviceName }); } catch { /* ignore */ }
  // Map the paper choice to a print pageSize: "WxH" mm -> microns, or a named size.
  let pageSize = previewPageSize;
  const m = /^(\d+)x(\d+)$/.exec(paper || '');
  if (m) pageSize = { width: Number(m[1]) * 1000, height: Number(m[2]) * 1000 };
  else if (paper) pageSize = paper; // e.g. 'A4', 'Letter'
  return new Promise((resolve) => {
    e.sender.print(
      { silent: true, deviceName, pageSize, margins: { marginType: 'none' }, printBackground: true },
      (success, reason) => resolve({ ok: success, reason })
    );
  });
});

ipcMain.handle('print:cancel', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win && !win.isDestroyed()) win.close();
  return { ok: true };
});

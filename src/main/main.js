const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const config = require('./config');
const shopify = require('./shopify');
const { renderPrintHTML } = require('./render');
const { setupUpdates } = require('./update');

let mainWindow;

const ICON_PATH = path.join(__dirname, '..', '..', 'assets', 'logo', 'icon.png');

function timestampForPath(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function tagExportRoot() {
  try {
    return path.join(app.getPath('documents'), 'OJ Label Tags');
  } catch {
    return path.join(app.getPath('temp'), 'OJ Label Tags');
  }
}

function createTagExportDir(mode) {
  const safeMode = String(mode || 'tags').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'tags';
  const dir = path.join(tagExportRoot(), safeMode);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) {
    if (/^tag-\d+\.png$/i.test(f)) fs.unlinkSync(path.join(dir, f));
  }
  return dir;
}

function writePrintLog(message) {
  try {
    const dir = path.join(app.getPath('temp'), 'oj-tags');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'print.log'), `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // Avoid crashing the main process if diagnostics cannot be written.
  }
}

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

// ===========================================================================
// PRINT — rasterize each tag "page" to a high-DPI PNG, then print them all in
// a single job via a WinForms PrintDocument (Windows). The PrintDialog lets the
// user pick the printer/paper; every PNG is drawn full-bleed to its own page.
// ===========================================================================

// Render each tag "page" in the print HTML to a high-DPI PNG.
// Returns { pngs, dir, paperW, paperH } where paperW/paperH are in 1/100 inch
// (WinForms PaperSize units).
async function renderTagPngs(payload) {
  const html = await renderPrintHTML(payload);
  const mode = Array.isArray(payload) ? 'box' : (payload.mode || 'box');
  const isTail = mode === 'tail' || mode === 'tail-rotated';
  const heightMm = isTail ? 15 : 25;

  const ZOOM = 3.125;                 // 96dpi * 3.125 ≈ 300dpi (crisp QR)
  const pxPerMm = 96 / 25.4;
  const pageWpx = Math.round(100 * pxPerMm * ZOOM);
  const pageHpx = Math.round(heightMm * pxPerMm * ZOOM);
  const count = (html.match(/class="(?:tag-pair|tail-row)"/g) || []).length || 1;

  // Strip the on-screen preview chrome (toolbar, its script, the @media screen
  // zoom) so the capture is clean, then set a known zoom for DPI.
  let doc = html.replace(/<script>[\s\S]*?<\/script>/, '');
  doc = stripBlock(doc, '@media screen');
  doc = doc.replace('</head>',
    `<style>.toolbar{display:none}.pages{padding:0;margin:0;gap:0}.pages>div{zoom:${ZOOM}}` +
    `::-webkit-scrollbar{width:0;height:0}</style></head>`);

  const dir = createTagExportDir(mode);
  const tmpDir = path.join(app.getPath('temp'), 'oj-tags-render');
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpHtml = path.join(tmpDir, `tags-${timestampForPath()}.html`);
  fs.writeFileSync(tmpHtml, doc);

  // Render off-screen (far off the desktop so it paints but is unseen). The
  // window is exactly one page tall: a taller window only paints up to the
  // display height, so pages past the fold capture blank. Instead we scroll
  // each page into the viewport before capturing it.
  const win = new BrowserWindow({
    x: 0, y: 0, width: pageWpx, height: pageHpx,
    show: true, frame: false, skipTaskbar: true, opacity: 0.01,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  await win.loadFile(tmpHtml);
  await new Promise(r => setTimeout(r, 400)); // let it paint

  const pngs = [];
  for (let i = 0; i < count; i++) {
    await win.webContents.executeJavaScript(`window.scrollTo(0, ${i * pageHpx});`);
    let buf = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise(r => setTimeout(r, attempt === 0 ? 120 : 180)); // let the scrolled region paint
      const img = await win.webContents.capturePage({ x: 0, y: 0, width: pageWpx, height: pageHpx });
      buf = img.toPNG();
      if (buf.length > 0) break;
    }
    if (!buf || buf.length === 0) throw new Error(`Could not capture print page ${i + 1}`);
    const p = path.join(dir, `tag-${String(i + 1).padStart(3, '0')}.png`);
    fs.writeFileSync(p, buf);
    pngs.push(p);
  }
  win.close();

  const mmToHundredths = (mm) => Math.round((mm / 25.4) * 100);
  return { pngs, dir, paperW: mmToHundredths(100), paperH: mmToHundredths(heightMm) };
}

// Remove a `@media …{ … }` block (brace-aware) from a CSS/HTML string.
function stripBlock(s, marker) {
  const start = s.indexOf(marker);
  if (start < 0) return s;
  let i = s.indexOf('{', start), depth = 0, j = i;
  for (; j < s.length; j++) {
    if (s[j] === '{') depth++;
    else if (s[j] === '}') { depth--; if (depth === 0) { j++; break; } }
  }
  return s.slice(0, start) + s.slice(j);
}

// WinForms print script: one PrintDocument, one PrintDialog, each image drawn
// full-bleed to its own page → all pages print in a single job (Copies stays 1).
// Paper is fixed to the label size; zero margins; image fills PageBounds.
const WINFORMS_PS1 = `param([string]$ListFile,[int]$W,[int]$H,[string]$Printer)
$src = @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Drawing;
using System.Drawing.Printing;
using System.Windows.Forms;
public class OjPrinter {
  public static void Run(string listFile, int w, int h, string printerName) {
    List<string> files = new List<string>(File.ReadAllLines(listFile));
    files.RemoveAll(s => string.IsNullOrEmpty(s.Trim()) || !File.Exists(s) || new FileInfo(s).Length == 0);
    if (files.Count == 0) return;
    int idx = 0;
    Application.EnableVisualStyles();
    PrintDocument doc = new PrintDocument();
    doc.DocumentName = "OJ Labels";
    doc.OriginAtMargins = false;
    doc.DefaultPageSettings.Margins = new Margins(0, 0, 0, 0);
    doc.DefaultPageSettings.PaperSize = new PaperSize("Label", w, h);
    doc.PrintPage += delegate(object s, PrintPageEventArgs e) {
      using (Image img = Image.FromFile(files[idx])) {
        e.Graphics.DrawImage(img, e.PageBounds);
      }
      idx++;
      e.HasMorePages = idx < files.Count;
    };
    if (!string.IsNullOrEmpty(printerName)) doc.PrinterSettings.PrinterName = printerName;
    PrintDialog dlg = new PrintDialog();
    dlg.Document = doc;
    dlg.AllowSomePages = true;
    dlg.UseEXDialog = true;
    using (Form owner = new Form()) {
      owner.Text = "OJ Label Printer";
      owner.StartPosition = FormStartPosition.CenterScreen;
      owner.Width = 1;
      owner.Height = 1;
      owner.ShowInTaskbar = false;
      owner.TopMost = true;
      owner.Show();
      owner.Activate();
      if (dlg.ShowDialog(owner) == DialogResult.OK) { doc.Print(); }
      owner.Close();
    }
  }
}
'@
Add-Type -TypeDefinition $src -ReferencedAssemblies System.Drawing,System.Windows.Forms
[OjPrinter]::Run($ListFile, $W, $H, $Printer)
`;

// Hand the PNGs to the OS print path.
function openImagePrint({ pngs, dir, paperW, paperH }) {
  const printablePngs = pngs.filter((p) => {
    try { return fs.statSync(p).size > 0; } catch { return false; }
  });
  if (!printablePngs.length) return;
  writePrintLog(`Generated ${printablePngs.length} image(s); opening folder ${dir}`);
  shell.openPath(dir);
}

async function openHtmlPrintDialog(payload) {
  const html = await renderPrintHTML(payload);
  const mode = Array.isArray(payload) ? 'box' : (payload.mode || 'box');
  const heightMm = (mode === 'tail' || mode === 'tail-rotated') ? 15 : 25;
  const dir = path.join(app.getPath('temp'), 'oj-tags');
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, 'tags-print.html');
  const doc = html
    .replace(/<div class="toolbar">[\s\S]*?<\/div>\s*/, '')
    .replace(/<script>[\s\S]*?<\/script>/, '');
  fs.writeFileSync(tmpPath, doc);

  const win = new BrowserWindow({
    width: 900,
    height: 650,
    parent: mainWindow,
    title: 'OJ Label Print',
    icon: ICON_PATH,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.setMenuBarVisibility(false);
  await win.loadFile(tmpPath);

  return new Promise((resolve) => {
    win.webContents.print({
      silent: false,
      printBackground: true,
      margins: { marginType: 'none' },
      pageSize: { width: 100000, height: heightMm * 1000 },
    }, (success, reason) => {
      if (!success) writePrintLog(`HTML dialog failed: ${reason || 'unknown reason'}`);
      setTimeout(() => { if (!win.isDestroyed()) win.close(); }, 250);
      resolve({ ok: success, reason });
    });
  });
}

ipcMain.handle('print:open', async (_e, payload) => {
  try {
    if (process.platform === 'win32') {
      try {
        const result = await renderTagPngs(payload);
        openImagePrint(result);
        return { ok: true, count: result.pngs.length, folder: result.dir };
      } catch (err) {
        writePrintLog(`PNG path failed; folder was not opened: ${String((err && err.stack) || err)}`);
        return { ok: false, error: 'Could not generate the tag images. See print.log.' };
      }
    }
    const fallback = await openHtmlPrintDialog(payload);
    return fallback.ok ? { ok: true } : { ok: false, error: fallback.reason || 'Print dialog failed' };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

/* ---- DISABLED: in-app preview window + silent print (kept for reference) ----
let previewWin = null;
let previewPageSize = null;

ipcMain.handle('print:open', async (_e, payload) => {
  const html = await renderPrintHTML(payload);
  const mode = Array.isArray(payload) ? 'box' : (payload.mode || 'box');
  const heightMm = (mode === 'tail' || mode === 'tail-rotated') ? 15 : 25;
  previewPageSize = { width: 100000, height: heightMm * 1000 };
  if (previewWin && !previewWin.isDestroyed()) previewWin.close();
  previewWin = new BrowserWindow({
    width: 840, height: 560, parent: mainWindow, title: 'Print preview', icon: ICON_PATH,
    webPreferences: { preload: path.join(__dirname, '..', 'preload', 'preview-preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  previewWin.setMenuBarVisibility(false);
  const tmpPath = path.join(app.getPath('temp'), 'oj-print-preview.html');
  fs.writeFileSync(tmpPath, html);
  await previewWin.loadFile(tmpPath);
  previewWin.on('closed', () => { previewWin = null; });
  return { ok: true };
});

ipcMain.handle('print:printers', async (e) => {
  let printers = [];
  for (let i = 0; i < 6; i++) {
    try { printers = await e.sender.getPrintersAsync(); } catch { printers = []; }
    if (printers && printers.length) break;
    await new Promise(r => setTimeout(r, 300));
  }
  const { defaultPrinter } = config.read();
  return { printers: (printers || []).map(p => ({ name: p.name, displayName: p.displayName || p.name, isDefault: p.isDefault })), defaultPrinter: defaultPrinter || '' };
});

ipcMain.handle('print:run', async (e, { deviceName, paper }) => {
  try { config.write({ ...config.read(), defaultPrinter: deviceName }); } catch {}
  let pageSize = previewPageSize;
  const m = /^(\d+)x(\d+)$/.exec(paper || '');
  if (m) pageSize = { width: Number(m[1]) * 1000, height: Number(m[2]) * 1000 };
  else if (paper) pageSize = paper;
  return new Promise((resolve) => {
    e.sender.print({ silent: true, deviceName, pageSize, margins: { marginType: 'none' }, printBackground: true }, (success, reason) => resolve({ ok: success, reason }));
  });
});

ipcMain.handle('print:cancel', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win && !win.isDestroyed()) win.close();
  return { ok: true };
});
---- end disabled preview ---- */

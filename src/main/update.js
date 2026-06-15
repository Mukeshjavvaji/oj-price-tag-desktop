const { app, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');

let secrets = {};
try { secrets = require('./secrets'); } catch { /* no secrets.js */ }

// Button-driven only: never poll, never auto-download.
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;

// Private GitHub repo needs a token at runtime (embedded via secrets.js).
function configureFeed() {
  if (secrets.githubOwner && secrets.githubRepo && secrets.githubToken) {
    autoUpdater.setFeedURL({
      provider: 'github',
      owner: secrets.githubOwner,
      repo: secrets.githubRepo,
      private: true,
      token: secrets.githubToken,
    });
    return true;
  }
  return false;
}

// Wire IPC + forward updater events to the renderer as {status, ...} messages.
function setupUpdates(getWindow) {
  const send = (payload) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('update:status', payload);
  };

  autoUpdater.on('checking-for-update', () => send({ status: 'checking' }));
  // Only notify — the user decides whether to install.
  autoUpdater.on('update-available', (info) => send({ status: 'available', version: info.version }));
  autoUpdater.on('update-not-available', () => send({ status: 'up-to-date' }));
  autoUpdater.on('download-progress', (p) => send({ status: 'downloading', percent: Math.round(p.percent) }));
  // User opted in (clicked Install) → apply and restart once downloaded.
  autoUpdater.on('update-downloaded', (info) => {
    send({ status: 'downloaded', version: info.version });
    autoUpdater.quitAndInstall();
  });
  autoUpdater.on('error', (err) => send({ status: 'error', message: String((err && err.message) || err) }));

  ipcMain.handle('update:check', async () => {
    if (!app.isPackaged) return { ok: false, error: 'Updates only work in the installed app, not in dev.' };
    if (!configureFeed()) return { ok: false, error: 'Update channel not configured (missing githubOwner/Repo/Token in secrets.js).' };
    try {
      await autoUpdater.checkForUpdates();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle('update:download', async () => {
    try {
      await autoUpdater.downloadUpdate();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });
}

module.exports = { setupUpdates };

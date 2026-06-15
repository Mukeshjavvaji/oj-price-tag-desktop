const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

// Admin password is stored (hashed) in the user-data dir, separate from config.json,
// and never sent to the renderer. Seeded with the install default on first use,
// then changeable at runtime via the Settings "Change password" flow.
const AUTH_PATH = path.join(app.getPath('userData'), 'auth.json');

let DEFAULT_PASSWORD = 'olive-admin';
try {
  const s = require('./secrets');
  if (s.adminPassword) DEFAULT_PASSWORD = s.adminPassword;
} catch { /* no secrets.js — use built-in default */ }

function hash(pw) {
  return crypto.createHash('sha256').update(String(pw)).digest('hex');
}

function writeHash(h) {
  fs.mkdirSync(path.dirname(AUTH_PATH), { recursive: true });
  fs.writeFileSync(AUTH_PATH, JSON.stringify({ passwordHash: h }, null, 2), { mode: 0o600 });
}

function readHash() {
  try {
    return JSON.parse(fs.readFileSync(AUTH_PATH, 'utf8')).passwordHash;
  } catch {
    // First use: seed with the install default.
    const h = hash(DEFAULT_PASSWORD);
    writeHash(h);
    return h;
  }
}

function verify(password) {
  return hash(password) === readHash();
}

function change(next) {
  if (!next) return false;
  writeHash(hash(next));
  return true;
}

module.exports = { verify, change };

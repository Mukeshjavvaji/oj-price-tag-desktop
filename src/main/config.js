const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');

// Bundled defaults so a fresh install connects without the Settings modal.
// Credentials live in the gitignored ./secrets.js (copy from secrets.example.js).
// If that file is absent, defaults are blank and the Settings modal will appear.
// Anything saved to config.json overrides these (see Settings).
// Products with any of these tags default to the Tail Tag layout; everything
// else uses Box Tag. Editable in Settings (persisted to config.json).
const DEFAULT_TAIL_TAGS = ['Kadas', 'Bracelets', 'Necklace', 'Chains', 'Finger Rings', 'Pendant', 'Pendant Set'];

let DEFAULT_CONFIG = { shop: '', apiKey: '', apiSecret: '', tailTags: DEFAULT_TAIL_TAGS };
try {
  // Pick only the credential fields — adminPassword stays out of config.json / the renderer.
  const s = require('./secrets');
  DEFAULT_CONFIG.shop = s.shop || DEFAULT_CONFIG.shop;
  DEFAULT_CONFIG.apiKey = s.apiKey || DEFAULT_CONFIG.apiKey;
  DEFAULT_CONFIG.apiSecret = s.apiSecret || DEFAULT_CONFIG.apiSecret;
} catch {
  // no secrets.js present — fall back to blank defaults
}

function read() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  } catch {
    // First run: seed config.json with the bundled defaults. From then on
    // config.json is the source of truth and Settings updates persist there.
    write(DEFAULT_CONFIG);
    return { ...DEFAULT_CONFIG };
  }
}

function write(next) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), { mode: 0o600 });
}

module.exports = { read, write, CONFIG_PATH };

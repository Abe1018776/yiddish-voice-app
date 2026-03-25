const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = {
  API_KEY: '',
  API_BASE: 'https://api.kohnai.ai',
  MODEL: 'gemini',
  DASHBOARD_URL: 'https://asr.kohnai.ai/dashboard.html',
  hotkey: 'Ctrl+Shift+Space',
  autoPlace: true,
  userEmail: '',
  setupComplete: false,
};

let configPath = null;

function init(userDataPath) {
  configPath = path.join(userDataPath, 'config.json');
}

function ensureInitialized() {
  if (!configPath) {
    throw new Error('Config manager not initialized. Call init(userDataPath) first.');
  }
}

function load() {
  ensureInitialized();

  if (!fs.existsSync(configPath)) {
    save(DEFAULT_CONFIG);
    return { ...DEFAULT_CONFIG };
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const stored = JSON.parse(raw);
    const merged = { ...DEFAULT_CONFIG, ...stored };
    return merged;
  } catch (err) {
    save(DEFAULT_CONFIG);
    return { ...DEFAULT_CONFIG };
  }
}

function save(config) {
  ensureInitialized();

  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

function get(key) {
  const config = load();
  return config[key];
}

function set(key, value) {
  const config = load();
  config[key] = value;
  save(config);
}

module.exports = { init, load, save, get, set, DEFAULT_CONFIG };

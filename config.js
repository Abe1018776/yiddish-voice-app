const fs = require('fs');
const path = require('path');

// These values are locked and cannot be changed by users.
const LOCKED_CONFIG = {
  runpodPodUrl: 'https://83l8gsdzgy1m0w-8000.proxy.runpod.net',
  language: 'yi',
  // Vertex AI — owner's project (locked)
  vertexAuthMethod: 'service-account',
  vertexProjectId: 'fink-partnership',
  vertexRegion: 'us-central1',
  vertexModel: '2953172783485419520',
  vertexEndpointId: '5718022314876993536',
};

const DEFAULT_CONFIG = {
  provider: 'runpod-pod',
  hotkey: 'Ctrl+Shift+Space',
  autoPlace: true,
  vertexServiceAccountPath: '',
  userEmail: '',
  setupComplete: false,
};

let configPath = null;

/**
 * Initialize the config manager with the directory where config.json should live.
 * Typically called with app.getPath('userData') from Electron.
 * @param {string} userDataPath - The directory to store config.json in.
 */
function init(userDataPath) {
  configPath = path.join(userDataPath, 'config.json');
}

/**
 * Ensure init() has been called before any read/write operations.
 */
function ensureInitialized() {
  if (!configPath) {
    throw new Error('Config manager not initialized. Call init(userDataPath) first.');
  }
}

/**
 * Load the config from disk. If the file does not exist, it is created
 * with the default values and those defaults are returned.
 * @returns {object} The current configuration object.
 */
function load() {
  ensureInitialized();

  if (!fs.existsSync(configPath)) {
    save(DEFAULT_CONFIG);
    return { ...DEFAULT_CONFIG };
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const stored = JSON.parse(raw);
    // Merge with defaults, then always override with locked values
    const merged = { ...DEFAULT_CONFIG, ...stored, ...LOCKED_CONFIG };
    return merged;
  } catch (err) {
    // Corrupted file — reset to defaults
    save(DEFAULT_CONFIG);
    return { ...DEFAULT_CONFIG, ...LOCKED_CONFIG };
  }
}

/**
 * Write a full config object to disk, replacing the existing file.
 * @param {object} config - The configuration object to persist.
 */
function save(config) {
  ensureInitialized();

  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Get a single config value by key.
 * @param {string} key - The configuration key to retrieve.
 * @returns {*} The value, or undefined if the key does not exist.
 */
function get(key) {
  const config = load();
  return config[key];
}

/**
 * Set a single config value and persist the change to disk.
 * @param {string} key   - The configuration key to update.
 * @param {*}      value - The new value.
 */
function set(key, value) {
  const config = load();
  config[key] = value;
  save(config);
}

module.exports = { init, load, save, get, set, DEFAULT_CONFIG };

const { net } = require('electron');
const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(require('os').homedir(), 'yiddish-debug.log');
function debugLog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch(e) {}
}

/**
 * Makes an HTTPS request using Electron's net module (Chromium network stack).
 * This bypasses web filters that only intercept Node.js https requests.
 */
function electronRequest(method, url, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs = 120000;
    let timer = setTimeout(() => {
      request.abort();
      reject(new Error('Request timed out after 120s'));
    }, timeoutMs);

    const request = net.request({ method, url });

    for (const [key, value] of Object.entries(headers)) {
      request.setHeader(key, value);
    }

    if (payload && !headers['Content-Type']) {
      request.setHeader('Content-Type', 'application/json');
    }

    request.on('response', (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        clearTimeout(timer);
        const body = Buffer.concat(chunks).toString('utf-8');
        resolve({ statusCode: response.statusCode, body });
      });
      response.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    request.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    if (payload) {
      request.write(payload);
    }
    request.end();
  });
}

/**
 * Makes an HTTPS POST request and returns the parsed JSON response.
 * Uses Electron's net module (Chromium stack) to bypass web filters.
 */
function httpsPost(url, body, headers = {}) {
  const payload = JSON.stringify(body);
  return electronRequest('POST', url, payload, headers).then(({ statusCode, body: raw }) => {
    try {
      const json = JSON.parse(raw);
      if (statusCode >= 200 && statusCode < 300) {
        return json;
      } else {
        throw new Error(`HTTP ${statusCode}: ${JSON.stringify(json)}`);
      }
    } catch (err) {
      if (err.message.startsWith('HTTP ')) throw err;
      throw new Error(`HTTP ${statusCode}: ${raw}`);
    }
  });
}

/**
 * Makes an HTTPS GET request and returns the parsed JSON response.
 * Uses Electron's net module (Chromium stack) to bypass web filters.
 */
function httpsGet(url, headers = {}) {
  return electronRequest('GET', url, null, headers).then(({ statusCode, body: raw }) => {
    try {
      const json = JSON.parse(raw);
      if (statusCode >= 200 && statusCode < 300) {
        return json;
      } else {
        throw new Error(`HTTP ${statusCode}: ${JSON.stringify(json)}`);
      }
    } catch (err) {
      if (err.message.startsWith('HTTP ')) throw err;
      throw new Error(`HTTP ${statusCode}: ${raw}`);
    }
  });
}

/**
 * Transcribe audio via the ASR API platform.
 */
async function transcribeAudio(audioBuffer, format, config) {
  const base64 = audioBuffer.toString('base64');

  const body = {
    model: config.MODEL || 'gemini',
    audio_base64: base64,
    audio_format: format || '.webm',
  };

  const result = await httpsPost(`${config.API_BASE}/v1/transcribe`, body, {
    'Authorization': `Bearer ${config.API_KEY}`,
    'Content-Type': 'application/json',
  });

  return { text: result.text, creditsUsed: result.credits_used, remaining: result.remaining_credits };
}

/**
 * Main transcribe entry point (called from main.js).
 */
async function transcribe(audioBuffer, provider, config) {
  const start = Date.now();

  try {
    const result = await transcribeAudio(audioBuffer, '.webm', config);
    const latencyMs = Date.now() - start;

    return {
      text: result.text,
      provider: config.MODEL || 'gemini',
      latencyMs,
      creditsUsed: result.creditsUsed,
      remaining: result.remaining,
    };
  } catch (err) {
    console.error(`[transcribe] error:`, err.message);
    debugLog(`ERROR: ${err.message}\n${err.stack}`);
    return { text: '', error: err.message };
  }
}

module.exports = { transcribe, transcribeAudio, httpsGet };

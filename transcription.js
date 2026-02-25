const { net } = require('electron');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { transcribeWithVertexAI } = require('./vertex-transcription');

const LOG_FILE = path.join(require('os').homedir(), 'yiddish-debug.log');
function debugLog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch(e) {}
}

/**
 * Makes an HTTPS request using Electron's net module (Chromium network stack).
 * This bypasses web filters that only intercept Node.js https requests.
 *
 * @param {string} method - HTTP method (GET, POST, etc.)
 * @param {string} url - Full URL
 * @param {Buffer|string|null} payload - Request body (null for GET)
 * @param {object} [headers] - Additional headers
 * @returns {Promise<{statusCode: number, body: string}>} Raw response
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
 * Transcribe audio using Google Gemini with a custom fine-tuned model.
 *
 * @param {Buffer} audioBuffer - Raw audio data
 * @param {object} config - Configuration object
 * @returns {Promise<string>} Transcription text
 */
async function transcribeWithGemini(audioBuffer, config) {
  const { geminiApiKey, geminiModel } = config;

  if (!geminiApiKey) throw new Error('Missing geminiApiKey in config');
  if (!geminiModel) throw new Error('Missing geminiModel in config');

  const base64Audio = audioBuffer.toString('base64');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${geminiApiKey}`;

  const body = {
    contents: [
      {
        parts: [
          {
            inline_data: {
              mime_type: 'audio/webm',
              data: base64Audio,
            },
          },
          {
            text: 'Transcribe this Yiddish audio accurately.',
          },
        ],
      },
    ],
  };

  const response = await httpsPost(url, body);

  const text =
    response?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (typeof text !== 'string') {
    throw new Error('Unexpected Gemini response structure: ' + JSON.stringify(response));
  }

  return text.trim();
}

/**
 * Transcribe audio using regular Google Gemini (non-fine-tuned) via Vertex AI.
 * Uses the service account auth to call a base Gemini model (e.g. gemini-2.5-flash).
 *
 * @param {Buffer} audioBuffer - Raw audio data
 * @param {object} config - Configuration object
 * @returns {Promise<string>} Transcription text
 */
async function transcribeWithGeminiDirect(audioBuffer, config) {
  // Re-use Vertex AI service account auth with a base model
  const vertexConfig = {
    ...config,
    vertexModel: config.geminiDirectModel || 'gemini-2.5-flash',
    vertexEndpointId: '', // Use publisher path, not endpoint
  };

  return transcribeWithVertexAI(audioBuffer, vertexConfig);
}

/**
 * Parse the ivrit.ai handler response format.
 * The output is an array of segment arrays: [[{start, end, text}, ...], ...]
 * Concatenates all segment text across all arrays.
 *
 * @param {Array} output - The output field from the ivrit.ai response
 * @returns {string} Concatenated transcription text
 */
function parseIvritAiOutput(output) {
  const textParts = [];
  for (const segmentArray of output) {
    if (Array.isArray(segmentArray)) {
      for (const segment of segmentArray) {
        if (segment && typeof segment.text === 'string') {
          textParts.push(segment.text.trim());
        }
      }
    }
  }
  return textParts.join(' ').trim();
}

/**
 * Poll a RunPod async job until it completes or fails.
 *
 * @param {string} endpointId - RunPod endpoint ID
 * @param {string} jobId - The job ID to poll
 * @param {string} apiKey - RunPod API key
 * @param {number} [maxWaitMs=120000] - Maximum time to wait (default 2 minutes)
 * @param {number} [pollIntervalMs=3000] - Interval between polls (default 3 seconds)
 * @returns {Promise<object>} Final job response
 */
async function pollRunpodJob(endpointId, jobId, apiKey, maxWaitMs = 120000, pollIntervalMs = 3000) {
  const statusUrl = `https://api.runpod.ai/v2/${endpointId}/status/${jobId}`;
  const headers = { Authorization: `Bearer ${apiKey}` };
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    const result = await httpsGet(statusUrl, headers);

    if (result.status === 'COMPLETED') {
      return result;
    }

    if (result.status === 'FAILED') {
      throw new Error(`RunPod job ${jobId} failed: ${JSON.stringify(result.error || result)}`);
    }

    if (result.status === 'CANCELLED') {
      throw new Error(`RunPod job ${jobId} was cancelled`);
    }

    // Status is IN_QUEUE or IN_PROGRESS - wait and poll again
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(`RunPod job ${jobId} timed out after ${maxWaitMs}ms`);
}

/**
 * Transcribe audio using a RunPod serverless Whisper endpoint fine-tuned for Yiddish.
 * Uses the ivrit.ai handler input format, with fallback to simple format parsing.
 *
 * For short audio, uses the /runsync endpoint. If runsync returns IN_QUEUE or
 * IN_PROGRESS (job too long for sync), falls back to polling via /status.
 *
 * @param {Buffer} audioBuffer - Raw audio data
 * @param {object} config - Configuration object
 * @param {string} config.runpodApiKey - RunPod API key
 * @param {string} config.whisperEndpointId - RunPod endpoint ID for the Whisper model
 * @param {string} [config.whisperModel] - Model name (default: ivrit-ai/yi-whisper-large-v3)
 * @returns {Promise<string>} Transcription text
 */
async function transcribeWithRunpodWhisper(audioBuffer, config) {
  const { runpodApiKey, whisperEndpointId } = config;
  const whisperModel = config.whisperModel || 'ivrit-ai/yi-whisper-large-v3';

  if (!runpodApiKey) throw new Error('Missing runpodApiKey in config');
  if (!whisperEndpointId) throw new Error('Missing whisperEndpointId in config');

  const base64Audio = audioBuffer.toString('base64');
  const url = `https://api.runpod.ai/v2/${whisperEndpointId}/run`;

  // The user's Yiddish endpoint (fink5984zs/runpod-stable-ts-yi) uses this format.
  // Falls back to ivrit.ai format if whisperInputFormat is set to 'ivrit'.
  const useIvritFormat = config.whisperInputFormat === 'ivrit';
  const body = useIvritFormat
    ? {
        input: {
          type: 'blob',
          data: base64Audio,
          engine: 'faster-whisper',
          model: whisperModel,
          transcribe_args: { language: 'yi' },
        },
      }
    : {
        input: {
          audio: base64Audio,
          language: 'yi',
        },
      };

  const headers = {
    Authorization: `Bearer ${runpodApiKey}`,
  };

  let response = await httpsPost(url, body, headers);

  // /run always returns async - poll until completion
  const jobId = response.id;
  if (!jobId) {
    throw new Error('RunPod returned no job ID: ' + JSON.stringify(response));
  }
  response = await pollRunpodJob(whisperEndpointId, jobId, runpodApiKey, 120000, 1500);

  const output = response?.output;

  // ivrit.ai format: output is an array of segment arrays
  if (Array.isArray(output)) {
    const text = parseIvritAiOutput(output);
    if (text) {
      return text;
    }
  }

  // Fallback: simple format where output is an object with a text/transcription field
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const text = output.transcription || output.text;
    if (typeof text === 'string') {
      return text.trim();
    }
  }

  throw new Error('Unexpected RunPod Whisper response structure: ' + JSON.stringify(response));
}

/**
 * Transcribe audio using a RunPod serverless OmniASR (Meta) endpoint.
 *
 * @param {Buffer} audioBuffer - Raw audio data
 * @param {object} config - Configuration object
 * @returns {Promise<string>} Transcription text
 */
async function transcribeWithRunpodOmniasr(audioBuffer, config) {
  const { runpodApiKey, omnisarEndpointId } = config;

  if (!runpodApiKey) throw new Error('Missing runpodApiKey in config');
  if (!omnisarEndpointId) throw new Error('Missing omnisarEndpointId in config');

  const base64Audio = audioBuffer.toString('base64');
  const url = `https://api.runpod.ai/v2/${omnisarEndpointId}/run`;

  const body = {
    input: {
      audio_base64: base64Audio,
      language: 'yid_Hebr',
    },
  };

  const headers = {
    Authorization: `Bearer ${runpodApiKey}`,
  };

  let response = await httpsPost(url, body, headers);

  // Handle async/queued responses
  if (response.status === 'IN_QUEUE' || response.status === 'IN_PROGRESS') {
    const jobId = response.id;
    if (!jobId) {
      throw new Error('RunPod returned async status but no job ID: ' + JSON.stringify(response));
    }
    response = await pollRunpodJob(omnisarEndpointId, jobId, runpodApiKey);
  }

  const text = response?.output?.text;

  if (typeof text !== 'string') {
    throw new Error('Unexpected RunPod OmniASR response structure: ' + JSON.stringify(response).substring(0, 500));
  }

  return text.trim();
}

/**
 * Transcribe audio using a direct RunPod Pod HTTP server (24/7).
 * Supports the OpenAI-compatible /v1/audio/transcriptions endpoint
 * (used by faster-whisper-server) with multipart form upload.
 *
 * @param {Buffer} audioBuffer - Raw audio data
 * @param {object} config - Configuration object
 * @returns {Promise<string>} Transcription text
 */
/**
 * Ensure the given model is loaded in the faster-whisper-server.
 * Calls POST /api/ps/{model} which is a no-op if already loaded.
 */
async function ensurePodModelLoaded(baseUrl, model) {
  const encodedModel = encodeURIComponent(model);
  const loadUrl = `${baseUrl}/api/ps/${encodedModel}`;
  await new Promise((resolve) => {
    const parsed = new URL(loadUrl);
    const req = https.request({
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname,
      method: 'POST',
      headers: { 'Content-Length': 0 },
    }, (res) => {
      res.resume(); // drain
      res.on('end', resolve);
    });
    req.on('error', () => resolve()); // non-fatal — proceed anyway
    req.end();
  });
}

async function transcribeWithRunpodPod(audioBuffer, config) {
  const { runpodPodUrl } = config;
  if (!runpodPodUrl) throw new Error('Missing runpodPodUrl in config');

  const baseUrl = runpodPodUrl.replace(/\/$/, '');
  const model = 'ivrit-ai/yi-whisper-large-v3-ct2';
  const url = baseUrl + '/v1/audio/transcriptions';

  // Build multipart form data
  const boundary = '----FormBoundary' + Date.now().toString(36) + Math.random().toString(36);
  const parts = [];

  // File part
  parts.push(Buffer.from(
    '--' + boundary + '\r\n' +
    'Content-Disposition: form-data; name="file"; filename="audio.webm"\r\n' +
    'Content-Type: audio/webm\r\n\r\n'
  ));
  parts.push(audioBuffer);
  parts.push(Buffer.from('\r\n'));

  // Model part
  parts.push(Buffer.from(
    '--' + boundary + '\r\n' +
    'Content-Disposition: form-data; name="model"\r\n\r\n' +
    'ivrit-ai/yi-whisper-large-v3-ct2\r\n'
  ));

  // Language part
  parts.push(Buffer.from(
    '--' + boundary + '\r\n' +
    'Content-Disposition: form-data; name="language"\r\n\r\n' +
    'yi\r\n'
  ));

  // Response format
  parts.push(Buffer.from(
    '--' + boundary + '\r\n' +
    'Content-Disposition: form-data; name="response_format"\r\n\r\n' +
    'json\r\n'
  ));

  // End boundary
  parts.push(Buffer.from('--' + boundary + '--\r\n'));

  const payload = Buffer.concat(parts);

  debugLog(`POD: POST ${url} payload=${payload.length} bytes`);

  // Ensure the model is loaded in memory (no-op if already loaded)
  await ensurePodModelLoaded(baseUrl, model);

  // Use Node.js https directly (proxy.runpod.net is whitelisted in web filter)
  const raw = await new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': payload.length,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    });
    req.setTimeout(300000, () => { req.destroy(); reject(new Error('Pod request timed out')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });

  debugLog(`POD: response body=${raw.substring(0, 300)}`);

  try {
    const json = JSON.parse(raw);
    if (json.text) return json.text.trim();
    throw new Error('No text in pod response: ' + raw);
  } catch (e) {
    if (e.message.startsWith('No text')) throw e;
    throw new Error('Pod response parse error: ' + raw);
  }
}

/**
 * Transcribe audio using one of the supported providers.
 *
 * @param {Buffer} audioBuffer - Buffer containing the audio data
 * @param {'gemini' | 'runpod-whisper' | 'runpod-omniasr' | 'vertex' | 'runpod-pod'} provider - Which backend to use
 * @param {object} config - Provider credentials and identifiers
 * @param {string} [config.geminiApiKey] - Google Gemini API key
 * @param {string} [config.geminiModel] - Gemini model ID (e.g. custom fine-tuned model)
 * @param {string} [config.runpodApiKey] - RunPod API key
 * @param {string} [config.whisperEndpointId] - RunPod endpoint ID for the Whisper model
 * @param {string} [config.omnisarEndpointId] - RunPod endpoint ID for the OmniASR model
 * @returns {Promise<{ text: string, provider: string, latencyMs: number } | { text: string, error: string }>}
 */
async function transcribe(audioBuffer, provider, config) {
  const start = Date.now();

  try {
    let text;

    switch (provider) {
      case 'gemini':
        text = await transcribeWithGemini(audioBuffer, config);
        break;
      case 'gemini-direct':
        text = await transcribeWithGeminiDirect(audioBuffer, config);
        break;
      case 'runpod-whisper':
        text = await transcribeWithRunpodWhisper(audioBuffer, config);
        break;
      case 'runpod-omniasr':
        text = await transcribeWithRunpodOmniasr(audioBuffer, config);
        break;
      case 'vertex':
        text = await transcribeWithVertexAI(audioBuffer, config);
        break;
      case 'runpod-pod':
        text = await transcribeWithRunpodPod(audioBuffer, config);
        break;
      default:
        throw new Error(`Unknown provider: ${provider}. Must be one of: gemini, gemini-direct, runpod-whisper, runpod-omniasr, vertex, runpod-pod`);
    }

    const latencyMs = Date.now() - start;

    return { text, provider, latencyMs };
  } catch (err) {
    console.error(`[transcribe] ${provider} error:`, err.message);
    debugLog(`ERROR [${provider}]: ${err.message}\n${err.stack}`);
    return { text: '', error: `[${provider}] ${err.message}` };
  }
}

module.exports = { transcribe };

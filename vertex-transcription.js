const { net } = require('electron');
const { getAccessToken } = require('./vertex-auth.js');

/**
 * Transcribe audio using Google Vertex AI (Gemini model).
 *
 * @param {Buffer} audioBuffer - Raw audio data to transcribe.
 * @param {object} config - Vertex AI configuration.
 * @param {string} [config.vertexProjectId] - GCP project ID (required for service-account auth).
 * @param {string} [config.vertexRegion='us-central1'] - GCP region (service-account auth only).
 * @param {string} [config.vertexModel='gemini-2.0-flash'] - Model name or numeric model/endpoint ID.
 *   For api-key auth with a fine-tuned model, pass the numeric model ID (e.g. '2953172783485419520')
 *   or the numeric endpoint ID. Numeric IDs are routed via the tunedModels/ prefix; string names
 *   are routed via the models/ prefix on the Gemini API.
 * @param {'service-account'|'api-key'} config.vertexAuthMethod - Auth method (required).
 *   - 'service-account': Standard Vertex AI endpoint ({region}-aiplatform.googleapis.com).
 *   - 'api-key': Gemini API endpoint (generativelanguage.googleapis.com) -- supports fine-tuned models.
 * @param {string} [config.vertexServiceAccountPath] - Path to service account JSON key file.
 * @param {string} [config.vertexApiKey] - API key for api-key auth (e.g. Google AI Studio key).
 * @returns {Promise<string>} The transcribed text.
 */
async function transcribeWithVertexAI(audioBuffer, config) {
  validateConfig(config);

  const model = config.vertexModel || 'gemini-2.0-flash';

  const base64Audio = audioBuffer.toString('base64');

  const requestBody = JSON.stringify({
    contents: [
      {
        role: 'user',
        parts: [
          {
            inline_data: {
              mime_type: 'audio/webm',
              data: base64Audio,
            },
          },
          {
            text: 'Transcribe this Yiddish audio accurately. Output only the transcription.',
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 8192,
    },
  });

  let url;
  let headers = { 'Content-Type': 'application/json' };

  if (config.vertexAuthMethod === 'api-key') {
    // ---- Gemini API path (supports fine-tuned models) ----
    const isNumericId = /^\d+$/.test(model);
    const modelPrefix = isNumericId ? 'tunedModels' : 'models';
    url = `https://generativelanguage.googleapis.com/v1beta/${modelPrefix}/${model}:generateContent?key=${config.vertexApiKey}`;
  } else {
    // ---- Standard Vertex AI path (service-account auth) ----
    const projectId = config.vertexProjectId;
    const region = config.vertexRegion || 'us-central1';

    const { token } = await getAccessToken(config);

    const isNumericModel = /^\d+$/.test(model);
    const endpointId = config.vertexEndpointId || model;
    let apiPath;

    if (isNumericModel) {
      apiPath = `/v1/projects/${projectId}/locations/${region}/endpoints/${endpointId}:generateContent`;
    } else {
      apiPath = `/v1/projects/${projectId}/locations/${region}/publishers/google/models/${model}:generateContent`;
    }

    url = `https://${region}-aiplatform.googleapis.com${apiPath}`;
    headers['Authorization'] = `Bearer ${token}`;
  }

  const responseBody = await makeRequest(url, requestBody, headers);

  let parsed;
  try {
    parsed = JSON.parse(responseBody);
  } catch (err) {
    throw new Error(`Failed to parse Vertex AI response as JSON: ${err.message}`);
  }

  if (parsed.error) {
    const errMsg = parsed.error.message || JSON.stringify(parsed.error);
    throw new Error(`Vertex AI API error: ${errMsg}`);
  }

  const text = extractTranscription(parsed);
  return text;
}

/**
 * Validate that all required configuration fields are present.
 *
 * @param {object} config
 */
function validateConfig(config) {
  if (!config) {
    throw new Error('Config is required for Vertex AI transcription.');
  }

  if (!config.vertexAuthMethod) {
    throw new Error('Config field "vertexAuthMethod" is required.');
  }

  const validMethods = ['service-account', 'api-key'];
  if (!validMethods.includes(config.vertexAuthMethod)) {
    throw new Error(
      `Config field "vertexAuthMethod" must be one of: ${validMethods.join(', ')}. Got: "${config.vertexAuthMethod}".`
    );
  }

  if (config.vertexAuthMethod === 'service-account') {
    if (!config.vertexProjectId) {
      throw new Error(
        'Config field "vertexProjectId" is required when vertexAuthMethod is "service-account".'
      );
    }
    if (!config.vertexServiceAccountPath) {
      throw new Error(
        'Config field "vertexServiceAccountPath" is required when vertexAuthMethod is "service-account".'
      );
    }
  }

  if (config.vertexAuthMethod === 'api-key' && !config.vertexApiKey) {
    throw new Error(
      'Config field "vertexApiKey" is required when vertexAuthMethod is "api-key".'
    );
  }
}

/**
 * Extract the transcription text from the Vertex AI response.
 *
 * @param {object} response - Parsed JSON response from Vertex AI.
 * @returns {string} The transcribed text.
 */
function extractTranscription(response) {
  if (
    !response.candidates ||
    !Array.isArray(response.candidates) ||
    response.candidates.length === 0
  ) {
    throw new Error('Vertex AI response contains no candidates.');
  }

  const candidate = response.candidates[0];

  if (!candidate.content || !candidate.content.parts || candidate.content.parts.length === 0) {
    throw new Error('Vertex AI response candidate contains no content parts.');
  }

  const text = candidate.content.parts[0].text;

  if (typeof text !== 'string') {
    throw new Error('Vertex AI response candidate part does not contain text.');
  }

  return text.trim();
}

/**
 * Make an HTTPS request using Electron's net module (Chromium network stack).
 * Bypasses web filters that intercept Node.js https requests.
 *
 * @param {string} url - Full URL to POST to.
 * @param {string} body - Request body to send.
 * @param {object} headers - Request headers.
 * @returns {Promise<string>} The raw response body.
 */
function makeRequest(url, body, headers) {
  return new Promise((resolve, reject) => {
    let timer = setTimeout(() => {
      request.abort();
      reject(new Error('Vertex AI request timed out after 120s'));
    }, 120000);

    const request = net.request({ method: 'POST', url });

    for (const [key, value] of Object.entries(headers)) {
      request.setHeader(key, value);
    }

    request.on('response', (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        clearTimeout(timer);
        const responseBody = Buffer.concat(chunks).toString('utf-8');

        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Vertex AI request failed with status ${response.statusCode}: ${responseBody}`));
          return;
        }

        resolve(responseBody);
      });
      response.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`Vertex AI request error: ${err.message}`));
      });
    });

    request.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Vertex AI request error: ${err.message}`));
    });

    request.write(body);
    request.end();
  });
}

module.exports = { transcribeWithVertexAI };

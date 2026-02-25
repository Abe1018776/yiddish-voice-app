/**
 * Vertex AI Authentication Module
 *
 * Supports two authentication methods:
 *   1. Service Account JSON file - JWT-based OAuth2 token exchange
 *   2. API Key - Simple pass-through authentication
 *
 * Uses only built-in Node.js modules (crypto, https, fs, path).
 */

const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Token cache
// ---------------------------------------------------------------------------

let cachedToken = null;   // { token: string, expiresAt: number }

/**
 * Clears the cached access token so the next call to getAccessToken()
 * will perform a fresh token exchange.
 */
function clearTokenCache() {
  cachedToken = null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Base64url-encode a Buffer or string (RFC 7515).
 */
function base64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/**
 * Build and sign a JWT for the Google OAuth2 token endpoint.
 *
 * @param {object} serviceAccount - Parsed service account JSON key file.
 * @returns {string} Signed JWT (compact serialisation).
 */
function createSignedJwt(serviceAccount) {
  const nowSeconds = Math.floor(Date.now() / 1000);

  const header = {
    alg: 'RS256',
    typ: 'JWT',
  };

  const payload = {
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signingInput = encodedHeader + '.' + encodedPayload;

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();

  const signature = signer.sign(serviceAccount.private_key);
  const encodedSignature = base64url(signature);

  return signingInput + '.' + encodedSignature;
}

/**
 * Exchange a signed JWT for a Google OAuth2 access token.
 *
 * POSTs to https://oauth2.googleapis.com/token with:
 *   grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer
 *   assertion=<jwt>
 *
 * @param {string} jwt - The signed JWT.
 * @returns {Promise<{access_token: string, expires_in: number}>}
 */
function exchangeJwtForToken(jwt) {
  return new Promise((resolve, reject) => {
    const body = 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') +
      '&assertion=' + encodeURIComponent(jwt);

    const options = {
      hostname: 'oauth2.googleapis.com',
      port: 443,
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode !== 200) {
            reject(new Error(
              'Token exchange failed (HTTP ' + res.statusCode + '): ' +
              (parsed.error_description || parsed.error || data)
            ));
            return;
          }
          resolve(parsed);
        } catch (err) {
          reject(new Error('Failed to parse token response: ' + err.message));
        }
      });
    });

    req.on('error', (err) => {
      reject(new Error('Token exchange request failed: ' + err.message));
    });

    req.write(body);
    req.end();
  });
}

/**
 * Read and parse the service account JSON key file.
 *
 * @param {string} filePath - Absolute or relative path to the key file.
 * @returns {object} Parsed service account key.
 */
function readServiceAccountKey(filePath) {
  const resolved = path.resolve(filePath);
  const raw = fs.readFileSync(resolved, 'utf8');
  const key = JSON.parse(raw);

  if (!key.client_email) {
    throw new Error('Service account key file is missing "client_email" field: ' + resolved);
  }
  if (!key.private_key) {
    throw new Error('Service account key file is missing "private_key" field: ' + resolved);
  }

  return key;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Obtain an authentication token for Vertex AI API calls.
 *
 * @param {object} config
 * @param {'service-account'|'api-key'} config.vertexAuthMethod
 * @param {string} [config.vertexServiceAccountPath] - Path to the service
 *   account JSON key file (required when vertexAuthMethod is 'service-account').
 * @param {string} [config.vertexApiKey] - API key string (required when
 *   vertexAuthMethod is 'api-key').
 *
 * @returns {Promise<{token: string, type: 'bearer'|'api-key'}>}
 */
async function getAccessToken(config) {
  if (!config || !config.vertexAuthMethod) {
    throw new Error('config.vertexAuthMethod is required ("service-account" or "api-key")');
  }

  // ----- API Key (pass-through) -----
  if (config.vertexAuthMethod === 'api-key') {
    if (!config.vertexApiKey) {
      throw new Error('config.vertexApiKey is required when vertexAuthMethod is "api-key"');
    }
    return { token: config.vertexApiKey, type: 'api-key' };
  }

  // ----- Service Account -----
  if (config.vertexAuthMethod === 'service-account') {
    if (!config.vertexServiceAccountPath) {
      throw new Error(
        'config.vertexServiceAccountPath is required when vertexAuthMethod is "service-account"'
      );
    }

    // Return cached token if it is still valid (with a 5-minute safety margin).
    const now = Date.now();
    if (cachedToken && cachedToken.expiresAt - now > 5 * 60 * 1000) {
      return { token: cachedToken.token, type: 'bearer' };
    }

    // Build a fresh JWT and exchange it for an access token.
    const serviceAccount = readServiceAccountKey(config.vertexServiceAccountPath);
    const jwt = createSignedJwt(serviceAccount);
    const response = await exchangeJwtForToken(jwt);

    // Cache the token. expires_in is in seconds; convert to an absolute ms timestamp.
    cachedToken = {
      token: response.access_token,
      expiresAt: now + response.expires_in * 1000,
    };

    return { token: cachedToken.token, type: 'bearer' };
  }

  throw new Error('Unknown vertexAuthMethod: "' + config.vertexAuthMethod + '"');
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  getAccessToken,
  clearTokenCache,
};

#!/usr/bin/env node
/**
 * Vertex AI Service Account Setup Script
 *
 * This script:
 *   1. Opens your browser to authenticate with Google
 *   2. Lists your GCP projects so you can pick the right one
 *   3. Creates a service account with Vertex AI permissions
 *   4. Downloads the JSON key file
 *   5. Updates your app config to use service-account auth
 *
 * Usage: node setup-vertex-auth.js
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const readline = require('readline');

// Google's public OAuth2 client credentials for desktop apps (same as gcloud CLI)
const CLIENT_ID = '764086051850-6qr4p6gpi6hn506pt8ejuq83di341hur.apps.googleusercontent.com';
const CLIENT_SECRET = 'd-FL95Q19q7MQmFpd7hHD0Ty';
const SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
].join(' ');

const KEY_OUTPUT_DIR = path.join(__dirname);
const CONFIG_PATH = path.join(
  process.env.APPDATA || path.join(process.env.HOME || process.env.USERPROFILE, 'AppData', 'Roaming'),
  'yiddish-voice-app',
  'config.json'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function httpsRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, data: json });
        } catch {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function openBrowser(url) {
  const cmd = process.platform === 'win32'
    ? `start "" "${url}"`
    : process.platform === 'darwin'
    ? `open "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd);
}

// ---------------------------------------------------------------------------
// OAuth2 Authorization Code Flow with localhost redirect
// ---------------------------------------------------------------------------

function getAuthCodeViaLocalServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>Authentication successful!</h2><p>You can close this tab and return to the terminal.</p></body></html>');
        server.close();
        resolve(code);
      } else if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<html><body><h2>Authentication failed</h2><p>${error}</p></body></html>`);
        server.close();
        reject(new Error('Auth error: ' + error));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const redirectUri = `http://127.0.0.1:${port}`;
      const authUrl =
        'https://accounts.google.com/o/oauth2/v2/auth' +
        '?client_id=' + encodeURIComponent(CLIENT_ID) +
        '&redirect_uri=' + encodeURIComponent(redirectUri) +
        '&response_type=code' +
        '&scope=' + encodeURIComponent(SCOPES) +
        '&access_type=offline' +
        '&prompt=consent';

      console.log('\nOpening browser for Google authentication...');
      console.log('If it does not open automatically, visit:\n');
      console.log(authUrl);
      console.log();

      openBrowser(authUrl);

      // Store redirectUri on the server object for token exchange
      server._redirectUri = redirectUri;

      // Timeout after 2 minutes
      setTimeout(() => {
        server.close();
        reject(new Error('Authentication timed out after 2 minutes'));
      }, 120000);
    });

    server._getRedirectUri = () => server._redirectUri;
  });
}

async function exchangeCodeForToken(code, redirectUri) {
  const body =
    'code=' + encodeURIComponent(code) +
    '&client_id=' + encodeURIComponent(CLIENT_ID) +
    '&client_secret=' + encodeURIComponent(CLIENT_SECRET) +
    '&redirect_uri=' + encodeURIComponent(redirectUri) +
    '&grant_type=authorization_code';

  const result = await httpsRequest(
    {
      hostname: 'oauth2.googleapis.com',
      port: 443,
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    },
    body
  );

  if (result.status !== 200) {
    throw new Error('Token exchange failed: ' + JSON.stringify(result.data));
  }

  return result.data.access_token;
}

// ---------------------------------------------------------------------------
// GCP API calls
// ---------------------------------------------------------------------------

async function listProjects(accessToken) {
  const result = await httpsRequest({
    hostname: 'cloudresourcemanager.googleapis.com',
    port: 443,
    path: '/v1/projects?filter=lifecycleState%3DACTIVE&pageSize=50',
    method: 'GET',
    headers: { Authorization: 'Bearer ' + accessToken },
  });

  if (result.status !== 200) {
    throw new Error('Failed to list projects: ' + JSON.stringify(result.data));
  }

  return result.data.projects || [];
}

async function createServiceAccount(accessToken, projectId, accountId, displayName) {
  const body = JSON.stringify({
    accountId: accountId,
    serviceAccount: {
      displayName: displayName,
    },
  });

  const result = await httpsRequest(
    {
      hostname: 'iam.googleapis.com',
      port: 443,
      path: `/v1/projects/${projectId}/serviceAccounts`,
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + accessToken,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    },
    body
  );

  if (result.status === 409) {
    // Already exists - fetch it
    console.log('  Service account already exists, reusing it.');
    const email = `${accountId}@${projectId}.iam.gserviceaccount.com`;
    // Wait for propagation
    await new Promise((r) => setTimeout(r, 3000));
    return { email };
  }

  if (result.status !== 200) {
    throw new Error('Failed to create service account: ' + JSON.stringify(result.data));
  }

  // Wait for propagation before creating keys
  console.log('  Waiting for service account to propagate...');
  await new Promise((r) => setTimeout(r, 10000));

  return result.data;
}

async function grantVertexRole(accessToken, projectId, serviceAccountEmail) {
  // Get current IAM policy
  const getBody = JSON.stringify({});
  const getResult = await httpsRequest(
    {
      hostname: 'cloudresourcemanager.googleapis.com',
      port: 443,
      path: `/v1/projects/${projectId}:getIamPolicy`,
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + accessToken,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(getBody),
      },
    },
    getBody
  );

  if (getResult.status !== 200) {
    throw new Error('Failed to get IAM policy: ' + JSON.stringify(getResult.data));
  }

  const policy = getResult.data;
  const role = 'roles/aiplatform.user';
  const member = `serviceAccount:${serviceAccountEmail}`;

  // Check if binding already exists
  let roleBinding = policy.bindings?.find((b) => b.role === role);
  if (roleBinding) {
    if (roleBinding.members?.includes(member)) {
      console.log('  IAM role already granted.');
      return;
    }
    roleBinding.members.push(member);
  } else {
    if (!policy.bindings) policy.bindings = [];
    policy.bindings.push({ role, members: [member] });
  }

  // Set updated policy
  const setBody = JSON.stringify({ policy });
  const setResult = await httpsRequest(
    {
      hostname: 'cloudresourcemanager.googleapis.com',
      port: 443,
      path: `/v1/projects/${projectId}:setIamPolicy`,
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + accessToken,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(setBody),
      },
    },
    setBody
  );

  if (setResult.status !== 200) {
    throw new Error('Failed to set IAM policy: ' + JSON.stringify(setResult.data));
  }
}

async function createServiceAccountKey(accessToken, projectId, accountEmail) {
  const body = JSON.stringify({ keyAlgorithm: 'KEY_ALG_RSA_2048' });

  const result = await httpsRequest(
    {
      hostname: 'iam.googleapis.com',
      port: 443,
      path: `/v1/projects/${projectId}/serviceAccounts/${accountEmail}/keys`,
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + accessToken,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    },
    body
  );

  if (result.status !== 200) {
    throw new Error('Failed to create key: ' + JSON.stringify(result.data));
  }

  // privateKeyData is base64-encoded JSON
  const keyJson = Buffer.from(result.data.privateKeyData, 'base64').toString('utf-8');
  return JSON.parse(keyJson);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== Vertex AI Service Account Setup ===\n');

  // Step 1: Authenticate
  let accessToken;
  let redirectUri;

  // Start local server and get redirect URI before auth
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  redirectUri = `http://127.0.0.1:${port}`;
  server.close();

  // Now do the auth flow with a known redirect URI
  const authCodePromise = new Promise((resolve, reject) => {
    const authServer = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h2 style="color:#4ade80">Authentication successful!</h2><p>You can close this tab and return to the terminal.</p></body></html>');
        authServer.close();
        resolve(code);
      } else if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<html><body><h2>Error: ${error}</h2></body></html>`);
        authServer.close();
        reject(new Error(error));
      }
    });

    authServer.listen(port, '127.0.0.1', () => {
      const authUrl =
        'https://accounts.google.com/o/oauth2/v2/auth' +
        '?client_id=' + encodeURIComponent(CLIENT_ID) +
        '&redirect_uri=' + encodeURIComponent(redirectUri) +
        '&response_type=code' +
        '&scope=' + encodeURIComponent(SCOPES) +
        '&access_type=offline' +
        '&prompt=consent';

      console.log('Opening browser for Google authentication...');
      console.log('If it does not open, visit this URL:\n');
      console.log(authUrl + '\n');
      openBrowser(authUrl);
    });

    setTimeout(() => {
      authServer.close();
      reject(new Error('Timed out waiting for authentication'));
    }, 120000);
  });

  const authCode = await authCodePromise;
  console.log('Got authorization code, exchanging for access token...');

  accessToken = await exchangeCodeForToken(authCode, redirectUri);
  console.log('Authenticated successfully!\n');

  // Step 2: List projects
  console.log('Fetching your GCP projects...\n');
  const projects = await listProjects(accessToken);

  if (projects.length === 0) {
    console.error('No GCP projects found. Please create a project first at https://console.cloud.google.com');
    process.exit(1);
  }

  console.log('Your GCP Projects:');
  projects.forEach((p, i) => {
    console.log(`  [${i + 1}] ${p.projectId} - ${p.name}`);
  });

  // Accept project selection via CLI arg or stdin
  let projectId;
  const cliProjectId = process.argv[2];

  if (cliProjectId) {
    // Direct project ID passed as CLI arg
    const found = projects.find((p) => p.projectId === cliProjectId);
    if (found) {
      projectId = found.projectId;
    } else {
      // Try as index
      const idx = parseInt(cliProjectId, 10) - 1;
      if (idx >= 0 && idx < projects.length) {
        projectId = projects[idx].projectId;
      } else {
        console.error('Project not found:', cliProjectId);
        process.exit(1);
      }
    }
  } else {
    const choice = await prompt('\nEnter the number of the project with your fine-tuned model: ');
    const projectIndex = parseInt(choice, 10) - 1;
    if (projectIndex < 0 || projectIndex >= projects.length) {
      console.error('Invalid selection.');
      process.exit(1);
    }
    projectId = projects[projectIndex].projectId;
  }
  console.log(`\nSelected project: ${projectId}\n`);

  // Step 3: Create service account
  const saId = 'yiddish-voice-vertex';
  const saDisplayName = 'Yiddish Voice App - Vertex AI';

  console.log('Creating service account...');
  const sa = await createServiceAccount(accessToken, projectId, saId, saDisplayName);
  const saEmail = sa.email || `${saId}@${projectId}.iam.gserviceaccount.com`;
  console.log(`  Email: ${saEmail}`);

  // Step 4: Grant Vertex AI User role
  console.log('Granting Vertex AI User role...');
  await grantVertexRole(accessToken, projectId, saEmail);
  console.log('  Done.');

  // Step 5: Create and download JSON key (with retry for propagation)
  console.log('Creating JSON key...');
  let keyData;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      keyData = await createServiceAccountKey(accessToken, projectId, saEmail);
      break;
    } catch (err) {
      if (attempt < 3 && err.message.includes('does not exist')) {
        console.log(`  Attempt ${attempt} failed (propagation delay), retrying in 10s...`);
        await new Promise((r) => setTimeout(r, 10000));
      } else {
        throw err;
      }
    }
  }
  const keyFilePath = path.join(KEY_OUTPUT_DIR, 'vertex-service-account.json');
  fs.writeFileSync(keyFilePath, JSON.stringify(keyData, null, 2), 'utf-8');
  console.log(`  Saved to: ${keyFilePath}`);

  // Step 6: Update app config
  console.log('\nUpdating app config...');
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    // fresh config
  }

  config.vertexAuthMethod = 'service-account';
  config.vertexServiceAccountPath = keyFilePath;
  config.vertexProjectId = projectId;
  config.vertexEnabled = true;

  // Ensure the config directory exists
  const configDir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  console.log('  Config updated.');

  console.log('\n=== Setup Complete ===');
  console.log(`Service account: ${saEmail}`);
  console.log(`Key file: ${keyFilePath}`);
  console.log(`Auth method: service-account`);
  console.log(`Project: ${projectId}`);
  console.log('\nYou can now use the "Vertex" provider in the app!');
}

main().catch((err) => {
  console.error('\nSetup failed:', err.message);
  process.exit(1);
});

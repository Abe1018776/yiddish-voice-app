#!/usr/bin/env node

/**
 * RunPod Serverless Deployment Helper
 *
 * Deploys Yiddish speech-recognition workers (Whisper or OmniASR)
 * as RunPod serverless endpoints via the RunPod GraphQL API.
 *
 * Usage:
 *   node deploy.js --api-key <RUNPOD_API_KEY> --worker whisper --docker-image youruser/yiddish-whisper:latest
 *   node deploy.js --api-key <RUNPOD_API_KEY> --worker omniasr --docker-image youruser/yiddish-omniasr:latest --gpu-type "NVIDIA A40"
 */

const https = require("https");
const { URL } = require("url");

// ---------------------------------------------------------------------------
// Configuration defaults per worker type
// ---------------------------------------------------------------------------

const WORKER_CONFIGS = {
  whisper: {
    endpointName: "yiddish-whisper",
    templateName: "yiddish-whisper-worker",
    dockerStartCmd: "python handler.py",
    containerDiskInGb: 20,
    volumeInGb: 50,
    env: [{ key: "MODEL_PATH", value: "/models/whisper-yiddish" }],
  },
  omniasr: {
    endpointName: "yiddish-omniasr",
    templateName: "yiddish-omniasr-worker",
    dockerStartCmd: "python handler.py",
    containerDiskInGb: 20,
    volumeInGb: 50,
    env: [{ key: "MODEL_PATH", value: "/models/omniasr-yiddish" }],
  },
};

const DEFAULT_GPU_TYPE = "NVIDIA A40";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case "--api-key":
        args.apiKey = argv[++i];
        break;
      case "--worker":
        args.worker = argv[++i];
        break;
      case "--gpu-type":
        args.gpuType = argv[++i];
        break;
      case "--docker-image":
        args.dockerImage = argv[++i];
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${argv[i]}`);
        printUsage();
        process.exit(1);
    }
  }
  return args;
}

function printUsage() {
  console.log(`
RunPod Serverless Deployment Helper
====================================

Usage:
  node deploy.js --api-key <KEY> --worker <whisper|omniasr> --docker-image <IMAGE> [--gpu-type <GPU>]

Arguments:
  --api-key       (required) Your RunPod API key.
  --worker        (required) Worker type: "whisper" or "omniasr".
  --docker-image  (required) Fully-qualified Docker image name (e.g. youruser/yiddish-whisper:latest).
  --gpu-type      (optional) GPU type string. Default: "${DEFAULT_GPU_TYPE}".
  --help, -h      Show this help message.

Before deploying, make sure you have:
  1. Built your Docker image:
       docker build -t youruser/yiddish-whisper:latest ./whisper
  2. Pushed it to Docker Hub (or another registry RunPod can reach):
       docker push youruser/yiddish-whisper:latest
  3. Obtained your RunPod API key from https://www.runpod.io/console/user/settings
`);
}

function validateArgs(args) {
  const errors = [];
  if (!args.apiKey) errors.push("--api-key is required.");
  if (!args.worker) errors.push("--worker is required (whisper or omniasr).");
  if (args.worker && !WORKER_CONFIGS[args.worker]) {
    errors.push(`--worker must be "whisper" or "omniasr". Got: "${args.worker}".`);
  }
  if (!args.dockerImage) errors.push("--docker-image is required.");
  if (errors.length > 0) {
    errors.forEach((e) => console.error(`Error: ${e}`));
    console.error("");
    printUsage();
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// GraphQL client (uses built-in https module)
// ---------------------------------------------------------------------------

const RUNPOD_GRAPHQL_URL = "https://api.runpod.io/graphql";

/**
 * Send a GraphQL request to RunPod.
 *
 * @param {string} apiKey   RunPod API key (sent as Bearer token).
 * @param {string} query    GraphQL query / mutation string.
 * @param {object} variables Optional GraphQL variables.
 * @returns {Promise<object>} Parsed JSON response body.
 */
function graphqlRequest(apiKey, query, variables = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query, variables });
    const url = new URL(`${RUNPOD_GRAPHQL_URL}?api_key=${apiKey}`);

    const options = {
      hostname: url.hostname,
      port: 443,
      path: `${url.pathname}${url.search}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        try {
          const json = JSON.parse(raw);
          if (json.errors && json.errors.length > 0) {
            reject(
              new Error(
                `GraphQL errors:\n${json.errors.map((e) => `  - ${e.message}`).join("\n")}`
              )
            );
          } else {
            resolve(json);
          }
        } catch (parseErr) {
          reject(new Error(`Failed to parse RunPod response: ${raw}`));
        }
      });
    });

    req.on("error", (err) => reject(err));
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// RunPod mutations
// ---------------------------------------------------------------------------

/**
 * Create (or update) a serverless template on RunPod.
 *
 * @returns {Promise<{id: string, name: string}>}
 */
async function createTemplate(apiKey, { templateName, dockerImage, dockerStartCmd, containerDiskInGb, volumeInGb, env }) {
  console.log(`\nCreating template "${templateName}" with image "${dockerImage}" ...`);

  const mutation = `
    mutation SaveTemplate($input: SaveTemplateInput!) {
      saveTemplate(input: $input) {
        id
        name
      }
    }
  `;

  const variables = {
    input: {
      name: templateName,
      imageName: dockerImage,
      dockerStartCmd,
      containerDiskInGb,
      volumeInGb,
      env,
    },
  };

  const result = await graphqlRequest(apiKey, mutation, variables);
  const template = result.data.saveTemplate;
  console.log(`  Template created  ->  id: ${template.id}  name: ${template.name}`);
  return template;
}

/**
 * Create (or update) a serverless endpoint on RunPod.
 *
 * @returns {Promise<{id: string, name: string}>}
 */
async function createEndpoint(apiKey, { endpointName, templateId, gpuType }) {
  console.log(`\nCreating endpoint "${endpointName}" (GPU: ${gpuType}) ...`);

  const mutation = `
    mutation SaveEndpoint($input: SaveEndpointInput!) {
      saveEndpoint(input: $input) {
        id
        name
      }
    }
  `;

  const variables = {
    input: {
      name: endpointName,
      templateId,
      gpuIds: gpuType,
      workersMin: 0,
      workersMax: 3,
      idleTimeout: 5,
      scalerType: "QUEUE_DELAY",
      scalerValue: 4,
    },
  };

  const result = await graphqlRequest(apiKey, mutation, variables);
  const endpoint = result.data.saveEndpoint;
  console.log(`  Endpoint created  ->  id: ${endpoint.id}  name: ${endpoint.name}`);
  return endpoint;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);
  validateArgs(args);

  const workerType = args.worker;
  const config = WORKER_CONFIGS[workerType];
  const gpuType = args.gpuType || DEFAULT_GPU_TYPE;

  console.log("=".repeat(60));
  console.log("  RunPod Serverless Deployment");
  console.log("=".repeat(60));
  console.log(`  Worker type   : ${workerType}`);
  console.log(`  Docker image  : ${args.dockerImage}`);
  console.log(`  GPU type      : ${gpuType}`);
  console.log("=".repeat(60));

  // ---- Pre-flight reminder ------------------------------------------------
  console.log(`
IMPORTANT -- Before this script can succeed, make sure you have:

  1. Built the Docker image:
       docker build -t ${args.dockerImage} ./${workerType}

  2. Pushed the image to a registry RunPod can access:
       docker push ${args.dockerImage}

  3. Verified the image is publicly pullable (or configured
     RunPod registry credentials in the console).
`);

  // ---- Step 1: Create template --------------------------------------------
  let template;
  try {
    template = await createTemplate(args.apiKey, {
      templateName: config.templateName,
      dockerImage: args.dockerImage,
      dockerStartCmd: config.dockerStartCmd,
      containerDiskInGb: config.containerDiskInGb,
      volumeInGb: config.volumeInGb,
      env: config.env,
    });
  } catch (err) {
    console.error("\nFailed to create template:");
    console.error(err.message);
    process.exit(1);
  }

  // ---- Step 2: Create endpoint from template ------------------------------
  let endpoint;
  try {
    endpoint = await createEndpoint(args.apiKey, {
      endpointName: config.endpointName,
      templateId: template.id,
      gpuType,
    });
  } catch (err) {
    console.error("\nFailed to create endpoint:");
    console.error(err.message);
    process.exit(1);
  }

  // ---- Done ---------------------------------------------------------------
  console.log("\n" + "=".repeat(60));
  console.log("  Deployment complete!");
  console.log("=".repeat(60));
  console.log(`
  Endpoint ID : ${endpoint.id}
  Endpoint Name : ${endpoint.name}

  Save the endpoint ID above -- you will need it in your
  application configuration. For example, add it to your
  .env or config file:

    RUNPOD_ENDPOINT_${workerType.toUpperCase()}=${endpoint.id}

  You can invoke your endpoint via:

    POST https://api.runpod.ai/v2/${endpoint.id}/runsync
    Headers:
      Authorization: Bearer <RUNPOD_API_KEY>
      Content-Type: application/json
    Body:
      { "input": { "audio_base64": "..." } }

  Monitor your endpoint in the RunPod console:
    https://www.runpod.io/console/serverless
`);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});

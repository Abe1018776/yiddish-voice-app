# RunPod Workers -- Yiddish Voice App

This directory contains the RunPod serverless worker definitions and a
deployment helper script for the Yiddish Voice App speech-recognition
back-end.

Two worker types are supported:

| Worker    | Directory   | Description                                  |
|-----------|-------------|----------------------------------------------|
| `whisper` | `./whisper` | Fine-tuned Whisper model for Yiddish ASR     |
| `omniasr` | `./omniasr` | OmniASR model variant for Yiddish ASR        |

---

## Prerequisites

- **Docker** installed and running locally.
- A **Docker Hub** account (or any container registry that RunPod can
  pull from).
- A **RunPod** account with an API key.
  Get your API key at: <https://www.runpod.io/console/user/settings>
- **Node.js** (v16 or later) to run the deployment script.

---

## 1. Build Docker Images

Each worker has its own Dockerfile. Build from the repository root:

```bash
# Whisper worker
docker build -t <your-dockerhub-user>/yiddish-whisper:latest ./runpod-workers/whisper

# OmniASR worker
docker build -t <your-dockerhub-user>/yiddish-omniasr:latest ./runpod-workers/omniasr
```

Replace `<your-dockerhub-user>` with your actual Docker Hub username.

### What the images contain

Each image packages:

1. A Python `handler.py` that RunPod invokes for each request.
2. The model loading and inference code.
3. All Python dependencies (PyTorch, transformers, etc.).

---

## 2. Push to Docker Hub

Log in to Docker Hub (if you haven't already) and push:

```bash
docker login

# Push Whisper image
docker push <your-dockerhub-user>/yiddish-whisper:latest

# Push OmniASR image
docker push <your-dockerhub-user>/yiddish-omniasr:latest
```

If you use a private registry, make sure you configure your RunPod
account with the appropriate registry credentials under
**Settings > Container Registry** in the RunPod console.

---

## 3. Deploy Using the Script

The `deploy.js` script automates template and endpoint creation via
RunPod's GraphQL API.

### Quick start

```bash
# Deploy the Whisper worker
node runpod-workers/deploy.js \
  --api-key YOUR_RUNPOD_API_KEY \
  --worker whisper \
  --docker-image <your-dockerhub-user>/yiddish-whisper:latest

# Deploy the OmniASR worker
node runpod-workers/deploy.js \
  --api-key YOUR_RUNPOD_API_KEY \
  --worker omniasr \
  --docker-image <your-dockerhub-user>/yiddish-omniasr:latest
```

### All command-line options

| Flag             | Required | Default        | Description                          |
|------------------|----------|----------------|--------------------------------------|
| `--api-key`      | Yes      | --             | RunPod API key                       |
| `--worker`       | Yes      | --             | `whisper` or `omniasr`               |
| `--docker-image` | Yes      | --             | Full Docker image reference          |
| `--gpu-type`     | No       | `NVIDIA A40`   | GPU type to request                  |
| `--help`         | No       | --             | Print usage information              |

### What the script does

1. **Creates a RunPod template** with the Docker image, start command,
   disk/volume sizes, and environment variables.
2. **Creates a serverless endpoint** from that template with
   auto-scaling (0 min / 3 max workers, queue-delay scaler).
3. Prints the **endpoint ID** you need for your app configuration.

---

## 4. Get Endpoint IDs for the App Config

After a successful deployment the script prints the endpoint ID:

```
  Endpoint ID : abc123xyz
```

Add this to your application configuration (`.env` file or equivalent):

```env
RUNPOD_ENDPOINT_WHISPER=abc123xyz
RUNPOD_ENDPOINT_OMNIASR=def456uvw
```

You can also find your endpoint IDs any time in the RunPod console at
<https://www.runpod.io/console/serverless>.

### Calling the endpoint

```bash
curl -X POST "https://api.runpod.ai/v2/<ENDPOINT_ID>/runsync" \
  -H "Authorization: Bearer <RUNPOD_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{ "input": { "audio_base64": "<base64-encoded-audio>" } }'
```

For longer audio, use the async endpoint (`/run` instead of `/runsync`)
and poll `/status/<job_id>` for results.

---

## 5. Mounting Fine-Tuned Model Weights

There are two strategies for making your fine-tuned model weights
available inside the worker container.

### Option A: Bake weights into the Docker image

The simplest approach -- copy the model files during the Docker build:

```dockerfile
# In your Dockerfile
COPY ./model-weights /models/whisper-yiddish
```

Pros: Self-contained image, no extra setup.
Cons: Large image size; every weight update requires a new image push.

### Option B: Use a RunPod network volume

1. **Create a network volume** in the RunPod console
   (<https://www.runpod.io/console/user/storage>).
2. **Upload your weights** to the volume (e.g. via an SSH pod or the
   RunPod file manager).
3. **Reference the volume** when creating the template. The deploy
   script already allocates a 50 GB volume (`volumeInGb: 50`). Your
   `handler.py` should load the model from the mounted path (the
   `MODEL_PATH` environment variable is set to `/models/whisper-yiddish`
   or `/models/omniasr-yiddish` by default).

To change the volume size or mount path, edit the `WORKER_CONFIGS`
object at the top of `deploy.js`.

### Updating weights without re-deploying

If you use network volumes, you can update the weights on the volume
and then restart your workers from the RunPod console (or via the API)
without re-deploying the endpoint or rebuilding the Docker image.

---

## Endpoint Scaling Configuration

The deploy script creates endpoints with the following defaults:

| Setting        | Value         | Description                              |
|----------------|---------------|------------------------------------------|
| `workersMin`   | 0             | Scale to zero when idle (no cost)        |
| `workersMax`   | 3             | Maximum concurrent workers               |
| `idleTimeout`  | 5 (seconds)   | How long a worker stays warm after a job |
| `scalerType`   | `QUEUE_DELAY` | Scale based on queue wait time           |
| `scalerValue`  | 4 (seconds)   | Target queue delay before scaling up     |

To change these, edit the `createEndpoint` function in `deploy.js`.

---

## Troubleshooting

| Problem                          | Solution                                                 |
|----------------------------------|----------------------------------------------------------|
| `401 Unauthorized`               | Check that your `--api-key` is correct and active.       |
| Image pull fails                 | Ensure the image is pushed and publicly accessible (or configure registry credentials). |
| Worker crashes on startup        | Check the worker logs in the RunPod console. Common cause: missing Python dependencies. |
| Out of GPU memory                | Try a larger GPU type (`--gpu-type "NVIDIA A100 80GB"`). |
| Endpoint stays at 0 workers      | Send a request; workers scale from zero on first request.|

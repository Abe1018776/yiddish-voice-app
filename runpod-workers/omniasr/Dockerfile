# RunPod Serverless Worker - OmniASR

FROM runpod/pytorch:2.1.0-py3.10-cuda11.8.0-devel-ubuntu22.04

WORKDIR /app

# Install system dependencies required by omnilingual-asr
RUN apt-get update && apt-get install -y --no-install-recommends \
    libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

# Create directory for model cache
RUN mkdir -p /models/cache

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the handler
COPY handler.py .

# Environment variables
ENV MODEL_CARD=omniASR_LLM_7B
ENV PYTHONUNBUFFERED=1
ENV HF_HOME=/models/cache

CMD ["python", "handler.py"]

# RunPod Serverless Worker - Whisper (Yiddish Fine-Tuned)
#
# NOTE: You must either:
#   1. Bake the fine-tuned Whisper model into this image by copying it
#      into /models/whisper-yiddish during the build, or
#   2. Mount it at runtime via a RunPod network volume at /models/whisper-yiddish.
#
# Option 1 example (add before the CMD line):
#   COPY ./whisper-yiddish /models/whisper-yiddish
#
# Option 2: Attach a RunPod network volume containing the model and ensure
#   MODEL_PATH points to the correct path on the mounted volume.

FROM runpod/pytorch:2.1.0-py3.10-cuda11.8.0-devel-ubuntu22.04

WORKDIR /app

# Create directory for the fine-tuned Whisper model
RUN mkdir -p /models/whisper-yiddish

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the handler
COPY handler.py .

# Environment variables
ENV MODEL_PATH=/models/whisper-yiddish
ENV PYTHONUNBUFFERED=1

CMD ["python", "handler.py"]

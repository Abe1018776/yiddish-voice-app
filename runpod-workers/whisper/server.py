"""
FastAPI Inference Server for Fine-Tuned Yiddish Whisper Model.

Designed for 24/7 RunPod GPU Pod deployment (always-on, not serverless).
Serves the ivrit-ai/yi-whisper-large-v3 model via faster_whisper with two
transcription endpoints (JSON base64 and multipart file upload).

Run with:
    uvicorn server:app --host 0.0.0.0 --port 8000
"""

import os
import sys
import base64
import tempfile
import logging
import time
from typing import Optional

from fastapi import FastAPI, File, Form, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from faster_whisper import WhisperModel

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger("whisper-server")

# ---------------------------------------------------------------------------
# Model loading (once at startup)
# ---------------------------------------------------------------------------
MODEL_PATH = os.environ.get("MODEL_PATH", "ivrit-ai/yi-whisper-large-v3")
DEVICE = os.environ.get("DEVICE", "cuda")
COMPUTE_TYPE = os.environ.get("COMPUTE_TYPE", "float16")

logger.info(
    "Loading Whisper model from %s (device=%s, compute_type=%s) ...",
    MODEL_PATH, DEVICE, COMPUTE_TYPE,
)

model: Optional[WhisperModel] = None
try:
    model = WhisperModel(MODEL_PATH, device=DEVICE, compute_type=COMPUTE_TYPE)
    logger.info("Model loaded successfully.")
except Exception as exc:
    logger.error("Failed to load model: %s", exc)

# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------
app = FastAPI(
    title="Yiddish Whisper Transcription Server",
    description="Always-on GPU inference server for yi-whisper-large-v3",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Request / Response schemas
# ---------------------------------------------------------------------------

class TranscribeRequest(BaseModel):
    audio_base64: str
    language: str = Field(default="yi")
    beam_size: int = Field(default=5, ge=1, le=20)


class SegmentOut(BaseModel):
    start: float
    end: float
    text: str


class TranscribeResponse(BaseModel):
    text: str
    segments: list[SegmentOut]
    language: str
    duration: float
    latency_ms: float


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _save_bytes_to_temp(audio_bytes: bytes, suffix: str = ".wav") -> str:
    """Write audio bytes to a named temp file and return its path."""
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    try:
        tmp.write(audio_bytes)
    finally:
        tmp.close()
    return tmp.name


def _cleanup(path: Optional[str]) -> None:
    """Silently remove a temporary file."""
    if path:
        try:
            os.unlink(path)
        except OSError:
            pass


def _transcribe(tmp_path: str, language: str, beam_size: int) -> TranscribeResponse:
    """Run faster_whisper transcription on a temp audio file."""
    if model is None:
        raise HTTPException(
            status_code=503,
            detail="Model failed to load at startup. Check server logs.",
        )

    start_time = time.time()

    segments_iter, info = model.transcribe(
        tmp_path,
        language=language,
        beam_size=beam_size,
        vad_filter=True,
    )

    segments: list[SegmentOut] = []
    text_parts: list[str] = []
    for seg in segments_iter:
        segments.append(SegmentOut(
            start=round(seg.start, 3),
            end=round(seg.end, 3),
            text=seg.text.strip(),
        ))
        text_parts.append(seg.text.strip())

    latency_ms = round((time.time() - start_time) * 1000, 1)
    duration = round(info.duration, 3)
    full_text = " ".join(text_parts)

    logger.info(
        "Transcription complete: %d segments, %.1fs audio, %.0fms latency",
        len(segments), duration, latency_ms,
    )

    return TranscribeResponse(
        text=full_text,
        segments=segments,
        language=language,
        duration=duration,
        latency_ms=latency_ms,
    )


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/health")
async def health():
    """Health check endpoint."""
    return {
        "status": "healthy" if model is not None else "model_not_loaded",
        "model": MODEL_PATH,
        "device": DEVICE,
        "compute_type": COMPUTE_TYPE,
    }


@app.post("/transcribe", response_model=TranscribeResponse)
async def transcribe(req: TranscribeRequest):
    """
    Transcribe base64-encoded audio.

    Accepts a JSON body with `audio_base64`, optional `language` (default "yi"),
    and optional `beam_size` (default 5).
    """
    tmp_path: Optional[str] = None
    try:
        try:
            audio_bytes = base64.b64decode(req.audio_base64)
        except Exception as exc:
            raise HTTPException(
                status_code=400,
                detail=f"Failed to decode base64 audio: {exc}",
            )

        logger.info("Received base64 audio: %d bytes", len(audio_bytes))
        tmp_path = _save_bytes_to_temp(audio_bytes)
        return _transcribe(tmp_path, req.language, req.beam_size)
    finally:
        _cleanup(tmp_path)


@app.post("/transcribe-file", response_model=TranscribeResponse)
async def transcribe_file(
    file: UploadFile = File(...),
    language: str = Form(default="yi"),
    beam_size: int = Form(default=5),
):
    """
    Transcribe an uploaded audio file.

    Accepts a multipart file upload with optional `language` (default "yi")
    and optional `beam_size` (default 5) form fields.
    """
    tmp_path: Optional[str] = None
    try:
        audio_bytes = await file.read()
        if not audio_bytes:
            raise HTTPException(status_code=400, detail="Uploaded file is empty.")

        # Preserve the original file extension if available
        suffix = ".wav"
        if file.filename:
            ext = os.path.splitext(file.filename)[1]
            if ext:
                suffix = ext

        logger.info(
            "Received file upload: %s (%d bytes)",
            file.filename or "<unnamed>", len(audio_bytes),
        )
        tmp_path = _save_bytes_to_temp(audio_bytes, suffix=suffix)
        return _transcribe(tmp_path, language, beam_size)
    finally:
        _cleanup(tmp_path)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

"""
RunPod Serverless Worker Handler for Fine-Tuned Yiddish Whisper Model.

Accepts base64-encoded audio or an audio URL, transcribes using a
CTranslate2-backed Whisper model (faster_whisper), and returns the
transcription with segment-level detail.
"""

import os
import sys
import base64
import tempfile
import logging
import time
import urllib.request
from typing import Any, Dict, Optional

import runpod
from faster_whisper import WhisperModel

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger("whisper-worker")

# ---------------------------------------------------------------------------
# Model loading (once at module level so it persists across requests)
# ---------------------------------------------------------------------------
DEFAULT_MODEL_PATH = "/models/whisper-yiddish"
MODEL_PATH = os.environ.get("MODEL_PATH", DEFAULT_MODEL_PATH)
DEVICE = os.environ.get("DEVICE", "cuda")
COMPUTE_TYPE = os.environ.get("COMPUTE_TYPE", "float16")

logger.info("Loading Whisper model from %s (device=%s, compute_type=%s) ...",
            MODEL_PATH, DEVICE, COMPUTE_TYPE)

try:
    model = WhisperModel(
        MODEL_PATH,
        device=DEVICE,
        compute_type=COMPUTE_TYPE,
    )
    logger.info("Model loaded successfully.")
except Exception as exc:
    logger.error("Failed to load model: %s", exc)
    model = None

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _decode_base64_audio(audio_base64: str) -> bytes:
    """Decode a base64-encoded audio string into raw bytes."""
    return base64.b64decode(audio_base64)


def _download_audio(url: str, timeout: int = 60) -> bytes:
    """Download audio bytes from a URL."""
    logger.info("Downloading audio from %s", url)
    req = urllib.request.Request(url, headers={"User-Agent": "RunPod-Whisper-Worker/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def _save_to_tempfile(audio_bytes: bytes, suffix: str = ".wav") -> str:
    """Write audio bytes to a temporary file and return its path."""
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

# ---------------------------------------------------------------------------
# Core handler
# ---------------------------------------------------------------------------

def handler(event: Dict[str, Any]) -> Dict[str, Any]:
    """
    RunPod serverless handler entry-point.

    Expected event schema
    ---------------------
    {
        "input": {
            "audio_base64": "<base64 string>",   # provide this OR audio_url
            "audio_url":    "<url string>",       # provide this OR audio_base64
            "language":     "yi",                 # optional, defaults to "yi"
            "model_id":     "<path override>"     # optional runtime model override
        }
    }

    Returns
    -------
    {
        "transcription": "<full text>",
        "segments": [ { "start": float, "end": float, "text": str }, ... ],
        "language": "yi",
        "duration": <total audio duration in seconds>
    }
    """
    global model  # noqa: PLW0603 -- allow hot-swap via model_id

    job_input: Dict[str, Any] = event.get("input", {})
    tmp_path: Optional[str] = None

    try:
        # ---- Validate model availability --------------------------------
        if model is None:
            return {"error": "Model failed to load at startup. Check worker logs."}

        # ---- Obtain audio bytes -----------------------------------------
        audio_base64: Optional[str] = job_input.get("audio_base64")
        audio_url: Optional[str] = job_input.get("audio_url")

        if not audio_base64 and not audio_url:
            return {"error": "You must provide either 'audio_base64' or 'audio_url' in the input."}

        if audio_base64:
            logger.info("Decoding base64 audio (%d chars)", len(audio_base64))
            try:
                audio_bytes = _decode_base64_audio(audio_base64)
            except Exception as exc:
                return {"error": f"Failed to decode base64 audio: {exc}"}
        else:
            try:
                audio_bytes = _download_audio(audio_url)
            except Exception as exc:
                return {"error": f"Failed to download audio from URL: {exc}"}

        logger.info("Audio size: %d bytes", len(audio_bytes))

        # ---- Write to temp file -----------------------------------------
        tmp_path = _save_to_tempfile(audio_bytes)
        logger.info("Temp audio file: %s", tmp_path)

        # ---- Optional runtime model override ----------------------------
        model_id: Optional[str] = job_input.get("model_id")
        if model_id and model_id != MODEL_PATH:
            logger.info("Runtime model override requested: %s", model_id)
            try:
                model = WhisperModel(
                    model_id,
                    device=DEVICE,
                    compute_type=COMPUTE_TYPE,
                )
                logger.info("Runtime model loaded successfully.")
            except Exception as exc:
                return {"error": f"Failed to load runtime model '{model_id}': {exc}"}

        # ---- Transcription ----------------------------------------------
        language: str = job_input.get("language", "yi")
        logger.info("Starting transcription (language=%s, beam_size=5, vad_filter=True)", language)

        start_time = time.time()
        segments_iter, info = model.transcribe(
            tmp_path,
            language=language,
            beam_size=5,
            vad_filter=True,
        )

        # Materialise the segment iterator so we can build the response.
        segments = []
        full_text_parts = []
        for seg in segments_iter:
            segments.append({
                "start": round(seg.start, 3),
                "end": round(seg.end, 3),
                "text": seg.text.strip(),
            })
            full_text_parts.append(seg.text.strip())

        elapsed = round(time.time() - start_time, 3)
        duration = round(info.duration, 3)
        transcription = " ".join(full_text_parts)

        logger.info(
            "Transcription complete: %d segments, %.1fs audio, %.1fs elapsed",
            len(segments), duration, elapsed,
        )

        return {
            "transcription": transcription,
            "segments": segments,
            "language": language,
            "duration": duration,
        }

    except Exception as exc:
        logger.exception("Unhandled error during transcription")
        return {"error": str(exc)}

    finally:
        _cleanup(tmp_path)

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    logger.info("Starting RunPod Whisper serverless worker ...")
    runpod.serverless.start({"handler": handler})

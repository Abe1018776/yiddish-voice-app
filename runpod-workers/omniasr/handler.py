"""
RunPod Serverless Worker Handler for Meta OmniASR (omniASR_LLM_7B).

Uses the ``omnilingual-asr`` package to load the omniASR_LLM_7B model at
module level so it is reused across invocations, then exposes a handler that
accepts base64-encoded audio or an audio URL, runs speech-to-text inference,
and returns the transcription.
"""

import os
import sys
import base64
import tempfile
import time
import logging
import urllib.request

import runpod
from omnilingual_asr.models.inference.pipeline import ASRInferencePipeline

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger("omniasr-worker")

# ---------------------------------------------------------------------------
# Model loading (executed once when the container starts)
# ---------------------------------------------------------------------------
MODEL_CARD = os.environ.get("MODEL_CARD", "omniASR_LLM_7B")

logger.info("Loading ASR pipeline with model_card=%s ...", MODEL_CARD)

pipeline = ASRInferencePipeline(model_card=MODEL_CARD)

logger.info("ASR pipeline loaded successfully.")

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _fetch_audio_from_url(url: str, dest_path: str) -> None:
    """Download an audio file from *url* and save it to *dest_path*."""
    logger.info("Downloading audio from URL: %s", url)
    urllib.request.urlretrieve(url, dest_path)


def _decode_base64_audio(audio_b64: str, dest_path: str) -> None:
    """Decode a base64 string and write the raw bytes to *dest_path*."""
    logger.info("Decoding base64 audio (%d chars) ...", len(audio_b64))
    audio_bytes = base64.b64decode(audio_b64)
    with open(dest_path, "wb") as f:
        f.write(audio_bytes)


# ---------------------------------------------------------------------------
# Handler
# ---------------------------------------------------------------------------
def handler(event: dict) -> dict:
    """RunPod serverless handler entry-point.

    Parameters
    ----------
    event : dict
        The RunPod event payload.  Expected schema::

            {
                "input": {
                    "audio_base64": "<base64 string>",   # one of these two
                    "audio_url": "<url>",                 # is required
                    "language": "yid_Hebr"
                }
            }

    Returns
    -------
    dict
        On success::

            {"text": "...", "language": "yid_Hebr", "duration": 3.45, "model": "omniASR_LLM_7B"}

        On failure::

            {"error": "description of what went wrong"}
    """
    try:
        input_data = event.get("input", {})

        audio_b64 = input_data.get("audio_base64")
        audio_url = input_data.get("audio_url")
        language = input_data.get("language", "yid_Hebr")

        if not audio_b64 and not audio_url:
            return {"error": "Either 'audio_base64' or 'audio_url' must be provided."}

        logger.info("Received request  language=%s", language)

        # ---- Save audio to a temp file ----
        suffix = ".wav"
        if audio_url:
            # Try to infer extension from URL
            url_path = audio_url.split("?")[0]
            if "." in url_path.split("/")[-1]:
                suffix = "." + url_path.split("/")[-1].rsplit(".", 1)[-1]

        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
        tmp_path = tmp.name
        tmp.close()

        try:
            if audio_b64:
                _decode_base64_audio(audio_b64, tmp_path)
            else:
                _fetch_audio_from_url(audio_url, tmp_path)

            # ---- Inference ----
            audio_files = [tmp_path]
            lang = [language]

            logger.info("Starting transcription (lang=%s) ...", language)
            start_time = time.time()

            results = pipeline.transcribe(audio_files, lang=lang, batch_size=1)

            inference_time = time.time() - start_time
            logger.info("Inference completed in %.2f s", inference_time)

            text = results[0] if results else ""
            logger.info("Transcription (%d chars): %s", len(text), text[:120])

            return {
                "text": text,
                "language": language,
                "duration": round(inference_time, 3),
                "model": MODEL_CARD,
            }

        finally:
            # Clean up temp file
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
                logger.info("Temp file removed: %s", tmp_path)

    except Exception as exc:
        logger.exception("Handler error: %s", exc)
        return {"error": str(exc)}


# ---------------------------------------------------------------------------
# Entry-point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    logger.info("Starting OmniASR RunPod serverless worker ...")
    runpod.serverless.start({"handler": handler})

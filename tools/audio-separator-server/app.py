"""
audio-separator stem service (vocals / instrumental)
====================================================

A tiny HTTP wrapper around the Python `audio-separator` package (the UVR /
MDX-Net models TachiDUBB Studio uses). The Node backend cannot run UVR models
itself — it has no Python and no GPU host — so separation lives here and the
dubbing pipeline talks to it through `AUDIO_SEPARATOR_URL`.

Endpoints
---------
GET  /health                    -> {"status", "model", "device"}
POST /separate                  -> upload field `audio`, optional field `model`
                                   returns {"vocals", "instrumental", "model", "job_id"}
GET  /stems/{job_id}/{name}     -> the two WAV stems

The pipeline expects the background stem to hold music and effects with the
dialogue removed, which is exactly the `instrumental` stem below.

Run it
------
    pip install -r requirements.txt
    uvicorn app:app --host 0.0.0.0 --port 8920

On a GPU box the first request downloads the model once (~70 MB for MDX-Net).
CPU-only machines work too, just slower (roughly 3-8x the length of the audio
at the model's 44.1 kHz stereo input).

Environment
-----------
SEPARATOR_DATA_DIR   where stems are written            (default ./data)
SEPARATOR_MODEL_DIR  where model weights are cached     (default ./models)
SEPARATOR_MODEL      default model file name            (default UVR-MDX-NET-Inst_HQ_3.onnx)
SEPARATOR_API_KEY    optional bearer token; when set, every request must send it
SEPARATOR_TTL_HOURS  delete stems older than this       (default 12)
SEPARATOR_MAX_MB     reject uploads larger than this    (default 2048)
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import shutil
import time
import uuid
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("audio-separator-service")

DATA_DIR = Path(os.environ.get("SEPARATOR_DATA_DIR", "./data")).resolve()
MODEL_DIR = Path(os.environ.get("SEPARATOR_MODEL_DIR", "./models")).resolve()
STEM_DIR = DATA_DIR / "stems"
DEFAULT_MODEL = os.environ.get("SEPARATOR_MODEL", "UVR-MDX-NET-Inst_HQ_3.onnx")
API_KEY = os.environ.get("SEPARATOR_API_KEY", "").strip()
TTL_HOURS = float(os.environ.get("SEPARATOR_TTL_HOURS", "12"))
MAX_BYTES = float(os.environ.get("SEPARATOR_MAX_MB", "2048")) * 1024 * 1024

STEM_DIR.mkdir(parents=True, exist_ok=True)
MODEL_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="audio-separator stem service", version="1.0.0")

# One separation at a time: these models saturate a GPU (or every CPU core the
# container has) and running two at once only makes both slower.
_run_lock = asyncio.Lock()
_separator = None
_loaded_model: Optional[str] = None


def require_key(authorization: Optional[str] = Header(default=None)) -> None:
    """Bearer-token gate. A no-op unless SEPARATOR_API_KEY is set."""
    if not API_KEY:
        return
    expected = f"Bearer {API_KEY}"
    if authorization != expected:
        raise HTTPException(status_code=401, detail="Invalid or missing API key")


def _normalise_model(name: str) -> str:
    """`UVR-MDX-NET-Inst_HQ_3` and `htdemucs` both need a file extension."""
    name = (name or "").strip() or DEFAULT_MODEL
    if Path(name).suffix.lower() in {".onnx", ".pth", ".ckpt", ".yaml", ".yml", ".bin"}:
        return name
    return f"{name}.onnx"


def get_separator(model: str):
    """Load (and cache) the separator, switching models only when asked to."""
    global _separator, _loaded_model
    if _separator is not None and _loaded_model == model:
        return _separator

    from audio_separator.separator import Separator  # import here: heavy (torch)

    log.info("Loading separation model %s", model)
    separator = Separator(
        log_level=logging.INFO,
        model_file_dir=str(MODEL_DIR),
        output_dir=str(STEM_DIR),
        output_format="WAV",
    )
    separator.load_model(model_filename=model)
    _separator = separator
    _loaded_model = model
    log.info("Model %s ready", model)
    return separator


def _purge_expired() -> None:
    """Keep the disk from filling up with stems nobody downloads twice."""
    cutoff = time.time() - TTL_HOURS * 3600
    for job_dir in STEM_DIR.glob("*"):
        try:
            if job_dir.is_dir() and job_dir.stat().st_mtime < cutoff:
                shutil.rmtree(job_dir, ignore_errors=True)
        except OSError:
            continue


def _classify(paths: list[str]) -> tuple[Optional[str], Optional[str]]:
    """Sort the model's outputs into (vocals, instrumental).

    Model files are named `<source>_(Vocals)_<model>.wav` or
    `<source>_(Instrumental)_<model>.wav`, and a few models say `(No Vocals)` — so
    compare on a squashed name (`novocals`, `instrumental`, ...) rather than exact
    separators.
    """
    vocals = instrumental = None
    for p in paths:
        name = re.sub(r"[^a-z0-9]", "", Path(p).name.lower())
        if "instrumental" in name or "novocal" in name or "accompaniment" in name:
            instrumental = p
        elif "vocal" in name:
            vocals = p
    return vocals, instrumental


async def _save_upload(upload: UploadFile, target: Path) -> int:
    """Stream the upload to disk and return its size, refusing oversized files."""
    written = 0
    with target.open("wb") as out:
        while True:
            chunk = await upload.read(1024 * 1024)
            if not chunk:
                break
            written += len(chunk)
            if written > MAX_BYTES:
                out.close()
                target.unlink(missing_ok=True)
                raise HTTPException(status_code=413, detail="Audio file too large")
            out.write(chunk)
    return written


def _run_separation(separator, audio_path: Path) -> list[str]:
    """Blocking separation, called from a worker thread."""
    return separator.separate(str(audio_path))


@app.get("/health", dependencies=[Depends(require_key)])
async def health():
    return {"status": "ok", "model": _loaded_model or _normalise_model(DEFAULT_MODEL), "busy": _run_lock.locked()}


@app.post("/separate", dependencies=[Depends(require_key)])
async def separate(
    audio: UploadFile = File(...),
    model: str = Form(default=""),
):
    _purge_expired()

    job_id = uuid.uuid4().hex[:12]
    job_dir = STEM_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    suffix = Path(audio.filename or "input.wav").suffix or ".wav"
    source = job_dir / f"source{suffix}"
    size = await _save_upload(audio, source)
    log.info("Job %s: received %s (%.1f MB)", job_id, audio.filename, size / 1048576)

    model_file = _normalise_model(model or DEFAULT_MODEL)

    # The model writes into STEM_DIR/<name>_..._<model>.wav, so move its outputs
    # into this job's folder and give them stable names the client can download.
    try:
        async with _run_lock:
            separator = await asyncio.to_thread(get_separator, model_file)
            outputs = await asyncio.to_thread(_run_separation, separator, source)
    except HTTPException:
        raise
    except Exception as err:  # keep the detail: model download failures are common
        log.exception("Job %s failed", job_id)
        shutil.rmtree(job_dir, ignore_errors=True)
        return JSONResponse(status_code=500, content={"error": f"separation failed: {err}"})

    vocals_file, instrumental_file = _classify(outputs)
    if not vocals_file or not instrumental_file:
        shutil.rmtree(job_dir, ignore_errors=True)
        return JSONResponse(
            status_code=500,
            content={
                "error": (
                    "model returned unexpected outputs "
                    f"{[Path(o).name for o in outputs]} — use a 2-stem model "
                    "(e.g. UVR-MDX-NET-Inst_HQ_3.onnx) via SEPARATOR_MODEL"
                )
            },
        )

    vocals_target = job_dir / "vocals.wav"
    instrumental_target = job_dir / "instrumental.wav"
    shutil.move(vocals_file, vocals_target)
    shutil.move(instrumental_file, instrumental_target)
    source.unlink(missing_ok=True)

    # Stems the model wrote for other jobs (older runs) are not ours to delete, but
    # files this run left behind in the shared output dir would just confuse later
    # runs, so clear any leftovers that are not inside a job folder.
    for leftover in outputs:
        leftover_path = Path(leftover)
        if leftover_path.exists() and leftover_path.parent == STEM_DIR:
            leftover_path.unlink(missing_ok=True)

    log.info("Job %s: stems ready (%.1f MB)", job_id, (vocals_target.stat().st_size + instrumental_target.stat().st_size) / 1048576)
    return {
        "job_id": job_id,
        "model": model_file,
        "vocals": f"/stems/{job_id}/vocals.wav",
        "instrumental": f"/stems/{job_id}/instrumental.wav",
    }


@app.get("/stems/{job_id}/{name}", dependencies=[Depends(require_key)])
async def stem(job_id: str, name: str):
    # UUIDs only: anything else would be a path-traversal attempt.
    if not job_id.isalnum() or name not in {"vocals.wav", "instrumental.wav"}:
        raise HTTPException(status_code=400, detail="Invalid stem path")
    path = STEM_DIR / job_id / name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Stem not found")
    return FileResponse(path, media_type="audio/wav", filename=name)

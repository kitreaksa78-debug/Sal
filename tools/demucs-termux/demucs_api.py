#!/usr/bin/env python3
"""
Demucs API — ញែកភ្លេង (vocals / instrumental) លើទូរស័ព្ទ Android តាម Termux
=====================================================================

សេវាតូចមួយដែលរុំម៉ូឌែល **Demucs** ហើយបើកជា HTTP API សម្រាប់ backend នៃគេហទំព័រ
(KhmerDub AI)។ គេហទំព័រផ្ញើ WAV មកទីនេះ រួចទាញ `vocals.wav` + `no_vocals.wav`
ត្រឡប់ទៅវិញ ដើម្បីបកប្រែ និងលាយសំឡេងខ្មែរ។

ចំណាំ៖ បើអ្នកមាន Demucs API ដំណើរការរួចហើយ (ឧ. `curl 127.0.0.1:8000` ឆ្លើយ
`{"status":"ok","service":"Demucs API"}`) មិនចាំបាច់ប្រើឯកសារនេះទេ — គេហទំព័រ
សាកល្បង path និងឈ្មោះ field ដោយស្វ័យប្រវត្តិ។ ឯកសារនេះសម្រាប់អ្នកដែលចង់បាន
API ដែលគេហទំព័រស្គាល់ច្បាស់ ១០០%។

Endpoint
--------
GET  /                        -> {"status":"ok","service":"Demucs API", ...}
GET  /health                  -> ស្ថានភាព + ម៉ូឌែល + កំពុងរវល់ ឬអត់
POST /separate                -> field `audio` (ឬ `file`/`video`), field `model`
                                 ឆ្លើយ: {"vocals": "/stems/<job>/vocals.wav",
                                         "instrumental": "/stems/<job>/no_vocals.wav"}
GET  /stems/<job>/<name>      -> ឯកសារ WAV

ដំណើរការ
--------
    pip install -r requirements.txt      # ត្រូវការ torch (ធំ) — មើល README.md
    python demucs_api.py                 # បើកនៅ port 8000

បរិស្ថាន (Environment)
----------------------
DEMUCS_MODEL     ម៉ូឌែល ដូច `htdemucs` (default) ឬ `htdemucs_ft`
DEMUCS_DATA_DIR  កន្លែងទុក stems (default: ~/demucs-api/stems)
DEMUCS_API_KEY   key សម្រាប់ការពារ (បើទទេ = គ្មានការពារ ដូច្នេះកុំបើកចេញក្រៅដោយគ្មានវា)
DEMUCS_TTL_HOURS លុប stems ចាស់ក្រោយប៉ុន្មានម៉ោង (default 12)
DEMUCS_MAX_MB    បដិសេធឯកសារធំជាងនេះ (default 1024)
DEMUCS_HOST      interface ដែលនឹងស្តាប់ (default 127.0.0.1 = តែម៉ាស៊ីននេះ)
PORT             port (default 8000)
"""
from __future__ import annotations

import asyncio
import logging
import os
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("demucs-api")

DATA_DIR = Path(os.environ.get("DEMUCS_DATA_DIR", Path.home() / "demucs-api" / "stems")).expanduser().resolve()
MODEL = os.environ.get("DEMUCS_MODEL", "htdemucs").strip() or "htdemucs"
API_KEY = os.environ.get("DEMUCS_API_KEY", "").strip()
TTL_HOURS = float(os.environ.get("DEMUCS_TTL_HOURS", "12"))
MAX_BYTES = float(os.environ.get("DEMUCS_MAX_MB", "1024")) * 1024 * 1024
PORT = int(os.environ.get("PORT", "8000"))
# ស្តាប់តែលើ loopback តាម default៖ tunnel ភ្ជាប់មក `localhost:8000` បានដូចគ្នា ប៉ុន្តែ
# គ្មានអ្នកណាក្នុង Wi-Fi តែមួយអាចហៅ CPU របស់អ្នកបានដោយផ្ទាល់។
HOST = os.environ.get("DEMUCS_HOST", "127.0.0.1").strip() or "127.0.0.1"

DATA_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Demucs API", version="1.0")

# ទូរស័ព្ទមាន CPU តិច៖ ញែកម្តងមួយ។ ការរត់ពីរក្នុងពេលតែមួយធ្វើឲ្យយឺតទាំងពីរ។
_run_lock = asyncio.Lock()
_busy = False


def require_key(authorization: Optional[str] = Header(default=None)) -> None:
    if not API_KEY:
        return
    if authorization != f"Bearer {API_KEY}":
        raise HTTPException(status_code=401, detail="Invalid or missing API key")


def _info() -> dict:
    return {
        "status": "ok",
        "service": "Demucs API",
        "version": "1.0",
        "model": MODEL,
        "busy": _busy,
    }


@app.get("/")
async def root() -> dict:
    # គ្មាន auth នៅទីនេះ៖ វាគ្រាន់តែប្រាប់ថា service នេះជាអ្វី។
    return _info()


@app.get("/health", dependencies=[Depends(require_key)])
async def health() -> dict:
    return _info()


def _purge_expired() -> None:
    cutoff = time.time() - TTL_HOURS * 3600
    for job_dir in DATA_DIR.glob("*"):
        try:
            if job_dir.is_dir() and job_dir.stat().st_mtime < cutoff:
                shutil.rmtree(job_dir, ignore_errors=True)
        except OSError:
            continue


async def _save_upload(upload: UploadFile, target: Path) -> int:
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


def _run_demucs(source: Path, out_dir: Path) -> None:
    """ហៅ CLI របស់ demucs (ស្ថេរភាពជាង API ខាងក្នុងរបស់វាឆ្លង version)."""
    cmd = [
        sys.executable,
        "-m",
        "demucs",
        "--two-stems=vocals",
        "-n",
        MODEL,
        "-o",
        str(out_dir),
        str(source),
    ]
    log.info("Running: %s", " ".join(cmd))
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout or "").strip()[-600:] or "demucs failed")


@app.post("/separate", dependencies=[Depends(require_key)])
async def separate(
    audio: Optional[UploadFile] = File(default=None),
    file: Optional[UploadFile] = File(default=None),
    video: Optional[UploadFile] = File(default=None),
    model: str = Form(default=""),  # ទទួលយក តែម៉ូឌែលកំណត់តាម DEMUCS_MODEL ប៉ុណ្ណោះ
):
    # ទទួល field ច្រើនឈ្មោះ ដើម្បីកុំឲ្យ client ណាមួយបរាជ័យដោយហេតុតែឈ្មោះ field។
    upload = audio or file or video
    if upload is None:
        raise HTTPException(status_code=422, detail="field required: audio")

    global _busy
    _purge_expired()

    job_id = uuid.uuid4().hex[:12]
    job_dir = DATA_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    suffix = Path(upload.filename or "input.wav").suffix or ".wav"
    source = job_dir / f"source{suffix}"
    size = await _save_upload(upload, source)
    log.info("Job %s: received %s (%.1f MB)", job_id, upload.filename, size / 1048576)

    try:
        async with _run_lock:
            _busy = True
            out_dir = job_dir / "out"
            await asyncio.to_thread(_run_demucs, source, out_dir)
    except Exception as err:  # រក្សា detail ព្រោះ model download ច្រើនតែបរាជ័យ
        log.exception("Job %s failed", job_id)
        shutil.rmtree(job_dir, ignore_errors=True)
        return JSONResponse(status_code=500, content={"error": f"separation failed: {err}"})
    finally:
        _busy = False

    # demucs សរសេរទៅ out/<model>/<source>/vocals.wav និង no_vocals.wav
    produced = list(out_dir.glob(f"*/{source.stem}/*.wav")) or list(out_dir.glob("**/*.wav"))
    vocals = next((p for p in produced if p.name == "vocals.wav"), None)
    instrumental = next((p for p in produced if p.name == "no_vocals.wav"), None)

    if not vocals or not instrumental:
        shutil.rmtree(job_dir, ignore_errors=True)
        return JSONResponse(
            status_code=500,
            content={"error": f"unexpected outputs: {[p.name for p in produced]}"},
        )

    vocals_target = job_dir / "vocals.wav"
    instrumental_target = job_dir / "no_vocals.wav"
    shutil.move(str(vocals), vocals_target)
    shutil.move(str(instrumental), instrumental_target)
    shutil.rmtree(out_dir, ignore_errors=True)
    source.unlink(missing_ok=True)

    log.info(
        "Job %s: stems ready (%.1f MB)",
        job_id,
        (vocals_target.stat().st_size + instrumental_target.stat().st_size) / 1048576,
    )
    return {
        "status": "done",
        "job_id": job_id,
        "model": MODEL,
        "vocals": f"/stems/{job_id}/vocals.wav",
        "instrumental": f"/stems/{job_id}/no_vocals.wav",
    }


@app.get("/stems/{job_id}/{name}", dependencies=[Depends(require_key)])
async def stem(job_id: str, name: str):
    if not job_id.isalnum() or name not in {"vocals.wav", "no_vocals.wav"}:
        raise HTTPException(status_code=400, detail="Invalid stem path")
    path = DATA_DIR / job_id / name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Stem not found")
    return FileResponse(path, media_type="audio/wav", filename=name)


if __name__ == "__main__":
    import uvicorn

    log.info("Demucs API on http://%s:%s (model: %s)", HOST, PORT, MODEL)
    uvicorn.run(app, host=HOST, port=PORT)

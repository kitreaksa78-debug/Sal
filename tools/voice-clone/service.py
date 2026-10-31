"""Voice Convert API — Amphion DiffWaveNetSVC over HTTP, for the studio.

Start it with `SERVICE=1 sh colab-start.sh` in a Colab session (T4 GPU), then
paste the printed URL and API key into the website's «ប្តូរសំឡេង · Voice Convert
API» card. The site uploads the dry Khmer words and gets the same words back in
the original singer's timbre.

Endpoints
  GET  /                     who this is (public, like the Demucs service)
  GET  /health               the same, but gated by the key
  POST /convert              multipart: audio (the words) + singer, steps,
                             pitch, key_shift  ->  {"file": "<url>"}
  GET  /files/<job>/<name>   the produced audio

Auth: `SERVICE_KEY` as `Authorization: Bearer …`, `x-api-key: …` or `?key=…`.
With no key the service is open — acceptable inside a private Colab session,
never on a public tunnel.
"""

from __future__ import annotations

import glob
import os
import shutil
import subprocess
import sys
import threading
import traceback
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from starlette.concurrency import run_in_threadpool

SERVICE_NAME = "Voice Convert API"
VERSION = "1.0"
MODEL = "Amphion DiffWaveNetSVC"

SERVICE_KEY = (os.environ.get("SERVICE_KEY") or "").strip()
FILES = Path(os.environ.get("SERVICE_FILES") or "/content/voice-convert").resolve()
WORK = FILES.parent
HOST = (os.environ.get("SERVICE_HOST") or "127.0.0.1").strip()

FILES.mkdir(parents=True, exist_ok=True)

# The fifteen singers the checkpoints carry. The site and the shell both send
# either the display name or the checkpoint id, so both spellings resolve here.
SINGERS = {
    "Adele": "vocalist_l1_Adele",
    "Beyonce": "vocalist_l1_Beyonce",
    "Bruno Mars": "vocalist_l1_BrunoMars",
    "John Mayer": "vocalist_l1_JohnMayer",
    "Michael Jackson": "vocalist_l1_MichaelJackson",
    "Taylor Swift": "vocalist_l1_TaylorSwift",
    "David Tao 陶喆": "vocalist_l1_陶喆",
    "Eason Chan 陈奕迅": "vocalist_l1_陈奕迅",
    "Feng Wang 汪峰": "vocalist_l1_汪峰",
    "Jian Li 李健": "vocalist_l1_李健",
    "Ying Na 那英": "vocalist_l1_那英",
    "Yijie Shi 石倚洁": "vocalist_l1_石倚洁",
    "Jacky Cheung 张学友": "vocalist_l1_张学友",
    "Faye Wong 王菲": "vocalist_l1_王菲",
    "Tsai Chin 蔡琴": "vocalist_l1_蔡琴",
}

REQUIRED = ("ckpts/svc", "pretrained/bigvgan", "pretrained/contentvec", "pretrained/whisper")


def _weights_ready(root: Path | None = None) -> bool:
    base = root or ROOT
    return all((base / part).is_dir() for part in REQUIRED) and (base / "inference.py").is_file()


def _resolve_root() -> Path:
    """Where the Amphion checkout lives.

    `colab-start.sh` passes SERVICE_ROOT, older notes and the Space use SVC_ROOT,
    and a session that already converted by hand keeps the weights in
    /content/Amphion. Reading a single name meant every conversion looked in a
    directory nobody had filled: the model was re-downloaded inside the request,
    and the site read those minutes as a failure.
    """
    candidates = [
        os.environ.get("SVC_ROOT"),
        os.environ.get("SERVICE_ROOT"),
        "/content/Amphion",
    ]
    for raw in candidates:
        if raw and _weights_ready(Path(raw).expanduser().resolve()):
            return Path(raw).expanduser().resolve()
    for raw in candidates:
        if raw:
            return Path(raw).expanduser().resolve()
    return Path("/content/Amphion")


ROOT = _resolve_root()
UPLOAD_FIELDS = ("audio", "file", "speech", "input", "song")

app = FastAPI(title=SERVICE_NAME, version=VERSION)
# One GPU, one request at a time; the site polls instead of opening many.
LOCK = threading.Lock()
BUSY = False
# One download at a time: the warm-up thread and a request can both want the
# checkpoints, and fetching 5 GB twice is worse than waiting.
_WEIGHTS_LOCK = threading.Lock()
_INFER = None  # the imported Amphion module, loaded once


# --------------------------------------------------------------------- helpers
def _presented_key(request: Request) -> str:
    auth = request.headers.get("authorization", "")
    bearer = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
    return (
        request.headers.get("x-api-key") or bearer or request.query_params.get("key") or ""
    ).strip()


def _require_key(request: Request) -> None:
    if SERVICE_KEY and _presented_key(request) != SERVICE_KEY:
        raise HTTPException(status_code=401, detail="invalid service key")


def _device() -> str:
    try:
        import torch  # imported late: it is heavy

        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "unknown"


def _log(message: str) -> None:
    print(f"[voice-convert] {message}", flush=True)


def _resolve_singer(raw: str) -> str:
    value = (raw or "").strip()
    if value in SINGERS.values():
        return value
    if value in SINGERS:
        return SINGERS[value]
    low = value.lower()
    for name, singer_id in SINGERS.items():
        if name.lower() == low or singer_id.lower() == low:
            return singer_id
    hits = [sid for name, sid in SINGERS.items() if low in name.lower() or low in sid.lower()]
    if len(hits) == 1:
        return hits[0]
    raise HTTPException(
        status_code=400,
        detail=f"unknown singer {value!r}; use one of: {', '.join(SINGERS)}",
    )


def _ensure_weights() -> None:
    with _WEIGHTS_LOCK:
        _ensure_weights_unlocked()


def _ensure_weights_unlocked() -> None:
    if _weights_ready():
        return

    _log("downloading the model from Hugging Face (~5 GB, once per session)")
    os.environ.setdefault("HF_HUB_ENABLE_HF_TRANSFER", "1")
    try:
        from huggingface_hub import snapshot_download
    except ImportError as err:
        raise HTTPException(status_code=503, detail=f"huggingface_hub missing: {err}")

    try:
        snapshot_download(
            repo_id="amphion/singing_voice_conversion",
            repo_type="space",
            local_dir=str(ROOT),
            allow_patterns=[
                "*.py", "*.json", "*.yaml", "*.yml", "*.txt",
                "ckpts/**", "pretrained/**", "models/**", "processors/**",
                "modules/**", "utils/**", "text/**", "egs/**", "config/**",
                "optimizer/**", "preprocessors/**",
            ],
            ignore_patterns=["*.md", "*.gitattributes"],
        )
    except Exception as err:
        raise HTTPException(status_code=502, detail=f"downloading the model failed: {err}")

    missing = [part for part in REQUIRED if not (ROOT / part).is_dir()]
    if missing:
        raise HTTPException(status_code=502, detail=f"the model is incomplete: {', '.join(missing)}")


def _infer_module():
    """Amphion's `inference` reads relative checkpoint paths, so import it from
    inside the repo directory — exactly what the Space's own app does."""
    global _INFER
    if _INFER is None:
        os.chdir(ROOT)
        if str(ROOT) not in sys.path:
            sys.path.insert(0, str(ROOT))
        os.environ.setdefault("WORK_DIR", "./")
        import inference  # noqa: PLC0415  (chdir first)

        _INFER = inference
    return _INFER


def _convert_sync(
    source: Path,
    job: str,
    singer_id: str,
    steps: int,
    pitch: str,
    key_shift: str,
) -> Path:
    """One file in, one MP3 out. Runs on the threadpool under LOCK."""
    work = FILES / job
    work.mkdir(parents=True, exist_ok=True)

    # Amphion processes a whole folder of 44.1 kHz mono audio; give it one file.
    in_dir = work / "input"
    shutil.rmtree(in_dir, ignore_errors=True)
    in_dir.mkdir(parents=True, exist_ok=True)
    wav_in = in_dir / "part.wav"
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", str(source), "-ac", "1", "-ar", "44100", str(wav_in)],
        check=True,
    )

    result_dir = work / "result"
    shutil.rmtree(result_dir, ignore_errors=True)

    _ensure_weights()
    inference = _infer_module()

    _log(f"converting to {singer_id} (steps={steps}, pitch={pitch})")
    inference.main(
        [
            "--config", "ckpts/svc/vocalist_l1_contentvec+whisper/args.json",
            "--acoustics_dir", "ckpts/svc/vocalist_l1_contentvec+whisper",
            "--vocoder_dir", "pretrained/bigvgan",
            "--target_singer", singer_id,
            "--trans_key", "autoshift" if pitch.lower().startswith("auto") else str(key_shift),
            "--diffusion_inference_steps", str(steps),
            "--source", str(in_dir),
            "--output_dir", str(result_dir),
            "--log_level", "warning",
        ]
    )

    produced = sorted(glob.glob(str(result_dir / "**" / "*.wav"), recursive=True))
    if not produced:
        raise HTTPException(status_code=502, detail="the model produced no audio")

    out_mp3 = work / "out.mp3"
    subprocess.run(
        [
            "ffmpeg", "-y", "-v", "error",
            "-i", produced[-1],
            "-codec:a", "libmp3lame", "-q:a", "2",
            str(out_mp3),
        ],
        check=True,
    )
    shutil.rmtree(result_dir, ignore_errors=True)
    shutil.rmtree(in_dir, ignore_errors=True)
    return out_mp3


def _warm_weights() -> None:
    """Fetch the model while the owner is still pointing the site at the tunnel.

    The first conversion must not be the thing that waits for 5 GB.
    """
    try:
        if _weights_ready():
            _log(f"model ready at {ROOT}")
            return
        _log(f"preparing the model at {ROOT} (5 GB, once per session)")
        _ensure_weights()
        _log("model ready")
    except Exception as err:  # a dead Hugging Face is reported, not fatal
        _log(f"model download failed: {err}")


threading.Thread(target=_warm_weights, daemon=True).start()


# -------------------------------------------------------------------- endpoints
@app.get("/")
def index():
    return {
        "service": SERVICE_NAME,
        "version": VERSION,
        "model": MODEL,
        "endpoints": ["/health", "/convert", "/files/{job}/{name}"],
    }


@app.get("/health")
def health(request: Request):
    # Gated on purpose: the site asks this first to tell "tunnel up, wrong key"
    # apart from "tunnel down", and the root answer stays public.
    _require_key(request)
    return {
        "status": "ok",
        "service": SERVICE_NAME,
        "version": VERSION,
        "model": MODEL,
        "device": _device(),
        "loaded": _INFER is not None,
        "weights": _weights_ready(),
        "busy": BUSY,
        "singers": len(SINGERS),
    }


@app.post("/convert")
@app.post("/api/convert")
@app.post("/voice-clone")
async def convert(request: Request):
    _require_key(request)
    form = await request.form()

    upload = None
    for name in UPLOAD_FIELDS:
        value = form.get(name)
        if value is not None and getattr(value, "filename", None):
            upload = value
            break
    if upload is None:
        raise HTTPException(status_code=400, detail="no audio file in the request")

    singer_id = _resolve_singer(str(form.get("singer") or "Taylor Swift"))
    pitch = str(form.get("pitch") or "Auto Shift").strip() or "Auto Shift"
    key_shift = str(form.get("key_shift") or "0").strip() or "0"
    try:
        steps = int(float(str(form.get("steps") or "200")))
    except ValueError:
        steps = 200
    steps = max(50, min(1000, steps))

    job = uuid.uuid4().hex[:12]
    source = FILES / job / "source.bin"
    source.parent.mkdir(parents=True, exist_ok=True)
    with open(source, "wb") as handle:
        while True:
            chunk = await upload.read(1024 * 1024)
            if not chunk:
                break
            handle.write(chunk)
    if source.stat().st_size == 0:
        source.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="the uploaded file was empty")

    global BUSY
    if not LOCK.acquire(blocking=False):
        source.unlink(missing_ok=True)
        raise HTTPException(status_code=409, detail="busy — the site retries a busy service")
    BUSY = True
    try:
        out_path = await run_in_threadpool(
            _convert_sync, source, job, singer_id, steps, pitch, key_shift
        )
    except HTTPException:
        raise
    except (Exception, SystemExit) as err:
        # A crash inside Amphion (missing checkpoint, CUDA out of memory, a
        # torch/fairseq mismatch) used to leave the site with nothing but
        # "500 Internal Server Error". The owner reads this from a phone, so the
        # class and the message travel back in the reply and the traceback goes
        # to the log the cell points at.
        _log(f"conversion failed: {type(err).__name__}: {err}\n{traceback.format_exc()}")
        raise HTTPException(
            status_code=502,
            detail=f"conversion crashed: {type(err).__name__}: {err}"[:400],
        )
    finally:
        BUSY = False
        LOCK.release()
        source.unlink(missing_ok=True)

    base = str(request.base_url).rstrip("/")
    return {
        "status": "ok",
        "service": SERVICE_NAME,
        "device": _device(),
        "singer": singer_id,
        "file": f"{base}/files/{job}/{out_path.name}",
        "bytes": out_path.stat().st_size,
    }


@app.get("/files/{job}/{name}")
def download(job: str, name: str):
    if "/" in job or ".." in job or "/" in name or ".." in name:
        raise HTTPException(status_code=400, detail="bad path")
    path = FILES / job / name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="not found")
    return FileResponse(path, media_type="audio/mpeg", filename=name)

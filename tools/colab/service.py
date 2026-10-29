"""Colab T4 studio: Demucs separation + UVR vocal cleanup over HTTP.

Open `studio_t4.ipynb` in Colab, run the cells top to bottom, then paste the
printed `https://….trycloudflare.com` address into the website's stem panel.

Endpoints
  GET  /health            what this service is, and which device it runs on
  POST /separate          Demucs two-stem: vocals + instrumental
  POST /enhance           UVR cleanup:  task=denoise | dereverb | debleed
  GET  /files/<job>/<name>  the produced audio, for the site to download

Auth: set `SERVICE_KEY`, then send it as `Authorization: Bearer …`,
`x-api-key: …` or `?key=…`. With no key the service is open — acceptable inside
a private Colab session, never on a public tunnel.
"""

from __future__ import annotations

import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse

SERVICE_KEY = (os.environ.get("SERVICE_KEY") or "").strip()
DEMUCS_MODEL = (os.environ.get("DEMUCS_MODEL") or "htdemucs").strip()
DEMUCS_CMD = os.environ.get("DEMUCS_CMD") or f"{shlex.quote(sys.executable)} -m demucs"
ENHANCE_CMD = os.environ.get("ENHANCE_CMD") or "audio-separator"

# The UVR models that clean a vocal stem. `audio-separator --list_models` prints
# the exact file names for the installed release; these are the usual ones.
ENHANCE_MODELS = {
    "denoise": os.environ.get("ENHANCE_DENOISE_MODEL", "UVR-DeNoise.pth"),
    "dereverb": os.environ.get("ENHANCE_DEREVERB_MODEL", "UVR-DeEcho-DeReverb.pth"),
    "debleed": os.environ.get(
        "ENHANCE_DEBLEED_MODEL", "mel_band_roformer_denoise_debleed_gabox.ckpt"
    ),
}

# Where the finished stems are written, and what the site downloads.
FILES = Path(os.environ.get("SERVICE_FILES") or "/content/stems")
FILES.mkdir(parents=True, exist_ok=True)

UPLOAD_FIELDS = ("audio", "file", "video", "track", "input", "song")
AUDIO_SUFFIXES = (".wav", ".flac", ".mp3")

app = FastAPI(title="Colab studio service")


# --------------------------------------------------------------------- helpers
def _presented_key(request: Request) -> str:
    auth = request.headers.get("authorization", "")
    bearer = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
    return (
        request.headers.get("x-api-key")
        or bearer
        or request.query_params.get("key")
        or ""
    ).strip()


def _require_key(request: Request) -> None:
    if SERVICE_KEY and _presented_key(request) != SERVICE_KEY:
        raise HTTPException(status_code=401, detail="invalid service key")


async def _save_upload(form, tmpdir: Path) -> Path:
    upload = None
    for name in UPLOAD_FIELDS:
        value = form.get(name)
        if value is not None and getattr(value, "filename", None):
            upload = value
            break
    if upload is None:
        raise HTTPException(status_code=400, detail="no audio file in the request")

    suffix = Path(upload.filename or "input.wav").suffix or ".wav"
    target = tmpdir / f"input{suffix}"
    with open(target, "wb") as handle:
        while True:
            chunk = await upload.read(1024 * 1024)
            if not chunk:
                break
            handle.write(chunk)
    if target.stat().st_size == 0:
        raise HTTPException(status_code=400, detail="the uploaded file was empty")
    return target


def _run(command: list[str], timeout: int = 3600) -> None:
    try:
        subprocess.run(command, check=True, capture_output=True, timeout=timeout)
    except subprocess.CalledProcessError as err:
        detail = (err.stderr or b"").decode("utf-8", "replace")[-600:]
        raise HTTPException(
            status_code=502, detail=f"{command[0]} failed: {detail or err}"
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="the model took too long")


def _device() -> str:
    try:
        import torch  # imported late: it is heavy

        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "unknown"


def _log(message: str) -> None:
    print(f"[studio] {message}", flush=True)


# Models kept between requests, and whether the in-process path may be used.
# The command line loads torch and the weights again for every request — about
# ten seconds before any audio is touched — and a song arrives as several
# pieces, so that cost used to be paid once per piece.
_MODELS: dict[str, object] = {}
_INPROCESS = (os.environ.get("DEMUCS_INPROCESS") or "1").strip().lower() not in (
    "0",
    "false",
    "no",
    "off",
)


def _demucs_inprocess(wav: Path, model_name: str, out: Path) -> tuple[Path, Path] | None:
    """Separate with the model already in memory, or None to use the command line.

    Anything that goes wrong returns None, which makes the caller run Demucs the
    way it always has; the two paths produce the same two WAV stems.
    """
    if not _INPROCESS:
        return None
    try:
        import torch
        from demucs.apply import apply_model
        from demucs.audio import AudioFile, save_audio
        from demucs.pretrained import get_model
    except Exception as err:  # torch or demucs not importable here
        _log(f"in-process Demucs unavailable ({err}); using the command line")
        return None

    try:
        device = "cuda" if torch.cuda.is_available() else "cpu"
        model = _MODELS.get(model_name)
        if model is None:
            _log(f"loading {model_name} into memory (first piece only)")
            model = get_model(model_name)
            model.eval()
            _MODELS[model_name] = model
        model = model.to(device)

        # The same normalisation the Demucs CLI applies: separate the audio at
        # zero mean / unit variance, then put the original scale back.
        audio = AudioFile(str(wav)).read(
            streams=0, samplerate=model.samplerate, channels=model.audio_channels
        )
        reference = audio.mean(0)
        mix = (audio - reference.mean()) / (reference.std() + 1e-8)

        with torch.no_grad():
            sources = apply_model(
                model,
                mix[None],
                device=device,
                shifts=1,
                split=True,
                overlap=0.25,
                progress=False,
            )[0]
        sources = sources * reference.std() + reference.mean()

        names = list(model.sources)
        vocals = sources[names.index("vocals")]
        accompaniment = sum(source for name, source in zip(names, sources) if name != "vocals")

        vocals_path = out / "vocals.wav"
        other_path = out / "no_vocals.wav"
        save_audio(vocals, str(vocals_path), model.samplerate)
        save_audio(accompaniment, str(other_path), model.samplerate)
        return vocals_path, other_path
    except Exception as err:
        _log(f"in-process separation failed ({err}); using the command line")
        return None


def _separate_demucs(wav: Path, model_name: str, tmp: Path) -> tuple[Path, Path]:
    """The two stems of one file: in memory when possible, otherwise the CLI."""
    stems = tmp / "stems"
    stems.mkdir(parents=True, exist_ok=True)
    fast = _demucs_inprocess(wav, model_name, stems)
    if fast is not None:
        return fast

    out = tmp / "out"
    _run(
        shlex.split(DEMUCS_CMD)
        + ["--two-stems", "vocals", "-n", model_name, "-o", str(out), str(wav)]
    )
    vocals = next(iter(sorted(out.rglob("vocals.*"))), None)
    instrumental = next(iter(sorted(out.rglob("no_vocals.*"))), None)
    if vocals is None or instrumental is None:
        raise HTTPException(status_code=502, detail="Demucs returned no stems")
    return vocals, instrumental


def _to_flac(source: Path, target: Path) -> None:
    """Ship stems as FLAC: lossless, and about half the bytes of 16-bit WAV."""
    _run(["ffmpeg", "-y", "-v", "error", "-i", str(source), "-c:a", "flac", str(target)])


def _public_url(request: Request, job: str, name: str) -> str:
    base = str(request.base_url).rstrip("/")
    return f"{base}/files/{job}/{name}"


# -------------------------------------------------------------------- endpoints
@app.get("/")
def index():
    return {
        "service": "colab-studio",
        "endpoints": ["/health", "/separate", "/enhance", "/files/{job}/{name}"],
    }


@app.get("/health")
def health():
    return {
        "status": "ok",
        "device": _device(),
        "model": DEMUCS_MODEL,
        "enhance_models": ENHANCE_MODELS,
        "inprocess": _INPROCESS,
        "loaded": list(_MODELS),
        "busy": False,
    }


@app.post("/separate")
@app.post("/api/separate")
@app.post("/demucs")
async def separate(request: Request):
    _require_key(request)
    form = await request.form()
    job = uuid.uuid4().hex[:12]
    work = FILES / job
    work.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp())

    try:
        source = await _save_upload(form, tmp)

        # Demucs reads WAV; anything else (MP4, MP3, M4A…) is decoded first, so a
        # video upload works exactly like an audio one.
        # A dedicated name: an uploaded WAV keeps its own `input.wav`, and
        # rewriting that path in place would make ffmpeg refuse to read and write
        # the same file.
        wav = tmp / "demucs_input.wav"
        _run(
            [
                "ffmpeg",
                "-y",
                "-v",
                "error",
                "-i",
                str(source),
                "-ar",
                "44100",
                "-ac",
                "2",
                str(wav),
            ]
        )

        model = str(form.get("model") or DEMUCS_MODEL).strip() or DEMUCS_MODEL
        vocals, instrumental = _separate_demucs(wav, model, tmp)

        # FLAC, not WAV: the stems travel back over the same tunnel the audio came
        # in on, so half the bytes is half the download for every piece.
        _to_flac(vocals, work / "vocals.flac")
        _to_flac(instrumental, work / "no_vocals.flac")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    return {
        "status": "ok",
        "model": model,
        "vocals": _public_url(request, job, "vocals.flac"),
        "instrumental": _public_url(request, job, "no_vocals.flac"),
        "stems": [
            {"name": "vocals", "url": _public_url(request, job, "vocals.flac")},
            {"name": "instrumental", "url": _public_url(request, job, "no_vocals.flac")},
        ],
    }


@app.post("/enhance")
@app.post("/api/enhance")
@app.post("/clean")
async def enhance(request: Request):
    _require_key(request)
    form = await request.form()
    task = str(form.get("task") or "denoise").strip().lower()
    model = str(form.get("model") or ENHANCE_MODELS.get(task, ENHANCE_MODELS["denoise"])).strip()

    job = uuid.uuid4().hex[:12]
    work = FILES / job
    work.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp())

    try:
        source = await _save_upload(form, tmp)
        _run([ENHANCE_CMD, str(source), "-m", model, "--output_dir", str(work)])
        produced = [p for p in work.iterdir() if p.suffix.lower() in AUDIO_SUFFIXES]
        if not produced:
            raise HTTPException(status_code=502, detail="the model produced no audio")
        # A separator model also writes the part it removed; the cleaned voice is
        # the file whose name says so.
        cleaned = next((p for p in produced if "vocal" in p.name.lower()), produced[0])
        for leftover in produced:
            if leftover != cleaned:
                leftover.unlink(missing_ok=True)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    return {
        "status": "ok",
        "task": task,
        "model": model,
        "clean": _public_url(request, job, cleaned.name),
        "file": _public_url(request, job, cleaned.name),
    }


@app.get("/files/{job}/{name}")
def download(job: str, name: str):
    if "/" in name or ".." in name or "/" in job or ".." in job:
        raise HTTPException(status_code=400, detail="bad path")
    path = FILES / job / name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="not found")
    media_type = "audio/flac" if path.suffix.lower() == ".flac" else "audio/wav"
    return FileResponse(path, media_type=media_type)

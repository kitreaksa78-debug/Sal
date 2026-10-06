"""
NLLB-200 translation service — the translator KhmerDub AI runs on Google Colab.

The website never loads the model itself: even the smallest NLLB-200 needs more
RAM than the free Render instance (512 MB) has. So the model lives on a Colab
GPU/CPU session here, and the website sends it plain text over HTTP.

Models — picked with `NLLB_MODE` (default **best**, the strongest NLLB-200):

    best      facebook/nllb-200-3.3B             strongest quality, ~6.6 GB fp16
    balanced  facebook/nllb-200-distilled-1.3B   nearly as good, half the size
    fast      facebook/nllb-200-distilled-600M   smallest and quickest

`NLLB_MODEL` still pins one exact Hugging Face repo and skips the mode table. On
a GPU the weights are loaded in fp16 and generated in chunks (`NLLB_BATCH_SIZE`),
which is what makes the strongest model usable inside a request's timeout. If
the chosen model cannot be loaded — out of memory, or a CPU-only runtime, where a
3.3B model could never answer in time — the service walks down the mode table
instead of failing: a smaller model that answers beats a big one that times out
and leaves the line untranslated. `GET /` reports which model ended up in use.

Contract (what `server/services/nllbProvider.ts` calls):

    GET  /            -> {"status":"ok", "service":"NLLB Translation API",
                          "version":..., "model":..., "mode":"best",
                          "requestedMode":..., "fallback":bool,
                          "device":"cuda"|"cpu", "loaded":bool, "loadError":...}
    POST /translate   -> {"segments":[{"id": "...", "khmer": "..."}, ...]}

    POST /translate body:
        {
          "lines": [{"id": "...", "text": "..."}, ...],
          "src_lang": "eng_Latn",     # FLORES-200 code of the source
          "tgt_lang": "khm_Khmr"      # FLORES-200 code of the target the studio chose
        }

The answer keeps the field name `khmer` for compatibility with
`server/services/nllbProvider.ts`: it carries the **target-language** line, which
is Khmer by default but whatever `tgt_lang` names when the studio picked another
language.

NLLB is a sentence-level translator: it answers one line at a time and does not
follow instructions (emotion, glossary, timing). That is deliberate — the owner
chose plain NLLB quality over an instruction-following model.

Auth: when `NLLB_API_KEY` is set, every request must carry it either as
`Authorization: Bearer <key>` or `X-API-Key: <key>`. The Colab start script
generates one when none is given, so a public tunnel URL cannot be spent by a
stranger.
"""

import os
import time

from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

PORT = int(os.environ.get("PORT", "8000"))
HOST = os.environ.get("NLLB_HOST", "0.0.0.0")
API_KEY = os.environ.get("NLLB_API_KEY", "").strip()
MAX_LINES = int(os.environ.get("NLLB_MAX_LINES", "64"))
MAX_NEW_TOKENS = int(os.environ.get("NLLB_MAX_NEW_TOKENS", "400"))

# The quality presets, strongest first: the order is also the fallback order.
MODES = {
    "best": "facebook/nllb-200-3.3B",
    "balanced": "facebook/nllb-200-distilled-1.3B",
    "fast": "facebook/nllb-200-distilled-600M",
}
FALLBACK_ORDER = {"best": ("balanced", "fast"), "balanced": ("fast",), "fast": ()}

_REQUESTED = (os.environ.get("NLLB_MODE") or "best").strip().lower()
REQUESTED_MODE = _REQUESTED if _REQUESTED in MODES else "best"
# An explicitly named repo is used on its own: the owner asked for exactly it.
EXPLICIT_MODEL = (os.environ.get("NLLB_MODEL") or "").strip()

# Lines are generated in chunks: padding every line to the longest one in a large
# batch wastes GPU time, and chunking also keeps the peak activation memory low.
BATCH_SIZE = max(1, int(os.environ.get("NLLB_BATCH_SIZE", "16")))
# 1 = greedy (fastest). 4 usually reads a little better and costs ~3x the time.
NUM_BEAMS = max(1, int(os.environ.get("NLLB_NUM_BEAMS", "1")))

MODEL_NAME = EXPLICIT_MODEL or MODES[REQUESTED_MODE]  # the repo in use right now


def model_chain(device: str) -> list[tuple[str, str]]:
    """`(mode, repo)` pairs to try, best first — what `load()` walks.

    On a CPU-only runtime the order is reversed: a 3.3B model there cannot answer
    inside the caller's timeout, and a timed-out block is an untranslated line, so
    the small model is what actually gets the job done.
    """
    if EXPLICIT_MODEL:
        return [(REQUESTED_MODE, EXPLICIT_MODEL)]

    order = [REQUESTED_MODE, *FALLBACK_ORDER[REQUESTED_MODE]]
    if device != "cuda":
        order = sorted(order, key=list(MODES).index, reverse=True)
    return [(mode, MODES[mode]) for mode in order]


def from_pretrained(model_cls, repo: str, dtype):
    """`from_pretrained` across transformers versions.

    `torch_dtype` was renamed to `dtype`; the old name warns on 4.x and is gone on
    5.x, so the new one is tried first and the old one keeps older runtimes (a
    pinned Colab, say) working.
    """
    try:
        return model_cls.from_pretrained(repo, dtype=dtype, low_cpu_mem_usage=True)
    except TypeError:
        return model_cls.from_pretrained(repo, torch_dtype=dtype, low_cpu_mem_usage=True)


app = FastAPI(title="NLLB Translation API", version="1.0.0")
# The website is served from another origin (aivideotranslate.dev), so the
# browser-facing probe is allowed; the key is what actually guards the service.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_tokenizer = None
_model = None
_device = "cpu"
_mode = REQUESTED_MODE
_fell_back = False
_load_error: str | None = None


class Line(BaseModel):
    id: str
    text: str


class TranslateRequest(BaseModel):
    lines: list[Line]
    src_lang: str = "eng_Latn"
    tgt_lang: str = "khm_Khmr"


def load() -> bool:
    """Load the tokenizer and the model once, walking the mode table until one fits.

    Returns whether a model is ready. A load that fails everywhere is reported
    through `GET /` (`loadError`) and answered by `/translate` with a 503 — the
    service itself stays up, so the website's test button can show the reason
    instead of the tunnel simply looking dead.
    """
    global _tokenizer, _model, _device, _mode, _fell_back, _load_error, MODEL_NAME
    if _model is not None:
        return True

    import gc

    import torch
    from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

    _device = "cuda" if torch.cuda.is_available() else "cpu"
    # fp16 halves the weights and roughly doubles generation speed on a GPU; on
    # CPU it is unsupported, so fp32 stays.
    dtype = torch.float16 if _device == "cuda" else torch.float32

    failures: list[str] = []
    for mode, repo in model_chain(_device):
        try:
            print(f"[nllb] loading {repo} ({mode} mode) on {_device} ...", flush=True)
            tokenizer = AutoTokenizer.from_pretrained(repo)
            model = from_pretrained(AutoModelForSeq2SeqLM, repo, dtype)
            model.to(_device)
            model.eval()
        except Exception as err:  # noqa: BLE001 — any failure means "try the next one"
            failures.append(f"{repo}: {type(err).__name__}: {err}")
            print(f"[nllb] could not load {repo}: {type(err).__name__}: {err}", flush=True)
            gc.collect()
            if _device == "cuda":
                torch.cuda.empty_cache()
            continue

        _tokenizer, _model, _mode = tokenizer, model, mode
        MODEL_NAME = repo
        _fell_back = mode != REQUESTED_MODE
        print(f"[nllb] model ready: {repo} ({mode} mode) on {_device}", flush=True)
        if _fell_back:
            print(
                f"[nllb] NOTE: '{REQUESTED_MODE}' mode could not run here, so "
                f"'{mode}' mode is answering instead (set NLLB_MODE={mode} to silence this).",
                flush=True,
            )
        return True

    _load_error = " | ".join(failures) or "no model could be loaded"
    print(f"[nllb] every model failed: {_load_error}", flush=True)
    return False


def check_key(authorization: str | None, x_api_key: str | None):
    if not API_KEY:
        return
    bearer = ""
    if authorization and authorization.lower().startswith("bearer "):
        bearer = authorization[7:].strip()
    provided = bearer or (x_api_key or "").strip()
    if provided != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid or missing API key")


def translate_batch(lines: list[Line], src_lang: str, tgt_lang: str) -> list[dict]:
    import torch

    if not load():
        raise HTTPException(
            status_code=503,
            detail=f"No NLLB model could be loaded: {_load_error}",
        )

    tokenizer = _tokenizer
    model = _model

    tokenizer.src_lang = src_lang
    forced_id = tokenizer.convert_tokens_to_ids(tgt_lang)
    if forced_id is None or forced_id == tokenizer.unk_token_id:
        raise HTTPException(status_code=400, detail=f"Unknown target language: {tgt_lang}")

    texts = [line.text.strip() for line in lines]

    translated: list[dict] = []
    for start in range(0, len(texts), BATCH_SIZE):
        chunk = texts[start : start + BATCH_SIZE]
        inputs = tokenizer(chunk, return_tensors="pt", padding=True, truncation=True, max_length=512)
        inputs = {key: value.to(_device) for key, value in inputs.items()}

        with torch.inference_mode():
            generated = model.generate(
                **inputs,
                forced_bos_token_id=forced_id,
                max_new_tokens=MAX_NEW_TOKENS,
                num_beams=NUM_BEAMS,
            )

        decoded = tokenizer.batch_decode(generated, skip_special_tokens=True)
        translated.extend(
            {"id": lines[start + offset].id, "khmer": (text or "").strip()}
            for offset, text in enumerate(decoded)
        )

    return translated


@app.get("/")
def status():
    return {
        "status": "ok",
        "service": "NLLB Translation API",
        "version": app.version,
        "model": MODEL_NAME,
        # Which preset is answering, and whether it had to be lowered to fit.
        "mode": _mode,
        "requestedMode": REQUESTED_MODE,
        "fallback": _fell_back,
        "device": _device,
        "loaded": _model is not None,
        "loadError": _load_error,
        "numBeams": NUM_BEAMS,
        "batchSize": BATCH_SIZE,
        "busy": False,
    }


@app.post("/translate")
def translate(
    request: TranslateRequest,
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None),
):
    check_key(authorization, x_api_key)

    lines = [line for line in request.lines if line.text and line.text.strip()]
    if not lines:
        return {"segments": [], "model": MODEL_NAME, "device": _device}
    if len(lines) > MAX_LINES:
        raise HTTPException(status_code=400, detail=f"Too many lines (max {MAX_LINES})")

    started = time.time()
    segments = translate_batch(lines, request.src_lang or "eng_Latn", request.tgt_lang or "khm_Khmr")
    print(
        f"[nllb] translated {len(segments)} line(s) in {time.time() - started:.2f}s "
        f"({request.src_lang} -> {request.tgt_lang})",
        flush=True,
    )
    return {
        "segments": segments,
        "model": MODEL_NAME,
        "mode": _mode,
        "device": _device,
        "elapsedMs": int((time.time() - started) * 1000),
    }


if __name__ == "__main__":
    import uvicorn

    # Load eagerly on boot so the first real job does not pay for it. A failure is
    # not fatal: the service still serves `GET /` with the reason, which is what
    # the website's test button shows.
    load()
    uvicorn.run(app, host=HOST, port=PORT)

"""
NLLB-200 translation service — the translator KhmerDub AI runs on Google Colab.

The website never loads the model itself: `facebook/nllb-200-distilled-600M`
needs about 1.5 GB of RAM, which the free Render instance (512 MB) does not
have. So the model lives on a Colab GPU/CPU session here, and the website sends
it plain text over HTTP.

Contract (what `server/services/nllbProvider.ts` calls):

    GET  /            -> {"status":"ok", "service":"NLLB Translation API",
                          "version":..., "model":..., "device":"cuda"|"cpu"}
    POST /translate   -> {"segments":[{"id": "...", "khmer": "..."}, ...]}

    POST /translate body:
        {
          "lines": [{"id": "...", "text": "..."}, ...],
          "src_lang": "eng_Latn",     # FLORES-200 code of the source
          "tgt_lang": "khm_Khmr"      # always Khmer from this pipeline
        }

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

MODEL_NAME = os.environ.get("NLLB_MODEL", "facebook/nllb-200-distilled-600M")
PORT = int(os.environ.get("PORT", "8000"))
HOST = os.environ.get("NLLB_HOST", "0.0.0.0")
API_KEY = os.environ.get("NLLB_API_KEY", "").strip()
MAX_LINES = int(os.environ.get("NLLB_MAX_LINES", "64"))
MAX_NEW_TOKENS = int(os.environ.get("NLLB_MAX_NEW_TOKENS", "400"))

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


class Line(BaseModel):
    id: str
    text: str


class TranslateRequest(BaseModel):
    lines: list[Line]
    src_lang: str = "eng_Latn"
    tgt_lang: str = "khm_Khmr"


def load():
    """Load the tokenizer and the model once, on first use."""
    global _tokenizer, _model, _device
    if _model is not None:
        return

    import torch
    from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

    _device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"[nllb] loading {MODEL_NAME} on {_device} ...", flush=True)
    _tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)
    _model = AutoModelForSeq2SeqLM.from_pretrained(MODEL_NAME)
    _model.to(_device)
    _model.eval()
    print("[nllb] model ready", flush=True)


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

    load()
    tokenizer = _tokenizer
    model = _model

    tokenizer.src_lang = src_lang
    forced_id = tokenizer.convert_tokens_to_ids(tgt_lang)
    if forced_id is None or forced_id == tokenizer.unk_token_id:
        raise HTTPException(status_code=400, detail=f"Unknown target language: {tgt_lang}")

    texts = [line.text.strip() for line in lines]
    inputs = tokenizer(texts, return_tensors="pt", padding=True, truncation=True, max_length=512)
    inputs = {key: value.to(_device) for key, value in inputs.items()}

    with torch.no_grad():
        generated = model.generate(
            **inputs,
            forced_bos_token_id=forced_id,
            max_new_tokens=MAX_NEW_TOKENS,
            num_beams=1,
        )

    decoded = tokenizer.batch_decode(generated, skip_special_tokens=True)
    return [
        {"id": line.id, "khmer": (decoded[index] or "").strip()}
        for index, line in enumerate(lines)
    ]


@app.get("/")
def status():
    return {
        "status": "ok",
        "service": "NLLB Translation API",
        "version": app.version,
        "model": MODEL_NAME,
        "device": _device,
        "loaded": _model is not None,
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
        "device": _device,
        "elapsedMs": int((time.time() - started) * 1000),
    }


if __name__ == "__main__":
    import uvicorn

    # Load eagerly on boot so the first real job does not pay for it.
    load()
    uvicorn.run(app, host=HOST, port=PORT)

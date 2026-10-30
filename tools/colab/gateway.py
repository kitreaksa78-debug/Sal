#!/usr/bin/env python3
"""gateway.py — one public URL for the two Colab services.

`tools/colab/start-all.sh` starts the stem service (Demucs) on 8920 and the
voice conversion service on 8930, then puts this gateway on 8080 — the single
port the Cloudflare quick tunnel exposes. The website is then given one URL and
one key instead of two, and each card still reaches the API it expects because
the gateway forwards by path:

    /separate  /api/separate  /demucs  /enhance  /api/enhance  /clean
                                                          -> stem service
    /convert   /api/convert   /voice-clone                -> voice service
    /files/{job}/{name}                                   -> whichever has it
    /health                                               -> both, merged
    /                                                     -> what is inside

Two details matter and are the reason this is not just "mount both apps":

* The services build the download links they return from `request.base_url`, so
  the caller's `Host` (and `X-Forwarded-Proto`) has to survive the hop. Without
  that the site is handed `http://127.0.0.1:8930/...` links it can never fetch.
* Both services answer `/health`, and the site asks it first to tell a dead
  tunnel from a wrong key. The merged answer keeps the fields the cards already
  parse (`device`, `model`, `loaded`, `busy`) and adds a nested snapshot of each
  side under `demucs` / `voice`, plus `services` naming what is actually up.

Everything is POSIX, one process, no state: the gateway is disposable, the
services own the files.
"""

import os
from typing import Any, Dict, Optional, Tuple

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response

SERVICE_KEY = (os.environ.get("SERVICE_KEY") or "").strip()
DEMUCS_URL = (os.environ.get("DEMUCS_URL") or "http://127.0.0.1:8920").rstrip("/")
VOICE_URL = (os.environ.get("VOICE_URL") or "http://127.0.0.1:8930").rstrip("/")

DEMUCS_PATHS = {
    "/separate",
    "/api/separate",
    "/demucs",
    "/enhance",
    "/api/enhance",
    "/clean",
}
VOICE_PATHS = {"/convert", "/api/convert", "/voice-clone"}

# Headers that describe this one connection; forwarding them would tell httpx
# and the service behind it two different things about the same request.
HOP_BY_HOP = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
    "content-length",
    "host",
}

app = FastAPI(title="colab-studio", docs_url=None, redoc_url=None)

# No read timeout: a 60-second chunk on a busy GPU can take minutes, and this
# request is exactly the one that must not be cut in half.
client = httpx.AsyncClient(
    timeout=httpx.Timeout(connect=15.0, read=None, write=None, pool=None)
)


def _presented_key(request: Request) -> str:
    """The key as either service reads it: bearer token or `X-API-Key`."""
    auth = (request.headers.get("authorization") or "").strip()
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return (request.headers.get("x-api-key") or "").strip()


def _require_key(request: Request) -> None:
    if SERVICE_KEY and _presented_key(request) != SERVICE_KEY:
        raise HTTPException(status_code=401, detail="invalid service key")


def _forward_headers(request: Request) -> Dict[str, str]:
    headers = {k: v for k, v in request.headers.items() if k.lower() not in HOP_BY_HOP}
    # Keep the address the browser used: the services quote it back in the file
    # links they return, and the website downloads those over the tunnel.
    headers["host"] = request.headers.get("host", "")
    headers["x-forwarded-proto"] = request.headers.get("x-forwarded-proto") or "https"
    return headers


async def _send(
    method: str, url: str, request: Request
) -> Tuple[Optional[httpx.Response], Optional[str]]:
    body = await request.body() if method not in ("GET", "HEAD") else None
    try:
        return (
            await client.request(method, url, headers=_forward_headers(request), content=body),
            None,
        )
    except httpx.HTTPError as err:  # connection refused, DNS, timeout
        return None, f"{type(err).__name__}: {err}"


def _answer(resp: httpx.Response) -> Response:
    headers = {}
    disposition = resp.headers.get("content-disposition")
    if disposition:
        headers["content-disposition"] = disposition
    return Response(
        content=resp.content,
        status_code=resp.status_code,
        media_type=resp.headers.get("content-type") or "application/json",
        headers=headers,
    )


async def _probe(url: str) -> Optional[Dict[str, Any]]:
    """`/health` of one side, or None — a dead service is reported, not raised."""
    try:
        resp = await client.get(
            url, headers={"Authorization": f"Bearer {SERVICE_KEY}"}, timeout=20.0
        )
    except httpx.HTTPError:
        return None
    if resp.status_code != 200:
        return None
    data = resp.json()
    return data if isinstance(data, dict) else None


@app.get("/")
def index() -> Dict[str, Any]:
    """Public, like both services' own root: what this URL can do."""
    return {
        "service": "colab-studio",
        "urls": 1,
        "endpoints": [
            "/health",
            "/separate",
            "/enhance",
            "/convert",
            "/files/{job}/{name}",
        ],
        "services": ["demucs", "voice"],
        "demucs_url": DEMUCS_URL,
        "voice_url": VOICE_URL,
        "note": "gateway: one tunnel, two services",
    }


@app.get("/health")
async def health(request: Request) -> Any:
    _require_key(request)
    demucs = await _probe(f"{DEMUCS_URL}/health")
    voice = await _probe(f"{VOICE_URL}/health")

    if demucs is None and voice is None:
        return JSONResponse(
            status_code=503,
            content={
                "status": "unavailable",
                "service": "colab-studio",
                "services": [],
                "demucs": None,
                "voice": None,
            },
        )

    device = (demucs or {}).get("device") or (voice or {}).get("device") or "unknown"
    return {
        "status": "ok",
        # No service name in here may read like "demucs" or "translation": the
        # site's cards use this label to reject a URL that points elsewhere.
        "service": "colab-studio",
        "services": [name for name, up in (("demucs", demucs), ("voice", voice)) if up],
        "device": device,
        "model": (demucs or {}).get("model", ""),
        "enhance_models": (demucs or {}).get("enhance_models", []),
        "inprocess": (demucs or {}).get("inprocess", False),
        "loaded": (demucs or {}).get("loaded", []),
        "busy": bool((demucs or {}).get("busy")) or bool((voice or {}).get("busy")),
        "demucs": demucs,
        "voice": voice,
    }


@app.get("/files/{job}/{name}")
async def files(job: str, name: str, request: Request) -> Response:
    """Both services serve their results under the same path, so try both."""
    for base in (DEMUCS_URL, VOICE_URL):
        resp, _err = await _send("GET", f"{base}/files/{job}/{name}", request)
        if resp is not None and resp.status_code != 404:
            return _answer(resp)
    return JSONResponse(status_code=404, content={"detail": "not found"})


@app.api_route(
    "/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]
)
async def forward(path: str, request: Request) -> Response:
    route = f"/{path}"

    if route in DEMUCS_PATHS:
        base, name = DEMUCS_URL, "demucs"
    elif route in VOICE_PATHS:
        base, name = VOICE_URL, "voice"
    else:
        return JSONResponse(
            status_code=404,
            content={
                "detail": f"unknown endpoint {route}",
                "endpoints": sorted(DEMUCS_PATHS | VOICE_PATHS | {"/health", "/files/{job}/{name}"}),
            },
        )

    resp, err = await _send(request.method, f"{base}{route}", request)
    if resp is None:
        # Same shape the services use, so the site's own error text stays useful.
        return JSONResponse(
            status_code=502,
            content={"detail": f"the {name} service is not answering ({err})"},
        )
    return _answer(resp)

#!/usr/bin/env bash
#
# One-command launcher for the audio-separator stem service.
#
#   sh tools/audio-separator-server/start.sh
#
# What it does:
#   1. Checks Python 3.10+ and creates a local venv on first run
#   2. Installs the requirements (torch CPU build — several GB, first run only)
#   3. Starts the API on port 8920
#   4. When `cloudflared` is installed, opens a public HTTPS tunnel and prints
#      the exact URL and env vars to paste into Render
#
# Stop it with Ctrl-C (that also stops the tunnel).
set -euo pipefail

cd "$(dirname "$0")"

PORT="${SEPARATOR_PORT:-8920}"
API_KEY="${SEPARATOR_API_KEY:-}"

if ! command -v python3 >/dev/null 2>&1; then
  echo "✗ python3 is required (3.10–3.12). Install it first: https://www.python.org/downloads/"
  exit 1
fi

PYV=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
echo "→ python $PYV found"

if [ ! -d venv ]; then
  echo "→ creating virtualenv (first run)"
  python3 -m venv venv
fi
# shellcheck disable=SC1091
. venv/bin/activate

if ! python -c "import fastapi" >/dev/null 2>&1; then
  echo "→ installing dependencies (first run downloads the CPU torch build, several GB)"
  pip install --disable-pip-version-check -r requirements.txt
fi

if [ -z "$API_KEY" ]; then
  API_KEY=$(python -c "import secrets; print(secrets.token_urlsafe(24))")
  echo "→ generated an API key for this session: $API_KEY"
  echo "  (set SEPARATOR_API_KEY yourself to keep it stable across restarts)"
fi

echo "→ starting the stem service on port $PORT"
SEPARATOR_API_KEY="$API_KEY" python -m uvicorn app:app --host 0.0.0.0 --port "$PORT" &
APP_PID=$!
trap 'kill "$APP_PID" 2>/dev/null || true' EXIT

# Wait for the API to accept requests before opening the tunnel.
for _ in $(seq 1 30); do
  if curl -fsS -m 2 -H "Authorization: Bearer $API_KEY" "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
echo "✓ local API ready: http://127.0.0.1:$PORT/health"

if command -v cloudflared >/dev/null 2>&1; then
  echo "→ opening a public Cloudflare tunnel (renders the Render backend can reach)"
  TUNNEL_OUT=$(mktemp)
  cloudflared tunnel --url "http://127.0.0.1:$PORT" --no-autoupdate >"$TUNNEL_OUT" 2>&1 &
  TUNNEL_PID=$!
  trap 'kill "$APP_PID" "$TUNNEL_PID" 2>/dev/null || true' EXIT

  PUBLIC_URL=""
  for _ in $(seq 1 30); do
    PUBLIC_URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_OUT" | head -1 || true)
    [ -n "$PUBLIC_URL" ] && break
    sleep 1
  done

  if [ -n "$PUBLIC_URL" ]; then
    echo
    echo "══════════════════════════════════════════════════════════════"
    echo "✓  DONE — paste these three variables into Render → Environment"
    echo "══════════════════════════════════════════════════════════════"
    echo
    echo "  AUDIO_SEPARATION_PROVIDER = audio_separator"
    echo "  AUDIO_SEPARATOR_URL       = $PUBLIC_URL"
    echo "  AUDIO_SEPARATOR_API_KEY   = $API_KEY"
    echo
    echo "══════════════════════════════════════════════════════════════"
    echo "  Keep this terminal open. Ctrl-C stops both service + tunnel."
    echo "══════════════════════════════════════════════════════════════"
  else
    echo "! tunnel did not report a URL yet — check $TUNNEL_OUT"
    echo "  The local API is still usable at http://127.0.0.1:$PORT"
  fi
else
  echo
  echo "! cloudflared is not installed, so only this machine can reach the service."
  echo "  Install it to expose a public URL for Render: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
  echo "  Then run this script again."
fi

wait

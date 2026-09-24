#!/usr/bin/env bash
#
# One-command launcher for the Demucs API on a phone (Termux).
#
#   sh tools/demucs-termux/start-termux.sh
#
# What it does:
#   1. installs python / ffmpeg / openssh (only if they are missing)
#   2. keeps the CPU awake for the whole separation (termux-wake-lock)
#   3. starts demucs_api.py on port 8000
#   4. opens an SSH tunnel and prints the https URL to paste into the website
#
# Stop it with Ctrl-C: that stops both the API and the tunnel.
set -euo pipefail

cd "$(dirname "$0")"

PORT="${DEMUCS_PORT:-8000}"
API_KEY="${DEMUCS_API_KEY:-}"

if [ -z "${TERMUX_VERSION:-}" ]; then
  echo "This launcher is meant for Termux (Android). On a normal machine run:"
  echo "  pip install -r requirements.txt && python demucs_api.py"
  exit 1
fi

if ! command -v pkg >/dev/null 2>&1; then
  echo "✗ 'pkg' not found — this does not look like Termux."
  exit 1
fi

for pkg_name in python ffmpeg openssh; do
  if ! command -v "$pkg_name" >/dev/null 2>&1; then
    echo "→ installing $pkg_name"
    pkg install -y "$pkg_name"
  fi
done

# Android suspends background CPU work without this, which would stall a long
# separation halfway through.
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock

if ! python -c "import fastapi, uvicorn" >/dev/null 2>&1; then
  echo "→ installing the API dependencies (first run)"
  pip install --disable-pip-version-check -r requirements.txt
fi

if [ -z "$API_KEY" ]; then
  API_KEY=$(python -c "import secrets; print(secrets.token_urlsafe(24))")
  echo "→ generated an API key for this session: $API_KEY"
  echo "  (set DEMUCS_API_KEY yourself to keep it stable across restarts)"
fi

echo "→ starting the Demucs API on port $PORT"
DEMUCS_API_KEY="$API_KEY" python demucs_api.py &
APP_PID=$!
trap 'kill "$APP_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 30); do
  if curl -fsS -m 2 "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
echo "✓ local API ready: http://127.0.0.1:$PORT/"

echo "→ opening a public tunnel (keep this terminal open)"
echo
echo "══════════════════════════════════════════════════════════════"
echo " Copy the https URL printed below into the website:"
echo "   Studio → «ញែកភ្លេង · Demucs API» → URL → រក្សាទុក → សាកល្បង"
echo
echo " API key: $API_KEY"
echo "══════════════════════════════════════════════════════════════"
echo

exec ssh -R 80:"localhost:$PORT" -o StrictHostKeyChecking=accept-new nokey@localhost.run

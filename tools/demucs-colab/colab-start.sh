#!/bin/sh
# colab-start.sh — open the stem service with one pasted line.
#
# In a Google Colab cell (Runtime → Change runtime type → T4 GPU):
#
#   !curl -fsSL https://raw.githubusercontent.com/kitreaksa78-debug/Sal/main/tools/demucs-colab/colab-start.sh | sh
#
# What it does, in order: installs Demucs and the UVR cleanup models, fetches the
# service from the same repository, starts it on this runtime, opens a Cloudflare
# quick tunnel, waits until the tunnel really answers, and prints the pair the
# website's «ញែកភ្លេង · Demucs API» card wants:
#
#   URL : https://xxxx.trycloudflare.com
#   API Key : 3f9c…
#
# Everything here is POSIX sh and reads nothing from stdin, because the script
# itself arrives on stdin through the pipe. Its children get /dev/null as stdin
# for the same reason.
#
# Re-running it is normal — it stops what the previous run started, keeps the
# same API key (so the site does not need re-editing), and prints the new URL.
#
# Optional environment:
#   SERVICE_KEY   a key you choose; otherwise one is generated and remembered
#   DEMUCS_MODEL  default htdemucs (htdemucs_ft is slower but cleaner)
#   PORT          default 8920
#   SKIP_INSTALL=1  skip pip when the packages are already there
#   SKIP_TUNNEL=1   start the service only; no public tunnel
#   PROTOCOL=http2  tunnel over TCP instead of QUIC, for a network that blocks
#                   UDP to Cloudflare's edge (the log then says
#                   "Failed to dial a quic connection")

set -u

REPO_RAW="${REPO_RAW:-https://raw.githubusercontent.com/kitreaksa78-debug/Sal/main}"
SERVICE_PY="${REPO_RAW}/tools/colab/service.py"
PORT="${PORT:-8920}"
DEMUCS_MODEL="${DEMUCS_MODEL:-htdemucs}"

# /content is Colab's session disk; anywhere else keep the files beside the
# caller so the script can be tried outside Colab too.
if [ -d /content ] && [ -w /content ]; then
  WORK="${WORK:-/content}"
else
  WORK="${WORK:-$PWD/colab-stem-service}"
fi
mkdir -p "$WORK" || exit 1

say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
die() {
  printf '\n!! %s\n' "$*" >&2
  exit 1
}

command -v python3 >/dev/null 2>&1 || die "python3 រកមិនឃើញ — សូមប្រើ Colab (Runtime → T4 GPU) ឬ Termux។"

# ---------------------------------------------------------------- 1. the machine
step "1/5 ពិនិត្យម៉ាស៊ីន"
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi -L 2>/dev/null | head -2 || true
else
  say "គ្មាន GPU — វានឹងដើរលើ CPU (យឺតជាង ~៣–៨ ដង)។ ក្នុង Colab: Runtime → Change runtime type → T4 GPU ។"
fi

# ------------------------------------------------------------------ 2. packages
step "2/5 តំឡើងម៉ូឌែល (លើកដំបូង ~៣–៦ នាទី)"
if [ "${SKIP_INSTALL:-0}" = "1" ]; then
  say "រំលងការតំឡើង (SKIP_INSTALL=1)"
elif python3 -c 'import demucs, fastapi, uvicorn, multipart' >/dev/null 2>&1 &&
  command -v audio-separator >/dev/null 2>&1; then
  say "ទាំងអស់មានរួចហើយ — រំលងការតំឡើង"
else
  say "កំពុងតំឡើង Demucs + audio-separator (UVR) ..."
  python3 -m pip install -q --upgrade pip >/dev/null 2>&1 || true
  python3 -m pip install -q demucs "audio-separator[gpu]" fastapi "uvicorn[standard]" python-multipart ||
    die "pip install បរាជ័យ។ សូមរត់បន្ទាត់នេះម្តងទៀត (ការតំឡើងដែលរួចហើយមិនត្រូវធ្វើម្តងទៀតទេ)។"
  say "តំឡើងរួចរាល់"
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  say "តំឡើង ffmpeg ..."
  (apt-get -qq update && apt-get -qq install -y ffmpeg) >/dev/null 2>&1 || true
fi

# ----------------------------------------------------------------- 3. key + code
KEY_FILE="$WORK/.demucs-service-key"
if [ -n "${SERVICE_KEY:-}" ]; then
  KEY="$SERVICE_KEY"
elif [ -f "$KEY_FILE" ]; then
  KEY=$(cat "$KEY_FILE")
else
  KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))') || die "បង្កើត key មិនបាន"
  printf '%s' "$KEY" >"$KEY_FILE"
  chmod 600 "$KEY_FILE" 2>/dev/null || true
fi
[ -n "$KEY" ] || die "SERVICE_KEY ទទេ — សូមទុកវាទទេ ដើម្បីឲ្យស្គ្រីបបង្កើតឲ្យ"

step "3/5 ទាញ service"
curl -fsSL "$SERVICE_PY" -o "$WORK/service.py" ||
  die "ទាញ service.py បរាជ័យ — ពិនិត្យអ៊ីនធឺណិត ឬ REPO_RAW"
say "សរសេររួច: $WORK/service.py"

# ------------------------------------------------------------------ 4. the service
step "4/5 បើក service នៅ port $PORT"
pkill -f "uvicorn service:app" >/dev/null 2>&1 || true
pkill -f "cloudflared tunnel --url http://localhost:$PORT" >/dev/null 2>&1 || true
sleep 1

cd "$WORK" || die "ចូល $WORK មិនបាន"
SERVICE_KEY="$KEY" \
  DEMUCS_MODEL="$DEMUCS_MODEL" \
  SERVICE_FILES="$WORK/stems" \
  nohup python3 -m uvicorn service:app --host 0.0.0.0 --port "$PORT" \
  </dev/null >"$WORK/service.log" 2>&1 &

HEALTH=""
i=0
while [ "$i" -lt 60 ]; do
  if HEALTH=$(curl -fsS -H "Authorization: Bearer $KEY" "http://127.0.0.1:$PORT/health" 2>/dev/null); then
    break
  fi
  HEALTH=""
  i=$((i + 1))
  sleep 2
done
if [ -z "$HEALTH" ]; then
  say "service មិនឆ្លើយ — ២០ បន្ទាត់ចុងក្រោយនៃ log:"
  tail -20 "$WORK/service.log" 2>/dev/null || true
  die "service បើកមិនបាន (មើល $WORK/service.log)"
fi
say "service ឆ្លើយ: $HEALTH"

if [ "${SKIP_TUNNEL:-0}" = "1" ]; then
  printf '\nURL : http://127.0.0.1:%s\nAPI Key : %s\n' "$PORT" "$KEY"
  exit 0
fi

# --------------------------------------------------------------------- 5. tunnel
step "5/5 បើក tunnel (Cloudflare)"
BIN="$WORK/bin"
mkdir -p "$BIN"
if command -v cloudflared >/dev/null 2>&1; then
  CF=$(command -v cloudflared)
elif [ -x "$BIN/cloudflared" ]; then
  CF="$BIN/cloudflared"
else
  case "$(uname -m)" in
    aarch64 | arm64) ARCH=arm64 ;;
    *) ARCH=amd64 ;;
  esac
  say "ទាញ cloudflared ($ARCH) ..."
  curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$ARCH" \
    -o "$BIN/cloudflared" || die "ទាញ cloudflared បរាជ័យ — ពិនិត្យអ៊ីនធឺណិត"
  chmod +x "$BIN/cloudflared"
  CF="$BIN/cloudflared"
fi

: >"$WORK/tunnel.log"
if [ -n "${PROTOCOL:-}" ]; then
  say "ប្រើ protocol $PROTOCOL"
  nohup "$CF" tunnel --no-autoupdate --protocol "$PROTOCOL" --url "http://localhost:$PORT" \
    </dev/null >"$WORK/tunnel.log" 2>&1 &
else
  nohup "$CF" tunnel --no-autoupdate --url "http://localhost:$PORT" \
    </dev/null >"$WORK/tunnel.log" 2>&1 &
fi

URL=""
i=0
while [ "$i" -lt 40 ]; do
  URL=$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$WORK/tunnel.log" 2>/dev/null | head -1)
  [ -n "$URL" ] && break
  i=$((i + 1))
  sleep 2
done
if [ -z "$URL" ]; then
  tail -20 "$WORK/tunnel.log" 2>/dev/null || true
  die "tunnel មិនបាន URL — សូមរត់បន្ទាត់នេះម្តងទៀត"
fi

# The tunnel needs a few seconds before Cloudflare routes to it; the site's
# «រក្សាទុក និងសាកល្បង» button must not be the first thing that reaches it.
READY=0
i=0
while [ "$i" -lt 45 ]; do
  if curl -fsS -H "Authorization: Bearer $KEY" "$URL/health" >/dev/null 2>&1; then
    READY=1
    break
  fi
  i=$((i + 1))
  sleep 2
done

DEVICE=$(printf '%s' "$HEALTH" | grep -o '"device":"[a-z]*"' | head -1 | cut -d'"' -f4)

printf '\n============================================================\n'
printf '  ចម្លងប្លុកនេះទៅកាត «ញែកភ្លេង · Demucs API» ក្នុងសាយ\n'
printf '============================================================\n'
printf 'URL : %s\n' "$URL"
printf 'API Key : %s\n' "$KEY"
printf '============================================================\n'
[ -n "$DEVICE" ] && printf 'ឧបករណ៍ : %s\n' "$DEVICE"
if [ "$READY" = "1" ]; then
  printf 'ស្ថានភាព : រួចរាល់ — tunnel ឆ្លើយតបរួចហើយ\n'
elif grep -q 'Registered tunnel connection' "$WORK/tunnel.log" 2>/dev/null; then
  printf 'ស្ថានភាព : tunnel ភ្ជាប់ហើយ តែមិនទាន់ឆ្លើយ — រង់ចាំ ~១៥ វិនាទីទៀត រួចសាកល្បងម្តងទៀត\n'
else
  printf 'ស្ថានភាព : cloudflared មិនអាចភ្ជាប់ទៅ Cloudflare បានទេ — URL នេះនឹងបង្ហាញ Error 1033\n'
  printf '            មូលហេតុធម្មតា: network បិទ UDP 7844។ សាករត់ម្តងទៀតដោយ:\n'
  printf '            PROTOCOL=http2 sh colab-start.sh\n'
  tail -2 "$WORK/tunnel.log" 2>/dev/null | sed 's/^/            /' || true
fi
printf '\n'
say "• ទុក tab នេះបើកចុះ — បិទ tab ឬទុក idle ~៩០ នាទី = session ដាច់ ហើយ URL ស្លាប់។"
say "• session ដាច់ → រត់បន្ទាត់នេះម្តងទៀត។ Key ដដែល (រក្សាក្នុង $KEY_FILE) ដូច្នេះក្នុងសាយប្តូរតែ URL។"
say "• stem រក្សាក្នុង $WORK/stems រហូត session ដាច់។ log: $WORK/service.log · $WORK/tunnel.log"

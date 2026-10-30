#!/bin/sh
# start-all.sh — បើកសេវាទាំងពីរ (ញែកភ្លេង + ប្តូរសំឡេង) ដោយបន្ទាត់តែមួយ និង URL តែមួយ។
#
# ក្នុង cell របស់ Google Colab (Runtime → Change runtime type → T4 GPU)៖
#
#   !curl -fsSL https://raw.githubusercontent.com/kitreaksa78-debug/Sal/main/tools/colab/start-all.sh | sh
#
# វាធ្វើតាមលំដាប់៖
#   1. ទាញស្គ្រីបទាំងពីរ + gateway.py
#   2. តំឡើង និងបើក Demucs នៅ port 8920 (ឥត tunnel)
#   3. តំឡើង និងបើក Voice Convert API នៅ port 8930 (ឥត tunnel)
#   4. បើក gateway.py នៅ port 8080 — វាបញ្ជូនតាម path ទៅសេវាត្រូវគ្នា
#   5. បើក tunnel តែមួយទៅ 8080 រួចបោះប្លុក URL + API Key តែមួយ
#
# កាតក្នុងសាយ៖ paste ប្លុកនេះម្តងចូលកាត «ញែកភ្លេង · Demucs API»។ សាយស្គាល់
# សេវារួមនេះដោយខ្លួនឯង (health មាន `services: ["demucs","voice"]`) ដូច្នេះកាត
# «ប្តូរសំឡេង» ទទួល URL + key ដដែលដោយស្វ័យប្រវត្តិ — មិនចាំបាច់ paste ពីរដង។
#
# អថេរស្រេចចិត្ត៖
#   SERVICE_KEY=...   key ដែលអ្នកជ្រើស (ទុកទទេ = បង្កើតឲ្យ រួចចងចាំ)
#   SKIP_INSTALL=1    រំលង pip ពេល library មានរួច
#   DEMUCS_PORT=8920 VOICE_PORT=8930 GATEWAY_PORT=8080
#   PROTOCOL=http2    tunnel តាម TCP ពេល network បិទ UDP
#
# POSIX sh, អានអ្វីពី stdin ទេ (ស្គ្រីបមកតាម pipe) — ដូច្នេះកូនៗទាំងអស់ទទួល
# /dev/null ជា stdin។

set -u

REPO_RAW="${REPO_RAW:-https://raw.githubusercontent.com/kitreaksa78-debug/Sal/main}"
DEMUCS_PORT="${DEMUCS_PORT:-8920}"
VOICE_PORT="${VOICE_PORT:-8930}"
GATEWAY_PORT="${GATEWAY_PORT:-8080}"
# Where the tunnel is registered, and whether that happens without pasting. One
# PUT fills both cards: the site sees the combined `/health` and copies the
# address to the voice card itself. `AUTO_CONNECT=0` prints the block only.
SITE_URL="${SITE_URL:-https://sal-juma.onrender.com}"
AUTO_CONNECT="${AUTO_CONNECT:-1}"

if [ -d /content ] && [ -w /content ]; then
  WORK="${WORK:-/content/colab-studio}"
else
  WORK="${WORK:-$PWD/colab-studio}"
fi
mkdir -p "$WORK" || exit 1

say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
die() {
  printf '\n!! %s\n' "$*" >&2
  exit 1
}

command -v python3 >/dev/null 2>&1 || die "python3 រកមិនឃើញ — សូមប្រើ Colab (Runtime → T4 GPU)។"

if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi -L 2>/dev/null | head -2 || true
else
  say "គ្មាន GPU — វានឹងដើរលើ CPU (ញែកភ្លេងយឺតជាង ~៣–៨ ដង)។ ក្នុង Colab: Runtime → Change runtime type → T4 GPU ។"
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  say "តំឡើង ffmpeg ..."
  (apt-get -qq update && apt-get -qq install -y ffmpeg) >/dev/null 2>&1 || true
fi

# --------------------------------------------------------------- 1. key + code
step "1/5 ទាញស្គ្រីប"
KEY_FILE="$WORK/.studio-key"
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

curl -fsSL "$REPO_RAW/tools/demucs-colab/colab-start.sh" -o "$WORK/demucs-start.sh" ||
  die "ទាញ demucs-start.sh បរាជ័យ — ពិនិត្យអ៊ីនធឺណិត ឬ REPO_RAW"
curl -fsSL "$REPO_RAW/tools/voice-clone/colab-start.sh" -o "$WORK/voice-start.sh" ||
  die "ទាញ voice-start.sh បរាជ័យ — ពិនិត្យអ៊ីនធឺណិត ឬ REPO_RAW"
curl -fsSL "$REPO_RAW/tools/colab/gateway.py" -o "$WORK/gateway.py" ||
  die "ទាញ gateway.py បរាជ័យ — ពិនិត្យអ៊ីនធឺណិត ឬ REPO_RAW"
say "រួចរាល់: $WORK"

# ------------------------------------------------------------------- 2. demucs
say ""
say "⚠️  បន្ទាត់ URL ដែលមាន 127.0.0.1 ខាងក្រោមជាអាសយដ្ឋានក្នុង Colab — កុំយកទៅ paste"
say "    ក្នុងសាយ។ ប្លុកសម្រាប់សាយគឺបង្ហាញនៅចុងបញ្ចប់ (5/5) ជា https://xxxx.trycloudflare.com ។"
step "2/5 ញែកភ្លេង (Demucs) នៅ port $DEMUCS_PORT"
WORK="$WORK/demucs" \
  SKIP_TUNNEL=1 \
  PORT="$DEMUCS_PORT" \
  SERVICE_KEY="$KEY" \
  sh "$WORK/demucs-start.sh" </dev/null ||
  die "Demucs បើកមិនបាន — មើលសារខាងលើ (log: $WORK/demucs/service.log)"

# -------------------------------------------------------------- 3. voice clone
step "3/5 ប្តូរសំឡេង (Voice Convert API) នៅ port $VOICE_PORT"
SERVICE=1 \
  SKIP_TUNNEL=1 \
  WORK="$WORK/voice" \
  PORT="$VOICE_PORT" \
  SERVICE_KEY="$KEY" \
  sh "$WORK/voice-start.sh" </dev/null ||
  die "Voice Convert បើកមិនបាន — មើលសារខាងលើ (log: $WORK/voice/service.log)"

# ------------------------------------------------------------------ 4. gateway
step "4/5 បើក gateway នៅ port $GATEWAY_PORT"
python3 -m pip install -q httpx fastapi "uvicorn[standard]" >/dev/null 2>&1 || true

if [ -f "$WORK/gateway.pid" ]; then
  kill "$(cat "$WORK/gateway.pid")" >/dev/null 2>&1 || true
  rm -f "$WORK/gateway.pid"
fi
sleep 1

cd "$WORK" || die "ចូល $WORK មិនបាន"
SERVICE_KEY="$KEY" \
  DEMUCS_URL="http://127.0.0.1:$DEMUCS_PORT" \
  VOICE_URL="http://127.0.0.1:$VOICE_PORT" \
  nohup python3 -m uvicorn gateway:app --host 127.0.0.1 --port "$GATEWAY_PORT" \
  </dev/null >"$WORK/gateway.log" 2>&1 &
echo $! >"$WORK/gateway.pid"

HEALTH=""
i=0
while [ "$i" -lt 30 ]; do
  if HEALTH=$(curl -fsS -H "Authorization: Bearer $KEY" "http://127.0.0.1:$GATEWAY_PORT/health" 2>/dev/null); then
    break
  fi
  HEALTH=""
  i=$((i + 1))
  sleep 2
done
if [ -z "$HEALTH" ]; then
  say "gateway មិនឆ្លើយ — ២០ បន្ទាត់ចុងក្រោយនៃ log៖"
  tail -20 "$WORK/gateway.log" 2>/dev/null || true
  die "gateway បើកមិនបាន (មើល $WORK/gateway.log)"
fi
say "gateway ឆ្លើយ: $HEALTH"

# ------------------------------------------------------------------- 5. tunnel
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
  nohup "$CF" tunnel --no-autoupdate --protocol "$PROTOCOL" --url "http://localhost:$GATEWAY_PORT" \
    </dev/null >"$WORK/tunnel.log" 2>&1 &
else
  nohup "$CF" tunnel --no-autoupdate --url "http://localhost:$GATEWAY_PORT" \
    </dev/null >"$WORK/tunnel.log" 2>&1 &
fi
echo $! >"$WORK/tunnel.pid"

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
printf '  ចម្លងប្លុកនេះ paste ម្តងចូលកាត «ញែកភ្លេង · Demucs API»\n'
printf '  (ញែកភ្លេង + ប្តូរសំឡេង ប្រើ URL ដដែលនេះទាំងពីរ)\n'
printf '============================================================\n'
printf 'URL : %s\n' "$URL"
printf 'API Key : %s\n' "$KEY"
printf '============================================================\n'
[ -n "$DEVICE" ] && printf 'ឧបករណ៍ : %s\n' "$DEVICE"
if [ "$READY" = "1" ]; then
  printf 'ស្ថានភាព : រួចរាល់ — tunnel ឆ្លើយតបរួចហើយ\n'
elif grep -q 'Registered tunnel connection' "$WORK/tunnel.log" 2>/dev/null; then
  printf 'ស្ថានភាព : tunnel ភ្ជាប់ហើយ តែមិនទាន់ឆ្លើយ — រង់ចាំ ~១៥ វិនាទីទៀត\n'
else
  printf 'ស្ថានភាព : cloudflared មិនអាចភ្ជាប់ទៅ Cloudflare បានទេ — URL នេះនឹងបង្ហាញ Error 1033\n'
  printf '            មូលហេតុធម្មតា: network បិទ UDP 7844។ សាករត់ម្តងទៀតដោយ:\n'
  printf '            PROTOCOL=http2 sh start-all.sh\n'
  tail -2 "$WORK/tunnel.log" 2>/dev/null | sed 's/^/            /' || true
fi
# --------------------------------------------------- 6. connect to the website
# The site's `PUT /api/config/separator` is what the card's save button calls:
# the same address and key, saved as if they had been pasted. The site then sees
# the combined `/health` and fills the voice card too, so nothing is typed here.
if [ "$AUTO_CONNECT" = "1" ]; then
  printf '\n==> ភ្ជាប់ទៅសាយ %s\n' "$SITE_URL"
  BODY=$(printf '{"url":"%s","apiKey":"%s"}' "$URL" "$KEY")
  CODE=$(curl -sS --max-time 30 -o "$WORK/connect.json" -w '%{http_code}' \
    -X PUT "$SITE_URL/api/config/separator" \
    -H 'Content-Type: application/json' \
    --data "$BODY" 2>/dev/null) || CODE="000"
  if [ "$CODE" = "200" ]; then
    printf '✅ ភ្ជាប់រួច — កាត «ញែកភ្លេង» និង «ប្តូរសំឡេង» ប្រើ URL នេះហើយ។ សូម reload ទំព័រសាយ។\n'
  else
    printf '⚠️  ភ្ជាប់ស្វ័យប្រវត្តិមិនបាន (HTTP %s) — សូម paste ប្លុកខាងលើចូលកាតដោយដៃ។\n' "$CODE"
    head -c 300 "$WORK/connect.json" 2>/dev/null | sed 's/^/            /' || true
    printf '\n'
  fi
fi

printf '\n'
say "• ទុក tab នេះបើកចុះ — បិទ tab ឬ idle ~៩០ នាទី = session ដាច់ ហើយ URL ស្លាប់។"
say "• session ដាច់ → រត់បន្ទាត់នេះម្តងទៀត។ Key ដដែល (ក្នុង $KEY_FILE) ដូច្នេះប្តូរតែ URL។"
say "• log: $WORK/demucs/service.log · $WORK/voice/service.log · $WORK/gateway.log · $WORK/tunnel.log"

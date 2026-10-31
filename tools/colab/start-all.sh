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

# >>> port helpers
# Re-running the cell (or a session that quietly kept the old processes) leaves
# a port taken, and uvicorn then dies with "address already in use" — no
# gateway, no tunnel, no URL. Stop only what this work dir started, and if a
# stranger holds the port, move on to the next free one instead of failing.
port_busy() {
  python3 -c 'import socket, sys
try:
    socket.create_connection(("127.0.0.1", int(sys.argv[1])), 0.4).close()
except OSError:
    sys.exit(1)
' "$1"
}

port_owners() {
  if command -v fuser >/dev/null 2>&1; then
    fuser -n tcp "$1" 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$' || true
  elif command -v lsof >/dev/null 2>&1; then
    lsof -ti "tcp:$1" 2>/dev/null || true
  elif command -v ss >/dev/null 2>&1; then
    ss -lptn "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 || true
  fi
}

claim_port() {
  _port=$1
  _name=$2
  if [ -f "$WORK/$_name.pid" ]; then
    kill "$(cat "$WORK/$_name.pid")" >/dev/null 2>&1 || true
    rm -f "$WORK/$_name.pid"
  fi
  _tries=0
  while port_busy "$_port" && [ "$_tries" -lt 5 ]; do
    for _pid in $(port_owners "$_port"); do
      # `python3 -m uvicorn service:app` carries no path of its own, so the
      # working directory is what says the process came from this run.
      if grep -qaE "$WORK|gateway:app" "/proc/$_pid/cmdline" 2>/dev/null ||
        readlink "/proc/$_pid/cwd" 2>/dev/null | grep -qF "$WORK"; then
        kill "$_pid" >/dev/null 2>&1 || true
      fi
    done
    sleep 1
    _tries=$((_tries + 1))
  done
  _tries=0
  while port_busy "$_port" && [ "$_tries" -lt 12 ]; do
    _port=$((_port + 1))
    _tries=$((_tries + 1))
  done
  printf '%s' "$_port"
}
# <<< port helpers

for _spec in demucs voice gateway; do
  case "$_spec" in
    demucs) _want=$DEMUCS_PORT ;;
    voice) _want=$VOICE_PORT ;;
    gateway) _want=$GATEWAY_PORT ;;
  esac
  _got=$(claim_port "$_want" "$_spec")
  [ "$_got" = "$_want" ] || say "port $_want ជាប់រវល់ — ប្រើ $_got ជំនួស"
  case "$_spec" in
    demucs) DEMUCS_PORT=$_got ;;
    voice) VOICE_PORT=$_got ;;
    gateway) GATEWAY_PORT=$_got ;;
  esac
done

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

# A tunnel from an earlier run still forwards the old port; drop it first.
stop_tunnel() {
  if [ -f "$WORK/tunnel.pid" ]; then
    kill "$(cat "$WORK/tunnel.pid")" >/dev/null 2>&1 || true
    rm -f "$WORK/tunnel.pid"
  fi
}
stop_tunnel

# One provider is not enough. A shared host refuses the quick tunnel right
# after it opens (the log ends with "no more connections active and exiting"),
# and an edge that drops UDP kills QUIC even though the pre-check passed. So
# each address is tried in turn and kept only if it really reaches the gateway
# — the same request the site's badge makes, so green here means green there.
# A finished child stays in the process table until its parent waits on it,
# and `kill -0` keeps saying it is there. `/proc` tells the difference, so a
# provider that died is noticed in seconds instead of after a minute.
pid_alive() {  # $1 = pid
  [ -n "$1" ] || return 1
  if [ -r "/proc/$1/stat" ]; then
    _s=$(sed -n 's/^.*) \(.\).*/\1/p' "/proc/$1/stat" 2>/dev/null)
    [ -n "$_s" ] && [ "$_s" != "Z" ]
  else
    kill -0 "$1" 2>/dev/null
  fi
}

find_url() {  # $1 = tries, $2 = regex -> prints the address
  _i=0
  _pid=$(cat "$WORK/tunnel.pid" 2>/dev/null || true)
  while [ "$_i" -lt "$1" ]; do
    _u=$(grep -Eo "$2" "$WORK/tunnel.log" 2>/dev/null | head -1)
    if [ -n "$_u" ]; then
      printf '%s' "$_u"
      return 0
    fi
    # A provider that has already exited will never print an address: move to
    # the next one now instead of waiting out the whole window.
    pid_alive "$_pid" || return 1
    _i=$((_i + 1))
    sleep 2
  done
  return 1
}

tunnel_answers() {  # $1 = url, $2 = tries
  _i=0
  while [ "$_i" -lt "$2" ]; do
    if curl -fsS --max-time 10 -H "Authorization: Bearer $KEY" "$1/health" >/dev/null 2>&1; then
      return 0
    fi
    _i=$((_i + 1))
    sleep 2
  done
  return 1
}

try_cloudflared() {  # $1 = label, rest = extra cloudflared args
  _label=$1
  shift
  say "… $_label"
  : >"$WORK/tunnel.log"
  nohup "$CF" tunnel --no-autoupdate "$@" --url "http://localhost:$GATEWAY_PORT" \
    </dev/null >"$WORK/tunnel.log" 2>&1 &
  echo $! >"$WORK/tunnel.pid"
  _u=$(find_url 30 'https://[a-z0-9-]+\.trycloudflare\.com') || {
    stop_tunnel
    return 1
  }
  if tunnel_answers "$_u" 20; then
    URL="$_u"
    KIND="$_label"
    return 0
  fi
  stop_tunnel
  return 1
}

try_ssh() {  # $1 = label, $2 = user@host, $3 = regex
  _label=$1
  if ! command -v ssh >/dev/null 2>&1; then
    say "… $_label — គ្មាន ssh ក្នុងម៉ាស៊ីននេះ"
    return 1
  fi
  say "… $_label"
  : >"$WORK/tunnel.log"
  nohup ssh -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null \
    -o ServerAliveInterval=20 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes \
    -o BatchMode=yes -N -R 80:localhost:"$GATEWAY_PORT" "$2" \
    </dev/null >"$WORK/tunnel.log" 2>&1 &
  echo $! >"$WORK/tunnel.pid"
  _u=$(find_url 30 "$3") || {
    stop_tunnel
    return 1
  }
  if tunnel_answers "$_u" 20; then
    URL="$_u"
    KIND="$_label"
    return 0
  fi
  stop_tunnel
  return 1
}

URL=""
KIND=""
if [ -n "${PROTOCOL:-}" ]; then
  try_cloudflared "Cloudflare · $PROTOCOL" --protocol "$PROTOCOL" || true
fi
if [ -z "$URL" ]; then
  try_cloudflared "Cloudflare · quic" \
    || try_cloudflared "Cloudflare · http2" --protocol http2 \
    || try_ssh "localhost.run" "nokey@localhost.run" 'https://[a-z0-9-]+\.(lhr\.life|localhost\.run)' \
    || try_ssh "serveo.net" "serveo.net" 'https://[a-z0-9-]+\.serveo\.net' \
    || true
fi

if [ -z "$URL" ]; then
  say "tunnel មិនបាន URL — ២០ បន្ទាត់ចុងក្រោយ៖"
  tail -20 "$WORK/tunnel.log" 2>/dev/null || true
  die "tunnel បើកមិនបាន — សូមរត់បន្ទាត់នេះម្តងទៀត។ (Kaggle: Settings → Internet → On)"
fi
say "tunnel រួចរាល់: $KIND"

READY=1
if ! tunnel_answers "$URL" 10; then
  READY=0
fi

DEVICE=$(printf '%s' "$HEALTH" | grep -o '"device":"[a-z]*"' | head -1 | cut -d'"' -f4)

printf '\n============================================================\n'
if [ "$AUTO_CONNECT" = "1" ]; then
  printf '  ភ្ជាប់ទៅសាយដោយស្វ័យប្រវត្តិ — បើបរាជ័យ paste ប្លុកនេះដោយដៃ\n'
else
  printf '  ចម្លងប្លុកនេះ paste ម្តងចូលកាត «ញែកភ្លេង · Demucs API»\n'
fi
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
  printf 'ស្ថានភាព : tunnel បាន URL តែមិនទាន់ឆ្លើយ — សូមរង់ចាំបន្តិច រួច reload សាយ (សញ្ញាក្បាលទំព័រនឹងប្រាប់)\n'
  tail -2 "$WORK/tunnel.log" 2>/dev/null | sed 's/^/            /' || true
fi
# --------------------------------------------------- 6. connect to the website
# The site's `PUT /api/config/separator` is what the card's save button calls:
# the same address and key, saved as if they had been pasted. The site then sees
# the combined `/health` and fills the voice card too, so nothing is typed here.
if [ "$AUTO_CONNECT" = "1" ]; then
  printf '\n==> ភ្ជាប់ទៅសាយ %s\n' "$SITE_URL"
  BODY=$(printf '{"url":"%s","apiKey":"%s"}' "$URL" "$KEY")
  # A leftover answer from an earlier run must not be printed as this one's.
  rm -f "$WORK/connect.json"
  # Render restarts after a push and a sleeping instance takes a minute to wake:
  # until then it answers 000/502/503. Retrying here is what keeps the cell from
  # telling the owner to paste by hand a URL the site would have taken anyway.
  CODE="000"
  _try=1
  while [ "$_try" -le 6 ]; do
    CODE=$(curl -sS --max-time 25 -o "$WORK/connect.json" -w '%{http_code}' \
      -X PUT "$SITE_URL/api/config/separator" \
      -H 'Content-Type: application/json' \
      --data "$BODY" 2>/dev/null) || CODE="000"
    [ "$CODE" = "200" ] && break
    if [ "$_try" -lt 6 ]; then
      printf '   សាយមិនទាន់ឆ្លើយ (HTTP %s) — សាកម្តងទៀតក្នុង ១៥ វិនាទី (%s/6)\n' "$CODE" "$_try"
      sleep 15
    fi
    _try=$((_try + 1))
  done
  if [ "$CODE" = "200" ]; then
    printf '✅ ភ្ជាប់រួច — កាត «ញែកភ្លេង» និង «ប្តូរសំឡេង» ប្រើ URL នេះហើយ។ សូម reload ទំព័រសាយ។\n'
    # Ask the site what it sees: this is the same probe the header badge shows,
    # so the terminal and the page never disagree about being connected.
    _live=$(curl -sS --max-time 20 "$SITE_URL/api/config/live" 2>/dev/null) || _live=""
    case "$_live" in
      *'"stems":true'*)
        printf '🟢 សាយឃើញ API រួច — សញ្ញានៅក្បាលទំព័រពណ៌បៃតង។\n'
        ;;
      *'"stems":false'*)
        printf '🟡 សាយមាន URL ហើយ តែសេវាមិនទាន់ឆ្លើយ — រង់ចាំបន្តិច រួច reload។\n'
        ;;
    esac
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

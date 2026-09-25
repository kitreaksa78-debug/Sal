#!/usr/bin/env sh
# បើក tunnel សាធារណៈ (Cloudflare) ទៅ Demucs API (localhost:8000) រួចបង្ហាញ URL ឲ្យត្រង់ៗ។
#
# របៀបប្រើ (ក្នុង Termux ឬ proot-distro ubuntu នៃទូរស័ព្ទ)៖
#
#     sh ./tools/demucs-termux/tunnel-cloudflared.sh
#
# វិធីនេះប្រើពេល **API កំពុងរត់រួចហើយ** ហើយចង់បានតែ URL។ បើអ្នកចង់បើកទាំង
# API ទាំង tunnel សូមប្រើ `phone-start.sh` ជំនួស (វាធ្វើច្រើនជាង ប៉ុន្តែលទ្ធផលដូចគ្នា)។
#
# វាធ្វើឲ្យអ្នក៖
#   ១. ដំឡើង cloudflared បើខ្វះ
#   ២. បើ tunnel ចាស់នៅដើរ → **រក្សា URL ដដែល** (មិនបង្កើតថ្មីឲ្យគេហទំព័រត្រូវកែ)
#   ៣. បើអត់ → បើកថ្មី, រង់ចាំ URL, រួចពិនិត្យពីខាងក្រៅថាដើរពិត
#   ៤. សរសេរ URL ទៅឯកសារ ដើម្បីមើលវាពេលក្រោយ (និងចម្លងទៅផ្ទះ Termux ផង)
#
# ចំណាំ៖ quick tunnel ទទួលបាន **URL ថ្មីរាល់ពេលបើកថ្មី**។ បើចង់បាន hostname ថេរ
# (កុំប្តូរ URL រាល់ដង) ត្រូវប្រើ named tunnel ជាមួយគណនី Cloudflare + domain។
set -u

PORT="${PORT:-8000}"
DIR="${DEMUCS_HOME:-$HOME/demucs-api}"
LOG="${TUNNEL_LOG:-$DIR/cloudflared.log}"
TERMUX_URL_FILE="${TERMUX_URL_FILE:-/data/data/com.termux/files/home/demucs-tunnel-url.txt}"
RAW="https://raw.githubusercontent.com/kitreaksa78-debug/Sal/main/tools/demucs-termux"

# ---- តើយើងនៅក្នុង proot Ubuntu ឬក្នុង Termux ដើម? ----
# នៅក្នុង proot ក៏ `uname -o` នៅតែបង្ហាញ `Android` ដូច្នេះយើងក៏មើល `TERMUX_PROOT` និង
# `PROOT_L2S_DIR` ដែលមានតែក្នុង proot។
IN_PROOT=no
[ -n "${TERMUX_PROOT:-}" ] && IN_PROOT=yes
[ -n "${PROOT_L2S_DIR:-}" ] && IN_PROOT=yes

# បើអ្នកវាយបញ្ជានេះក្នុង Termux ដើម — ចូល Ubuntu (proot) ជំនួស រួចបន្តនៅទីនោះ ----------------
# ហេតុអ្វីសំខាន់៖ Termux ដើមគ្មាន `setsid` ទេ ដូច្នេះពេលស្គ្រីបចប់ (ជាពិសេសពេលមក
# ពី `curl | sh`) Android សម្លាប់ cloudflared ទៅជាមួយ — URL ដែលទើបបង្កើតគឺស្លាប់ភ្លាម
# (`HTTP 530 error 1033` ពេលគេសាកពីខាងក្រៅ)។ ក្នុង proot Ubuntu វារត់ជា session
# ដោយខ្លួនឯង ហើយឯកសារ URL ក៏ទៅផ្ទះដដែល (/root/demucs-api) ដែលស្គ្រីបផ្សេងរកឃើញ។
if [ "$IN_PROOT" = no ] && [ "$(uname -o 2>/dev/null)" = "Android" ]; then
  PD="$(command -v proot-distro 2>/dev/null || true)"
  ROOTFS="${PREFIX:-/data/data/com.termux/files/usr}/var/lib/proot-distro/installed-rootfs/ubuntu"
  HAS_UBUNTU=no
  [ -d "$ROOTFS" ] && HAS_UBUNTU=yes
  if [ "$HAS_UBUNTU" = no ] && [ -n "$PD" ] && "$PD" list 2>/dev/null | grep -qi ubuntu; then
    HAS_UBUNTU=yes
  fi
  if [ -n "$PD" ] && [ "$HAS_UBUNTU" = yes ]; then
    echo "ទូរស័ព្ទនេះជា Termux ដើម — បើកក្នុង Ubuntu (proot) ជំនួសវិញ..."
    echo "(បើវាដួល សូមវាយដោយដៃ៖ proot-distro login ubuntu រួចវាយបញ្ជានេះម្តងទៀត)"
    echo
    exec "$PD" login ubuntu -- /bin/sh -c "export TERMUX_PROOT=1; command -v curl >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq curl; }; curl -fsSL '$RAW/tunnel-cloudflared.sh' | sh" < /dev/null
  fi
  echo "⚠️  អ្នកកំពុងរត់ក្នុង Termux ដើម ហើយរក Ubuntu មិនឃើញទេ — tunnel នឹងស្លាប់ភ្លាមពេលស្គ្រីបចប់។"
  echo "    ដំឡើង Ubuntu មុន៖  pkg install -y proot-distro ; proot-distro install ubuntu ; proot-distro login ubuntu"
  echo
fi

mkdir -p "$DIR" 2>/dev/null || true

# ---- ០. API គួរតែរត់រួចហើយ ------------------------------------------------
if curl -s --max-time 3 "http://127.0.0.1:$PORT/" 2>/dev/null | grep -q '"status"'; then
  echo "API រត់នៅ http://127.0.0.1:$PORT/ ✅"
else
  echo "⚠️  API មិនឆ្លើយតបនៅ port $PORT — tunnel នឹងចង្អុលទៅកន្លែងទទេ។"
  echo "    សូមបើកវាមុន (ក្នុង proot Ubuntu)៖  sh phone-start.sh"
fi

# ---- ១. បើ tunnel ចាស់នៅដើរ — ប្រើ URL ដដែល -------------------------------
REUSE=""
PREV=""
if [ -f "$DIR/tunnel-url.txt" ]; then
  PREV=$(head -n 1 "$DIR/tunnel-url.txt" 2>/dev/null | tr -d ' \r\n')
fi
if [ -z "$PREV" ] && [ -f "$LOG" ]; then
  PREV=$(grep -o 'https://[a-zA-Z0-9-]*\.trycloudflare\.com' "$LOG" 2>/dev/null | tail -1 || true)
fi
if [ -n "$PREV" ] && curl -s --max-time 10 "$PREV/" 2>/dev/null | grep -q '"status"'; then
  REUSE="$PREV"
fi

if [ -n "$REUSE" ]; then
  echo "Tunnel ចាស់នៅដើរទេ — ប្រើ URL ដដែល ✅"
  URL="$REUSE"
else
  # ---- ២. ដំឡើង cloudflared បើខ្វះ --------------------------------------
  if ! command -v cloudflared >/dev/null 2>&1; then
    case "$(uname -m)" in
      aarch64|arm64) A=arm64 ;;
      armv7l|armv8l) A=arm ;;
      x86_64|amd64) A=amd64 ;;
      *) A=arm64 ;;
    esac
    echo "ដំឡើង cloudflared ($A)..."
    curl -fsSL -o /usr/local/bin/cloudflared \
      "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$A" \
      || { echo "❌ ទាញ cloudflared មិនបាន (ពិនិត្យ internet)" >&2; exit 1; }
    chmod +x /usr/local/bin/cloudflared 2>/dev/null || true
    command -v cloudflared >/dev/null 2>&1 || { echo "❌ cloudflared មិនដំឡើងទេ" >&2; exit 1; }
  fi

  # ---- ៣. បើក tunnel ថ្មី -------------------------------------------------
  pkill -f "cloudflared tunnel" 2>/dev/null || true
  : > "$LOG"
  sleep 1

  # http2 (TCP) ស្ថិតស្ថេរជាង QUIC លើបណ្តាញទូរស័ព្ទ; edge-ip-version 4 ជួយពេល IPv6 ខូច។
  # `127.0.0.1` ដោយចំ (មិនមែន `localhost`) ព្រោះ API ស្តាប់តែ IPv4 — `localhost` អាចទៅ
  # IPv6 `[::1]` ជាមុន ហើយបើនៅមាន API ជំនាន់ចាស់នៅទីនោះ tunnel នឹងទៅជួបវា។
  CF="cloudflared tunnel --protocol http2 --edge-ip-version 4 --no-autoupdate --url http://127.0.0.1:$PORT"
  if command -v setsid >/dev/null 2>&1; then
    setsid $CF > "$LOG" 2>&1 < /dev/null &
  else
    nohup $CF > "$LOG" 2>&1 < /dev/null &
  fi

  echo "កំពុងរង់ចាំ URL (រហូត ៦០ វិនាទី, ចំណុច = កំពុងដំណើរការ)..."
  printf '  '
  URL=""
  i=0
  while [ "$i" -lt 60 ]; do
    URL=$(grep -o 'https://[a-zA-Z0-9-]*\.trycloudflare\.com' "$LOG" 2>/dev/null | tail -1 || true)
    [ -n "$URL" ] && break
    i=$((i + 1))
    printf '.' >&2
    sleep 1
  done
  printf '\n'

  if [ -z "$URL" ]; then
    echo "❌ រក URL មិនឃើញ។ log ចុងក្រោយ៖" >&2
    tail -20 "$LOG" >&2
    exit 1
  fi
fi

# ---- ៤. ទុក URL ទៅឯកសារ (មើលពេលក្រោយបាន) -------------------------------
printf '%s\n' "$URL" > "$DIR/tunnel-url.txt" 2>/dev/null || true
if [ -d "$(dirname "$TERMUX_URL_FILE")" ]; then
  printf '%s\n' "$URL" > "$TERMUX_URL_FILE" 2>/dev/null || true
fi

echo "URL:  $URL"
echo "កំពុងពិនិត្យថា URL នោះដើរពីខាងក្រៅពិតឬអត់ (រហូត ១ នាទី)..."
ok=0
k=0
while [ "$k" -lt 8 ]; do
  if curl -s --max-time 15 "$URL/" 2>/dev/null | grep -q '"status"'; then
    ok=1
    break
  fi
  k=$((k + 1))
  echo "  នៅមិនទាន់ឆ្លើយ — សាកម្តងទៀត ($k/8)"
  sleep 6
done

echo
if [ "$ok" = "1" ]; then
  echo "✅ ✅ ✅  TUNNEL ដំណើរការហើយ!  ចម្លង URL នេះទៅកាត «ញែកភ្លេង · Demucs API»៖"
  echo
  echo "    $URL"
  echo
  echo "មើលពេលក្រោយ៖  cat $DIR/tunnel-url.txt"
  [ -f "$TERMUX_URL_FILE" ] && echo "ពី Termux ផង៖   cat ~/demucs-tunnel-url.txt"
  echo "បិទ tunnel៖     pkill -f 'cloudflared tunnel'"
  echo "មើល log៖        tail -f $LOG"
else
  echo "⚠️  ការផ្ទៀងផ្ទាត់ពីទូរស័ព្ទបរាជ័យ (ញឹកញាប់លើ 4G — មិនមែនមានន័យថា tunnel ដើរមិនបានទេ)។"
  echo
  echo "    URL របស់ tunnel៖  $URL"
  echo
  echo "    សូមផ្ញើ URL នេះទៅអ្នកអភិវឌ្ឍ ដើម្បីឲ្យគាត់សាកល្បងពីខាងក្រៅផ្ទាល់។"
  echo "    (ឯកសារ URL បានសរសេរត្រង់៖  cat $DIR/tunnel-url.txt )"
  echo
  echo "log ចុងក្រោយរបស់ cloudflared៖"
  tail -12 "$LOG"
  exit 1
fi

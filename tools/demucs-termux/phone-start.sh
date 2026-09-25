#!/usr/bin/env sh
# បើក Demucs API + tunnel លើទូរស័ព្ទ ដោយបញ្ជាតែមួយ។
#
# របៀបប្រើ — ក្នុង Termux ឬ proot-distro ubuntu គ្រាន់តែ paste បន្ទាត់នេះ៖
#
#   curl -fsSL https://raw.githubusercontent.com/kitreaksa78-debug/Sal/main/tools/demucs-termux/phone-start.sh | sh
#
# វាធ្វើឲ្យអ្នកទាំងអស់៖
#   ១. ពិនិត្យថា API រត់រួចហើយឬអត់ — បើរត់តែជាជំនាន់ចាស់ វាបិទរួចបើកជំនាន់ថ្មី
#   ២. បើអត់រត់ — ទាញឯកសារ API, ដំឡើង Demucs បើខ្វះ (តាម install-demucs.sh), រួចបើកវា
#   ៣. ដំឡើង cloudflared បើខ្វះ
#   ៤. បើក tunnel, រង់ចាំ URL, រួច **ពិនិត្យដោយខ្លួនឯង** ថា URL នោះដើរឬអត់
#
# ប្រើ **cloudflared តែមួយប៉ុណ្ណោះ** — គ្មានវិធីបម្រុងផ្សេងទេ ដូច្នេះអ្វីដែលអ្នកឃើញនៅ
# ចុងក្រោយគឺ URL របស់ cloudflared ១០០%។
#
# ចំណាំ៖ API និង tunnel រត់នៅ background ដូច្នេះអ្នកអាចបិទអេក្រង់បាន។
# បិទទាំងពីរ៖ pkill -f demucs_api.py ; pkill -f 'cloudflared tunnel'
set -u

DIR="${DEMUCS_HOME:-$HOME/demucs-api}"
PORT="${PORT:-8000}"
RAW="https://raw.githubusercontent.com/kitreaksa78-debug/Sal/main/tools/demucs-termux"

# ផ្ទះរបស់ Termux និងផ្ទះខាងក្នុង proot Ubuntu គឺ **ខុសគ្នាទាំងស្រុង** (Termux: /data/data/…
# Ubuntu: /root)។ ដូច្នេះពេលយើងរត់ក្នុង Ubuntu យើងចម្លង URL មួយទៅផ្ទះ Termux ផង
# ដើម្បីឲ្យអ្នកអាច `cat ~/demucs-tunnel-url.txt` ពី Termux បានផ្ទាល់។
TERMUX_URL_FILE="${TERMUX_URL_FILE:-/data/data/com.termux/files/home/demucs-tunnel-url.txt}"

say() { printf '\n===== %s =====\n' "$1"; }
api_up() { curl -s --max-time 3 "http://127.0.0.1:$PORT/" 2>/dev/null | grep -q '"status"'; }
# ជំនាន់ថ្មីបន្ថែម `version`/`model`/`busy` ក្នុងចម្លើយ `/` ហើយ `/separate` ត្រឡប់ path របស់
# vocals/instrumental ដែលគេហទំព័រត្រូវការ។ ជំនាន់ចាស់គ្មានទាំងនេះ ដូច្នេះយើងស្គាល់វាបាន។
api_current() { curl -s --max-time 5 "http://127.0.0.1:$PORT/" 2>/dev/null | grep -q '"version"'; }

# ---- បើអ្នកវាយបញ្ជានេះក្នុង Termux ដើម ស្គ្រីបនឹងចូល Ubuntu (proot) ជំនួស ----
# មូលហេតុ៖ Termux ដើមដំឡើង Demucs មិនបានទេ — pip ត្រូវសង់ `pydantic-core` (ត្រូវការ
# Rust ដែលមិនស្គាល់ Android) ហើយ `torch` ក៏គ្មាន wheel សម្រាប់ Android ដែរ៖
#     Target triple not supported by rustup: aarch64-unknown-linux-android
#     ERROR: Failed to build 'pydantic-core'
# ដូច្នេះជំនួសឲ្យការបរាជ័យ វាបញ្ជូនតទៅ Ubuntu ដែលមាន glibc ពេញ។
# ---- តើយើងកំពុងនៅក្នុង proot Ubuntu ហើយ? ----
# នៅក្នុង proot ក៏ `uname -o` នៅតែបង្ហាញ `Android` ដូច្នេះមិនអាចសន្តឹងតែវាទេ។ បើយើងកុំចាប់យក
# វាទៀត វានឹងបញ្ជូនចូល Ubuntu ម្តងហើយងាយកន្លង ហើយបន្ទាប់មកបង្ហាញកំហុសមិនពាក់ព័ន្ធ
# (ដូចរូបភាពអេក្រង់ — `proot-distro` គ្រាន់តែមាននៅខាង Termux ដូច្នេះក្នុង Ubuntu រកមិនឃើញ)។
# ដូច្នេះយើងមើលសញ្ញាផ្សេងៗ ហើយក្នុងការបញ្ជូនក៏កំណត់ TERMUX_PROOT=1 ដើម្បីកុំឲ្យបរាជ័យងាយកន្លង។
IN_PROOT=no
[ -n "${TERMUX_PROOT:-}" ] && IN_PROOT=yes
[ -n "${PROOT_L2S_DIR:-}" ] && IN_PROOT=yes

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
    exec "$PD" login ubuntu -- /bin/sh -c "export TERMUX_PROOT=1; command -v curl >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq curl; }; curl -fsSL '$RAW/phone-start.sh' | sh" < /dev/null
  fi
  cat <<'MSG'

❌ អ្នកកំពុងវាយបញ្ជានេះក្នុង Termux ដើម — ដំឡើង Demucs នៅទីនេះមិនបានទេ។

   មូលហេតុ៖ pip ត្រូវសង់ `pydantic-core` (ត្រូវការ Rust ដែលមិនស្គាល់ Android)
   ហើយ `torch` ក៏គ្មាន wheel សម្រាប់ Android ដូច្នេះវាដួល៖

       Target triple not supported by rustup: aarch64-unknown-linux-android
       ERROR: Failed to build 'pydantic-core'

   ដំណោះស្រាយ (ធ្វើតែម្តង) — វាយ ៣ បន្ទាត់នេះម្តងមួយ៖

       pkg install -y proot-distro
       proot-distro install ubuntu
       proot-distro login ubuntu

   ក្រោយចូល Ubuntu រួច វាយបញ្ជាដើមនេះម្តងទៀត (curl -fsSL ... | sh)។
   បើអ្នកមាន `demucs` ក្នុង Ubuntu រួចហើយ វានឹងបើកតែ API និង tunnel ភ្លាម។

MSG
  exit 1
fi

mkdir -p "$DIR" 2>/dev/null || true
cd "$DIR" || { echo "មិនអាចចូលថត $DIR បានទេ"; exit 1; }

say "១/៤  ពិនិត្យ API"
NEED_START=no
if api_up; then
  if api_current; then
    echo "API កំពុងរត់រួចហើយ ✅"
    curl -s "http://127.0.0.1:$PORT/"; echo
  else
    # API ជំនាន់ចាស់ (គ្មាន version/model ក្នុងចម្លើយ `/`) នឹងធ្វើឲ្យគេហទំព័របរាជ័យ ព្រោះវា
    # មិនត្រឡប់ path របស់ vocals/instrumental។ ដូច្នេះយើងបិទវា រួចបើកជំនាន់ថ្មីជំនួស។
    # (tunnel មិនប៉ះពាល់ទេ ដូច្នេះ URL ដដែលនៅបន្តប្រើបាន។)
    echo "API កំពុងរត់ តែជាជំនាន់ចាស់ — កំពុងធ្វើបច្ចុប្បន្នភាព..."
    pkill -f demucs_api.py 2>/dev/null || true
    sleep 2
    NEED_START=yes
  fi
else
  echo "API មិនរត់ — កំពុងបើកវា..."
  NEED_START=yes
fi

if [ "$NEED_START" = yes ]; then

  say "២/៤  ទាញឯកសារ API"
  # ទាញទៅឯកសារបណ្ដោះអាសន្នមុន ដើម្បីកុំឲ្យការទាញដែលបរាជ័យបំផ្លាញឯកសារដែលកំពុងប្រើ។
  if ! curl -fsSL -o demucs_api.py.new "$RAW/demucs_api.py"; then
    echo "❌ ទាញឯកសារមិនបាន — ពិនិត្យ internet រួចសាកម្តងទៀត"
    exit 1
  fi
  mv demucs_api.py.new demucs_api.py
  ls -l demucs_api.py
  # ជំនួយតូច៖ បង្ហាញ និងផ្ទៀងផ្ទាត់ URL របស់ tunnel ដែលកំពុងរស់ (មិនចាំបាច់ទេ បើ​ទាញមិនបាន)
  curl -fsSL -o tunnel-url.sh "$RAW/tunnel-url.sh" 2>/dev/null || true

  # រក python ដែលមាន demucs រួចហើយ (venv របស់អ្នក)
  PY=""
  for c in "$HOME/demucs-env/bin/python" "$HOME/demucs-venv/bin/python" "$HOME/venv/bin/python" "$HOME/.venv/bin/python"; do
    if [ -x "$c" ] && "$c" -c "import demucs" >/dev/null 2>&1; then
      PY="$c"
      break
    fi
  done
  if [ -z "$PY" ] && command -v python3 >/dev/null 2>&1 && python3 -c "import demucs" >/dev/null 2>&1; then
    PY="python3"
  fi
  if [ -z "$PY" ]; then
    echo "រកមិនឃើញ python ដែលមាន demucs ទេ — ដំឡើងវាឥឡូវនេះ (ធំ ~២០០MB, ចំណាយពេល)"
    # ដំឡើងតាម install-demucs.sh (មិនមែន `pip install -r requirements.txt` ទេ)៖
    # `demucs` ទាមទារ `lameenc` ដែលគ្មាន wheel លើ Android/arm ហើយ API នេះសរសេរតែ WAV
    # ដូច្នេះស្គ្រីបនោះដំឡើង demucs ដោយឆ្លងកាត់ lameenc។
    if ! curl -fsSL -o install-demucs.sh "$RAW/install-demucs.sh"; then
      echo "❌ ទាញ install-demucs.sh មិនបាន — ពិនិត្យ internet រួចសាកម្តងទៀត"
      exit 1
    fi
    if [ -x "$HOME/demucs-env/bin/python" ]; then
      PY="$HOME/demucs-env/bin/python"
    else
      python3 -m venv "$HOME/demucs-env" && PY="$HOME/demucs-env/bin/python"
    fi
    sh install-demucs.sh "$PY" || { echo "❌ ដំឡើងមិនបាន"; exit 1; }
    "$PY" -c "import demucs" >/dev/null 2>&1 || { echo "❌ ដំឡើងរួច តែ import demucs មិនចេញ"; exit 1; }
  fi
  echo "ប្រើ python: $PY"

  say "៣/៤  បើក API នៅ port $PORT"
  # setsid ដើម្បីឲ្យ API មិនត្រូវបិទ ពេលអ្នកចុច Ctrl+C លើ terminal ។
  # `< /dev/null` សំខាន់ពេលស្គ្រីបនេះមកពី `curl | sh`៖ បើកូន process កាន់ stdin
  # (ដែលជា pipe) ទុក វាអាចទាញអក្សរស្គ្រីបដែលនៅសល់បាត់បង់។
  if command -v setsid >/dev/null 2>&1; then
    setsid "$PY" demucs_api.py > api.log 2>&1 < /dev/null &
  else
    nohup "$PY" demucs_api.py > api.log 2>&1 < /dev/null &
  fi
  i=0
  while [ "$i" -lt 25 ]; do
    api_up && break
    i=$((i + 1))
    sleep 1
  done
  if api_up; then
    echo "API ដំណើរការហើយ ✅"
    curl -s "http://127.0.0.1:$PORT/"; echo
  else
    echo "❌ API មិនឡើងទេ។ សារកំហុសចុងក្រោយ៖"
    tail -25 api.log
    exit 1
  fi
fi

say "៤/៤  បើក tunnel (Cloudflare) តែមួយប៉ុណ្ណោះ"

LOG="$DIR/cloudflared.log"

# ---- បើ tunnel ចាស់នៅដើរ និង URL របស់វានៅឆ្លើយតប — ប្រើវាបន្ត ----
# Quick tunnel ទទួលបាន URL ថ្មី **រាល់ពេលបើកឡើងវិញ** ហើយ URL ចាស់ស្លាប់ភ្លាម។ ការរក្សា URL
# ដដែលមានន័យថាគេហទំព័រមិនត្រូវកែអ្វីទេ — ដូច្នេះយើងសាកប្រើវាមុន។
REUSE=""
PREV=""
if [ -f "$DIR/tunnel-url.txt" ]; then
  PREV=$(head -n 1 "$DIR/tunnel-url.txt" 2>/dev/null | tr -d ' \r\n')
fi
# បើឯកសារនោះគ្មាន (ឧ. ប្រើស្គ្រីស្គ្រីបជំនាន់ចាស់ពីមុន) សូមអាន URL ពី log ផ្ទាល់វិញ —
# cloudflared សរសេរ URL របស់វានៅទីនោះ ដូច្នេះ URL ដែលកំពុងរស់មិនបាត់បង់ទេ។
if [ -z "$PREV" ] && [ -f "$LOG" ]; then
  PREV=$(grep -o 'https://[a-zA-Z0-9-]*\.trycloudflare\.com' "$LOG" 2>/dev/null | tail -1 || true)
fi
if [ -n "$PREV" ] && curl -s --max-time 10 "$PREV/" 2>/dev/null | grep -q '"status"'; then
  REUSE="$PREV"
fi

if [ -z "$REUSE" ]; then
  # ដំឡើង cloudflared តែពេលត្រូវបើក tunnel ថ្មីប៉ុណ្ណោះ (បើចាស់នៅដើរ វាមានរួចហើយ)។
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
      || { echo "❌ ទាញ cloudflared មិនបាន"; exit 1; }
    chmod +x /usr/local/bin/cloudflared 2>/dev/null || true
    command -v cloudflared >/dev/null 2>&1 || { echo "❌ cloudflared មិនដំឡើងទេ"; exit 1; }
  fi

  : > "$LOG"
  pkill -f "cloudflared tunnel" 2>/dev/null || true
  sleep 1

  # `127.0.0.1` ដោយចំ (មិនមែន `localhost`) ព្រោះ API ស្តាប់តែ IPv4៖ `localhost` អាចទៅ
  # IPv6 `[::1]` ជាមុន ហើយបើមាន API ជំនាន់ចាស់នៅសល់នៅទីនោះ tunnel នឹងទៅជួបវា។
  CF="cloudflared tunnel --protocol http2 --edge-ip-version 4 --no-autoupdate --url http://127.0.0.1:$PORT"
  if command -v setsid >/dev/null 2>&1; then
    setsid $CF > "$LOG" 2>&1 < /dev/null &
  else
    nohup $CF > "$LOG" 2>&1 < /dev/null &
  fi
else
  echo "Tunnel ចាស់នៅដើរទេ — ប្រើ URL ដដែល ដើម្បីកុំប្តូរវា ✅"
  echo "$REUSE"
fi

# ចំណុចខាងក្រោមមានន័យថា «កំពុងរង់ចាំពិតៗ» — មិនមែនគាំងទេ។ Cloudflare
# ត្រូវការពេលបន្តិចដើម្បីបង្កើតផ្លូវថ្មី ហើយជួនកាលលើ 4G វាយឺត។
# ស្គាល់ការរង់ចាំ៖ ចំណុច (.) ចេញរាល់វិនាទី — វាមិនមែនគាំងទេ។ ចំណុចចេញទៅ stderr
# ដើម្បីកុំលាយជាមួយ URL ដែលយើងចាប់យកបាន។
wait_url() { # $1=log  $2=pattern  $3=វិនាទី
  n=0
  found=""
  while [ "$n" -lt "$3" ]; do
    found=$(grep -o "$2" "$1" 2>/dev/null | tail -1 || true)
    if [ -n "$found" ]; then
      printf '%s' "$found"
      return 0
    fi
    n=$((n + 1))
    printf '.' >&2
    sleep 1
  done
  return 1
}

check_url() { # $1=URL — ពិនិត្យថាហៅពីខាងក្រៅបានមែន (ដូចដែលគេហទំព័រធ្វើ)
  k=0
  while [ "$k" -lt 8 ]; do
    body=$(curl -s --max-time 15 "$1/" 2>/dev/null || true)
    case "$body" in
      *'"status"'*) return 0 ;;
    esac
    k=$((k + 1))
    echo "  នៅមិនទាន់ឆ្លើយ — សាកម្តងទៀត ($k/8)"
    sleep 6
  done
  return 1
}

if [ -n "$REUSE" ]; then
  URL="$REUSE"
else
  echo "រង់ចាំ URL ពី Cloudflare (រហូត ៦០ វិនាទី, ចំណុច = កំពុងដំណើរការ)"
  printf '  '
  URL=$(wait_url "$LOG" 'https://[a-zA-Z0-9-]*\.trycloudflare\.com' 60 || true)
  printf '\n'
fi

if [ -z "$URL" ]; then
  echo "❌ Cloudflare មិនចេញ URL ក្នុង ៦០ វិនាទីទេ។ log ចុងក្រោយ៖"
  tail -8 "$LOG"
  echo
  echo "សាក៖ ប្តូរទៅ Wi-Fi ឬបិទ/បើក mobile data រួចបើកស្គ្រីបនេះម្តងទៀត"
  exit 1
fi

# ទុក URL ទៅឯកសារមួយ ដើម្បីឲ្យរកមើលវាបានយូរក្រោយមក ដោយមិនចាំបាច់ប្រើស្គ្រីប៖
#     cat "$DIR/tunnel-url.txt"
printf '%s\n' "$URL" > "$DIR/tunnel-url.txt" 2>/dev/null || true
# ចម្លងទៅផ្ទះ Termux ផង (ដើរតែពេលផ្ទះនោះមើលឃើញ — ឧ. ពេលរត់ក្នុង proot លើទូរស័ព្ទ)
if [ -d "$(dirname "$TERMUX_URL_FILE")" ]; then
  printf '%s\n' "$URL" > "$TERMUX_URL_FILE" 2>/dev/null || true
fi

echo "URL: $URL"
echo
echo "កំពុងពិនិត្យថា URL នោះដើរពិតឬអត់ (រហូត ១ នាទី)..."
ok=0
check_url "$URL" && ok=1

echo
if [ "$ok" = "1" ]; then
  printf '✅ ✅ ✅  TUNNEL ដំណើរការហើយ!  ចម្លង URL នេះទៅដាក់ក្នុងកាត «ញែកភ្លេង · Demucs API» លើគេហទំព័រ៖\n\n    %s\n\n' "$URL"
  echo "ចង់ផ្ទៀងផ្ទាត់ខ្លួនឯង៖ បើក URL នេះក្នុង Chrome គួរឃើញ {\"status\":\"ok\",...}"
else
  echo "❌ TUNNEL នៅមិនដើរទេ (URL នោះទទេពីខាងក្រៅ)។"
  echo "មូលហេតុញឹកញាប់៖ ថ្មជិតអស់ (Android កាត់ process) ឬបណ្តាញដាច់ម្តងម្កាល។"
  echo "សាកម្តងទៀត៖ pkill -f 'cloudflared tunnel' រួចបើកស្គ្រីបនេះម្តងទៀត។"
  echo
  echo "log ចុងក្រោយរបស់ cloudflared៖"
  tail -12 "$LOG"
fi

echo
echo "API និង tunnel កំពុងរត់នៅ background — អ្នកអាចបិទអេក្រង់បាន ✅"
echo "មើល URL ចុងក្រោយបំផុត៖  cat $DIR/tunnel-url.txt"
if [ -f "$TERMUX_URL_FILE" ]; then
  echo "URL ដដែល មើលពី Termux បានផង៖  cat ~/demucs-tunnel-url.txt"
fi
echo "មើល URL និងផ្ទៀងផ្ទាត់៖  sh tunnel-url.sh"
echo "មើល log ផ្ទាល់៖   tail -f $LOG"
echo "បិទ tunnel៖        pkill -f 'cloudflared tunnel'"
echo "បិទ API៖           pkill -f demucs_api.py"

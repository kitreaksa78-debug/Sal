#!/usr/bin/env sh
# បើក Demucs API + tunnel លើទូរស័ព្ទ ដោយបញ្ជាតែមួយ។
#
# របៀបប្រើ — ក្នុង Termux ឬ proot-distro ubuntu គ្រាន់តែ paste បន្ទាត់នេះ៖
#
#   curl -fsSL https://raw.githubusercontent.com/kitreaksa78-debug/Sal/main/tools/demucs-termux/phone-start.sh | sh
#
# វាធ្វើឲ្យអ្នកទាំងអស់៖
#   ១. ពិនិត្យថា API រត់រួចហើយឬអត់
#   ២. បើអត់ — ទាញឯកសារ API, ដំឡើង Demucs បើខ្វះ (តាម install-demucs.sh), រួចបើកវា
#   ៣. ដំឡើង cloudflared បើខ្វះ
#   ៤. បើក tunnel, រង់ចាំ URL, រួច **ពិនិត្យដោយខ្លួនឯង** ថា URL នោះដើរឬអត់
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

# ---- បើអ្នកវាយបញ្ជានេះក្នុង Termux ដើម ស្គ្រីបនឹងចូល Ubuntu (proot) ជំនួស ----
# មូលហេតុ៖ Termux ដើមដំឡើង Demucs មិនបានទេ — pip ត្រូវសង់ `pydantic-core` (ត្រូវការ
# Rust ដែលមិនស្គាល់ Android) ហើយ `torch` ក៏គ្មាន wheel សម្រាប់ Android ដែរ៖
#     Target triple not supported by rustup: aarch64-unknown-linux-android
#     ERROR: Failed to build 'pydantic-core'
# ដូច្នេះជំនួសឲ្យការបរាជ័យ វាបញ្ជូនតទៅ Ubuntu ដែលមាន glibc ពេញ។
if [ "$(uname -o 2>/dev/null)" = "Android" ] && [ -z "${TERMUX_PROOT:-}" ]; then
  PD="$(command -v proot-distro 2>/dev/null || true)"
  ROOTFS="${PREFIX:-/data/data/com.termux/files/usr}/var/lib/proot-distro/installed-rootfs/ubuntu"
  if [ -n "$PD" ] && [ -d "$ROOTFS" ]; then
    echo "ទូរស័ព្ទនេះជា Termux ដើម — បើកក្នុង Ubuntu (proot) ជំនួសវិញ..."
    echo "(បើវាដួល សូមវាយដោយដៃ៖ proot-distro login ubuntu រួចវាយបញ្ជានេះម្តងទៀត)"
    echo
    exec "$PD" login ubuntu -- /bin/sh -c "command -v curl >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq curl; }; curl -fsSL '$RAW/phone-start.sh' | sh" < /dev/null
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
if api_up; then
  echo "API កំពុងរត់រួចហើយ ✅"
  curl -s "http://127.0.0.1:$PORT/"; echo
else
  echo "API មិនរត់ — កំពុងបើកវា..."

  say "២/៤  ទាញឯកសារ API"
  if ! curl -fsSL -o demucs_api.py "$RAW/demucs_api.py"; then
    echo "❌ ទាញឯកសារមិនបាន — ពិនិត្យ internet រួចសាកម្តងទៀត"
    exit 1
  fi
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

say "៤/៤  បើក tunnel (ទ្វារចេញអ៊ីនធឺណិត)"
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
    || { echo "❌ ដំឡើង cloudflared មិនបាន"; exit 1; }
  chmod +x /usr/local/bin/cloudflared
fi

LOG="$DIR/cloudflared.log"
SSHLOG="$DIR/ssh-tunnel.log"
: > "$LOG"
pkill -f "cloudflared tunnel" 2>/dev/null || true
sleep 1

CF="cloudflared tunnel --protocol http2 --edge-ip-version 4 --no-autoupdate --url http://localhost:$PORT"
if command -v setsid >/dev/null 2>&1; then
  setsid $CF > "$LOG" 2>&1 < /dev/null &
else
  nohup $CF > "$LOG" 2>&1 < /dev/null &
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

# បើ cloudflared បរាជ័យ (ញឹកញាប់លើបណ្តាញទូរស័ព្ទ) យើងទាញ tunnel តាម SSH ជំនួស។
start_ssh_tunnel() {
  if ! command -v ssh >/dev/null 2>&1; then
    echo "ដំឡើង openssh-client (ចាំបាច់សម្រាប់វិធី SSH)..."
    (apt-get update -qq && apt-get install -y -qq openssh-client) >/dev/null 2>&1 || true
  fi
  command -v ssh >/dev/null 2>&1 || return 1
  : > "$SSHLOG"
  pkill -f 'nokey@localhost.run' 2>/dev/null || true
  sleep 1
  SSHCMD="ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ServerAliveInterval=30 -R 80:localhost:$PORT nokey@localhost.run"
  if command -v setsid >/dev/null 2>&1; then
    setsid $SSHCMD > "$SSHLOG" 2>&1 < /dev/null &
  else
    nohup $SSHCMD > "$SSHLOG" 2>&1 < /dev/null &
  fi
  return 0
}

echo "រង់ចាំ URL ពី Cloudflare (រហូត ៦០ វិនាទី, ចំណុច = កំពុងដំណើរការ)"
printf '  '
URL=$(wait_url "$LOG" 'https://[a-zA-Z0-9-]*\.trycloudflare\.com' 60 || true)
printf '\n'

if [ -z "$URL" ]; then
  echo "❌ Cloudflare មិនចេញ URL ក្នុង ៦០ វិនាទី។ log ចុងក្រោយ៖"
  tail -8 "$LOG"
  echo
  echo "→ សាកបើក tunnel វិធី SSH (localhost.run) ជំនួសវិញ..."
  pkill -f "cloudflared tunnel" 2>/dev/null || true
  if start_ssh_tunnel; then
    printf '  '
    URL=$(wait_url "$SSHLOG" 'https://[a-zA-Z0-9.-]*\.\(lhr\.life\|localhost\.run\)' 45 || true)
    printf '\n'
  fi
  if [ -z "$URL" ]; then
    echo "❌ ទាំងពីរវិធីមិនចេញ URL ទេ។ log ចុងក្រោយ (SSH)៖"
    tail -8 "$SSHLOG" 2>/dev/null || true
    echo "សាក៖ ប្តូរទៅ Wi-Fi ឬបិទ/បើក mobile data រួចបើកស្គ្រីបនេះម្តងទៀត"
    exit 1
  fi
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

# URL ចេញ តែមិនឆ្លើយតបពីខាងក្រៅ? សាកវិធី SSH ផង។
if [ "$ok" != "1" ]; then
  echo
  echo "→ URL នោះមិនឆ្លើយតប — សាកបើក tunnel វិធី SSH (localhost.run)..."
  pkill -f "cloudflared tunnel" 2>/dev/null || true
  if start_ssh_tunnel; then
    printf '  '
    URL_SSH=$(wait_url "$SSHLOG" 'https://[a-zA-Z0-9.-]*\.\(lhr\.life\|localhost\.run\)' 45 || true)
    printf '\n'
    if [ -n "$URL_SSH" ]; then
      URL="$URL_SSH"
      echo "URL (SSH): $URL"
      check_url "$URL" && ok=1
    fi
  fi
fi

# ទុក URL ចុងក្រោយទៅឯកសារ (សរសេរម្តងទៀត បើប្តូរទៅវិធី SSH)
if [ "$ok" = "1" ]; then
  printf '%s\n' "$URL" > "$DIR/tunnel-url.txt" 2>/dev/null || true
  if [ -d "$(dirname "$TERMUX_URL_FILE")" ]; then
    printf '%s\n' "$URL" > "$TERMUX_URL_FILE" 2>/dev/null || true
  fi
fi

echo
if [ "$ok" = "1" ]; then
  printf '✅ ✅ ✅  TUNNEL ដំណើរការហើយ!  ចម្លង URL នេះទៅដាក់ក្នុងកាត «ញែកភ្លេង · Demucs API» លើគេហទំព័រ៖\n\n    %s\n\n' "$URL"
  echo "ចង់ផ្ទៀងផ្ទាត់ខ្លួនឯង៖ បើក URL នេះក្នុង Chrome គួរឃើញ {\"status\":\"ok\",...}"
else
  echo "❌ TUNNEL នៅមិនដើរទេ (URL នោះទទេពីខាងក្រៅ)។"
  echo "មូលហេតុញឹកញាប់៖ ថ្មជិតអស់ (Android កាត់ process) ឬបណ្តាញដាច់ម្តងម្កាល។"
  echo "សាកម្តងទៀត៖ pkill -f 'cloudflared tunnel' រួចបើកស្គ្រីបនេះម្តងទៀត (ឬសាកវិធី SSH ក្នុង README)។"
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
echo "មើល log ផ្ទាល់៖   tail -f $LOG   (បើប្រើវិធី SSH៖ tail -f $SSHLOG)"
echo "បិទ tunnel៖        pkill -f 'cloudflared tunnel' ; pkill -f 'nokey@localhost.run'"
echo "បិទ API៖           pkill -f demucs_api.py"

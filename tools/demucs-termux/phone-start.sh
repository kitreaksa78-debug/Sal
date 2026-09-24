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

say() { printf '\n===== %s =====\n' "$1"; }
api_up() { curl -s --max-time 3 "http://127.0.0.1:$PORT/" 2>/dev/null | grep -q '"status"'; }

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
printf 'រង់ចាំ URL ពី Cloudflare (រហូត ៦០ វិនាទី, ចំណុច = កំពុងដំណើរការ) '
URL=""
i=0
while [ "$i" -lt 60 ]; do
  URL=$(grep -o 'https://[a-zA-Z0-9-]*\.trycloudflare\.com' "$LOG" 2>/dev/null | tail -1 || true)
  if [ -n "$URL" ]; then
    break
  fi
  i=$((i + 1))
  printf '.'
  sleep 1
done
printf '\n'

if [ -z "$URL" ]; then
  echo "❌ រក URL មិនឃើញ។ log ចុងក្រោយ៖"
  tail -20 "$LOG"
  exit 1
fi

# ទុក URL ទៅឯកសារមួយ ដើម្បីឲ្យរកមើលវាបានយូរក្រោយមក ដោយមិនចាំបាច់ប្រើស្គ្រីប៖
#     cat "$DIR/tunnel-url.txt"
printf '%s\n' "$URL" > "$DIR/tunnel-url.txt" 2>/dev/null || true

echo "URL: $URL"
echo
echo "កំពុងពិនិត្យថា URL នោះដើរពិតឬអត់ (រហូត ១ នាទី)..."
ok=0
i=0
while [ "$i" -lt 10 ]; do
  body=$(curl -s --max-time 15 "$URL/" 2>/dev/null || true)
  case "$body" in
    *'"status"'*)
      ok=1
      break
      ;;
  esac
  i=$((i + 1))
  echo "  នៅមិនទាន់ឆ្លើយ — សាកម្តងទៀត ($i/10)"
  sleep 6
done

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
echo "មើល URL និងផ្ទៀងផ្ទាត់៖  sh tunnel-url.sh"
echo "មើល log ផ្ទាល់៖   tail -f $LOG"
echo "បិទ tunnel៖        pkill -f 'cloudflared tunnel'"
echo "បិទ API៖           pkill -f demucs_api.py"

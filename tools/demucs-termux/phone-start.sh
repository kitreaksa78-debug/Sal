#!/usr/bin/env sh
# បើក Demucs API + tunnel លើទូរស័ព្ទ ដោយបញ្ជាតែមួយ។
#
# របៀបប្រើ — ក្នុង Termux ឬ proot-distro ubuntu គ្រាន់តែ paste បន្ទាត់នេះ៖
#
#   curl -fsSL https://raw.githubusercontent.com/kitreaksa78-debug/Sal/main/tools/demucs-termux/phone-start.sh | sh
#
# វាធ្វើឲ្យអ្នកទាំងអស់៖
#   ១. ពិនិត្យថា API រត់រួចហើយឬអត់
#   ២. បើអត់ — ទាញឯកសារ API, រក venv ដែលមាន demucs, រួចបើកវា
#   ៣. ដំឡើង cloudflared បើខ្វះ
#   ៤. បើក tunnel និងបង្ហាញ URL សម្រាប់ចម្លងទៅដាក់ក្នុងគេហទំព័រ
#
# ចំណាំ៖ បិទ terminal = បិទ tunnel។ API បន្តរត់នៅ background (បិទដោយ `pkill -f demucs_api.py`)។
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
    echo "រកមិនឃើញ python ដែលមាន demucs ទេ — ដំឡើងវាឥឡូវនេះ (ចំណាយពេលបន្តិច, ធំ ~២០០MB)"
    curl -fsSL -o requirements.txt "$RAW/requirements.txt" || true
    if [ -x "$HOME/demucs-env/bin/python" ]; then
      PY="$HOME/demucs-env/bin/python"
    else
      python3 -m venv "$HOME/demucs-env" && PY="$HOME/demucs-env/bin/python"
    fi
    "$PY" -m pip install --upgrade pip || true
    "$PY" -m pip install -r requirements.txt || { echo "❌ ដំឡើងមិនបាន"; exit 1; }
  fi
  echo "ប្រើ python: $PY"

  say "៣/៤  បើក API នៅ port $PORT"
  nohup "$PY" demucs_api.py > api.log 2>&1 &
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

echo "រង់ចាំប្រហែល ១០ វិនាទី ដើម្បីបង្ហាញ URL..."
echo "👉 ចម្លង URL ដែលចេញខាងក្រោម រួចដាក់ក្នុងកាត «ញែកភ្លេង · Demucs API» លើគេហទំព័រ"
echo "(កុំបិទអេក្រង់នេះ — បិទ = tunnel បិទ)"
echo
# API រត់នៅ background ហើយ៖ បន្ថែមលើនេះទៀត មានតែ tunnel ប៉ុណ្ណោះដែលត្រូវបើក។
exec cloudflared tunnel --protocol http2 --edge-ip-version 4 --no-autoupdate --url "http://localhost:$PORT"

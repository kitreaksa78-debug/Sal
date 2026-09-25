#!/usr/bin/env sh
# ធ្វើបច្ចុប្បន្នភាព និងបើកឡើងវិញ **តែ API** — មិនប៉ះ tunnel (URL ដដែលនៅប្រើបាន)។
#
# របៀបប្រើ (ក្នុង proot Ubuntu លើទូរស័ព្ទ)៖
#
#     sh restart-api.sh
#   ឬ ពីអ៊ីនធឺណិត៖
#     curl -fsSL https://raw.githubusercontent.com/kitreaksa78-debug/Sal/main/tools/demucs-termux/restart-api.sh | sh
#
# ហេតុអ្វីត្រូវការវា? បើក្នុងម៉ាស៊ីនមាន process API **ពីរកំពុងស្តាប់ក្នុងពេលដូចគ្នា** —
# ឧ. ជំនាន់ចាស់មួយនៅលើ IPv6 `[::1]:8000` និងជំនាន់ថ្មីលើ IPv4 `127.0.0.1:8000` —
# នោះ tunnel អាចទៅជួបជំនាន់ចាស់ (ចម្លើយគ្មាន `version`, `/separate` ត្រឡប់តែ
# `output_folder`) ដូច្នេះគេហទំព័របរាជ័យ ទោះការសាកល្បងក្នុងម៉ាស៊ីនជោគជ័យ។
# ស្គ្រីបនេះបិទ **ទាំងអស់** រួចបើកតែមួយ។
set -u

DIR="${DEMUCS_HOME:-$HOME/demucs-api}"
PORT="${PORT:-8000}"
# បើអ្នកកំណត់ `DEMUCS_HOST` វានឹងប្រើតែ host នោះ។ បើទទេ ស្គ្រីបសាក `::` មុន (dual-stack)
# រួចទៅ `127.0.0.1` ដើម្បីរកឲ្យឃើញ host ដែលធ្វើឲ្យ tunnel ដំណើរការភ្លាម។
HOST="${DEMUCS_HOST:-}"
RAW="https://raw.githubusercontent.com/kitreaksa78-debug/Sal/main/tools/demucs-termux"

ask() { curl -s --max-time 4 "$1/" 2>/dev/null || true; }

# ---- តើយើងនៅក្នុង proot Ubuntu ឬក្នុង Termux ដើម? ----
# API ត្រូវការ `demucs` ដែលដំឡើងបានតែក្នុង Ubuntu ប៉ុណ្ណោះ ដូច្នេះស្គ្រីបនេះចូល Ubuntu ជំនួស។
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
    echo
    exec "$PD" login ubuntu -- /bin/sh -c "export TERMUX_PROOT=1; command -v curl >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq curl; }; curl -fsSL '$RAW/restart-api.sh' | sh" < /dev/null
  fi
  cat <<'MSG'

❌ អ្នកកំពុងវាយបញ្ជានេះក្នុង Termux ដើម — API ត្រូវការ demucs ដែលដំឡើងបានតែក្នុង Ubuntu។

   សូមវាយ ៣ បន្ទាត់នេះម្តងមួយ៖

       pkg install -y proot-distro
       proot-distro install ubuntu
       proot-distro login ubuntu

   រួចវាយបញ្ជាដើមម្តងទៀត (curl -fsSL ... | sh)។

MSG
  exit 1
fi

mkdir -p "$DIR" 2>/dev/null || true
cd "$DIR" || { echo "មិនអាចចូលថត $DIR បានទេ"; exit 1; }

echo "== ១. បិទ API ចាស់ទាំងអស់ (IPv4 និង IPv6) =="
pkill -9 -f demucs_api.py 2>/dev/null || true
pkill -9 -f uvicorn 2>/dev/null || true
sleep 2

i=0
while [ "$i" -lt 10 ]; do
  if [ -z "$(ask "http://127.0.0.1:$PORT")" ] && [ -z "$(ask "http://[::1]:$PORT")" ]; then
    break
  fi
  i=$((i + 1))
  sleep 1
done
if [ -n "$(ask "http://127.0.0.1:$PORT")" ] || [ -n "$(ask "http://[::1]:$PORT")" ]; then
  echo "⚠️  នៅមានអ្វីមួយកាន់ port $PORT ទេ។ បញ្ជី process៖"
  ps aux 2>/dev/null | grep -i "demucs_api\|uvicorn" | grep -v grep || true
  echo "   (បើវានៅសល់ សាក៖ pkill -9 -f demucs_api.py រួចបើកស្គ្រីបនេះម្តងទៀត)"
fi

echo "== ២. ទាញឯកសារជំនាន់ចុងក្រោយ =="
if curl -fsSL -o demucs_api.py.new "$RAW/demucs_api.py"; then
  mv demucs_api.py.new demucs_api.py
  echo "ទាញរួច — $(wc -c < demucs_api.py) bytes"
else
  echo "⚠️  ទាញមិនបាន (ពិនិត្យ internet) — ប្រើឯកសារដែលមានស្រាប់"
fi
[ -f demucs_api.py ] || { echo "❌ គ្មាន demucs_api.py ក្នុង $DIR"; exit 1; }

echo "== ៣. រក python ដែលមាន demucs =="
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
  echo "❌ រកមិនឃើញ python ដែលមាន demucs។ ដំឡើងវាមុន៖  sh install-demucs.sh"
  exit 1
fi
echo "ប្រើ python: $PY"

echo "== ៤. បើក API ជំនាន់ថ្មី =="
# សាក `::` មុន — វាជា dual-stack ដូច្នេះ tunnel ដែលចង្អុលទៅ `localhost` ជួបវាបាន
# ទាំង IPv4 និង IPv6 (ហេតុនេះ **មិនត្រូវប្តូរ URL របស់ tunnel ទេ**)។ បើ host នោះ
# មិនចេញ (ឧ. ប្រព័ន្ធបិទ IPv4 លើ IPv6 socket) វាបន្តទៅ `127.0.0.1`។
# `< /dev/null` សំខាន់ពេលស្គ្រីបមកពី `curl | sh`។
if [ -n "$HOST" ]; then
  CANDIDATES="$HOST"
else
  CANDIDATES=":: 127.0.0.1"
fi

body=""
used_host=""
for h in $CANDIDATES; do
  echo "សាក host: $h"
  if command -v setsid >/dev/null 2>&1; then
    DEMUCS_HOST="$h" setsid "$PY" demucs_api.py > api.log 2>&1 < /dev/null &
  else
    DEMUCS_HOST="$h" nohup "$PY" demucs_api.py > api.log 2>&1 < /dev/null &
  fi
  i=0
  while [ "$i" -lt 15 ]; do
    body=$(ask "http://127.0.0.1:$PORT")
    [ -n "$body" ] && break
    i=$((i + 1))
    sleep 1
  done
  if [ -n "$body" ]; then
    used_host="$h"
    break
  fi
  echo "  host $h មិនឆ្លើយ — បិទរួចសាកវិញ"
  pkill -9 -f demucs_api.py 2>/dev/null || true
  sleep 2
done

if [ -z "$body" ]; then
  echo "❌ API មិនឡើងទេ។ សារកំហុសចុងក្រោយ៖"
  tail -25 api.log
  exit 1
fi

echo "host ដែលប្រើ: $used_host"
echo "ចម្លើយ: $body"
case "$body" in
  *'"version"'*)
    echo "✅ API ជំនាន់ថ្មីដំណើរការហើយ"
    ;;
  *)
    echo "⚠️  ចម្លើយគ្មាន version — នៅតែជំនាន់ចាស់។ log ចុងក្រោយ៖"
    tail -15 api.log
    ;;
esac

# បើ IPv6 loopback ក៏ឆ្លើយ នោះមាន process ចាស់មួយទៀតនៅសល់ — tunnel អាចទៅជួបវា។
v6=$(ask "http://[::1]:$PORT")
case "$v6" in
  ""|*'"version"'*) ;;
  *) echo "⚠️  មាន API ចាស់មួយទៀតនៅលើ IPv6៖ $v6 ; សាក pkill -9 -f demucs_api.py រួចបើកស្គ្រីបនេះម្តងទៀត" ;;
esac

echo
if [ -f "$DIR/tunnel-url.txt" ]; then
  echo "Tunnel មិនបានប៉ះទេ — URL ដដែល៖ $(head -n 1 "$DIR/tunnel-url.txt")"
else
  echo "មិនទាន់មាន tunnel — បើកវា៖  sh tunnel-cloudflared.sh"
fi
echo "សាកល្បងពេញលេញតាម URL សាធារណៈ៖"
echo "    sh test-demucs.sh \"\$(cat $DIR/tunnel-url.txt)\""

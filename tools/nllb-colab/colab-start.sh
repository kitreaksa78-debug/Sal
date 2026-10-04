#!/usr/bin/env sh
# បើក NLLB-200 Translation API នៅលើ Google Colab (GPU) + tunnel — បញ្ជាតែមួយ។
#
# ក្នុង Colab cell មួយ គ្រាន់តែ paste បន្ទាត់នេះ (runtime គួរជា GPU)៖
#
#   !curl -fsSL https://raw.githubusercontent.com/kitreaksa78-debug/Sal/main/tools/nllb-colab/colab-start.sh | sh
#
# វាធ្វើអ្វីខ្លះ៖
#   ១. ពិនិត្យ GPU (គ្មាន GPU ក៏ដើរបាន តែយឺតជាង)
#   ២. ដំឡើង transformers + fastapi/uvicorn (ធ្វើតែម្ដងក្នុងមួយ session)
#   ៣. ទាញ `nllb_api.py` ពី repo
#   ៤. បើក API នៅ port 8000 ដោយប្រើ GPU បើមាន
#   ៥. បើក cloudflared quick tunnel រួចពិនិត្យពីខាងក្រៅថាដើរពិតៗ
#   ៦. បង្ហាញ **URL + API Key** ដែលត្រូវ paste ក្នុងកាត «បកប្រែ · NLLB API» លើគេហទំព័រ
#
# កំណត់តាម env បាន (ស្រេចចិត្ត)៖
#   NLLB_API_KEY=<key ផ្ទាល់ខ្លួន>   បើទទេ = បង្កើត key ថ្មីឲ្យស្វ័យប្រវត្តិ
#   NLLB_MODEL=facebook/nllb-200-distilled-600M
#   NLLB_HOME=/content/nllb-api     កន្លែងទុកឯកសារ
#   PORT=8000                       port (tunnel បញ្ជូនមក port នេះ)
#
# ⚠️ Colab គឺជាម៉ាស៊ីនបណ្តោះអាសន្ន៖ បិទ tab ឬទុកចោល (idle) ប្រហែល ៩០ នាទី = session ដាច់
#    ហើយ URL នោះស្លាប់។ បើយ៉ាងនោះ បើក cell នេះម្ដងទៀត រួច paste URL ថ្មីក្នុងកាត។
set -u

PORT="${PORT:-8000}"
RAW="${NLLB_RAW:-https://raw.githubusercontent.com/kitreaksa78-debug/Sal/main/tools/nllb-colab}"

DIR="${NLLB_HOME:-}"
if [ -z "$DIR" ]; then
  if [ -d /content ] && [ -w /content ]; then
    DIR=/content/nllb-api
  else
    DIR="$HOME/nllb-api"
  fi
fi

say() { printf '\n===== %s =====\n' "$1"; }
api_up() { curl -s --max-time 4 "http://127.0.0.1:$PORT/" 2>/dev/null | grep -q '"status"'; }
api_ready() { curl -s --max-time 4 "http://127.0.0.1:$PORT/" 2>/dev/null | grep -q '"loaded":true'; }

mkdir -p "$DIR" || { echo "❌ បង្កើតថត $DIR មិនបានទេ"; exit 1; }
cd "$DIR" || { echo "❌ ចូលថត $DIR មិនបានទេ"; exit 1; }

say "១/៦  ពិនិត្យ GPU"
python3 - <<'PY' || echo "  (រកមិនឃើញ torch — នឹងដំឡើងនៅជំហានបន្ទាប់)"
try:
    import torch
    if torch.cuda.is_available():
        print("  GPU:", torch.cuda.get_device_name(0), "· CUDA", torch.version.cuda)
    else:
        print("  គ្មាន GPU ក្នុង runtime នេះ — API នឹងដើរលើ CPU (យឺតជាង)")
        print("  ➜ ក្នុង Colab: Runtime → Change runtime type → T4 GPU")
except Exception as err:  # noqa: BLE001
    print("  torch មិនទាន់មាន៖", err)
PY

say "២/៦  ដំឡើង transformers + fastapi/uvicorn"
# រក្សា torch/torchaudio របស់ Colab ដដែល (មាន CUDA ស្រាប់) ដើម្បីកុំឲ្យ GPU ឈប់ដំណើរការ។
pip install -q --disable-pip-version-check --no-input \
  transformers sentencepiece sacremoses accelerate || true
pip install -q --disable-pip-version-check --no-input \
  fastapi 'uvicorn[standard]' python-multipart || true

python3 -c "import transformers, torch" >/dev/null 2>&1 || {
  echo "❌ ដំឡើង transformers/torch មិនចេញទេ។ សារកំហុសចុងក្រោយ៖"
  pip install transformers 2>&1 | tail -15
  exit 1
}
python3 -c "import fastapi, uvicorn" >/dev/null 2>&1 || {
  echo "❌ ដំឡើង fastapi/uvicorn មិនចេញទេ — សាកម្ដងទៀតដោយ៖ pip install fastapi uvicorn"
  exit 1
}
echo "រួចរាល់ ✅"

say "៣/៦  ទាញឯកសារ API (nllb_api.py)"
if ! curl -fsSL -o nllb_api.py.new "$RAW/nllb_api.py"; then
  echo "❌ ទាញឯកសារមិនបាន — ពិនិត្យ internet រួចសាកម្ដងទៀត"
  exit 1
fi
mv nllb_api.py.new nllb_api.py
ls -l nllb_api.py

KEY="${NLLB_API_KEY:-}"
if [ -z "$KEY" ]; then
  KEY="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
fi
MODEL="${NLLB_MODEL:-facebook/nllb-200-distilled-600M}"

say "៤/៦  បើក API នៅ port $PORT (model: $MODEL)"
pkill -f nllb_api.py 2>/dev/null || true
sleep 1
: > api.log

NLLB_API_KEY="$KEY" NLLB_MODEL="$MODEL" NLLB_HOST=127.0.0.1 PORT="$PORT" \
  setsid python3 nllb_api.py > api.log 2>&1 < /dev/null &

i=0
while [ "$i" -lt 40 ]; do
  api_up && break
  i=$((i + 1))
  sleep 1
done

if ! api_up; then
  echo "❌ API មិនឡើងទេ។ សារកំហុសចុងក្រោយ៖"
  tail -25 api.log
  exit 1
fi

echo "រង់ចាំម៉ូឌែលផ្ទុក (ដំបូងគេយូរ ១–៣ នាទី)..."
j=0
while [ "$j" -lt 180 ]; do
  api_ready && break
  j=$((j + 1))
  sleep 2
done
if ! api_ready; then
  echo "⚠️  API រត់ហើយ តែម៉ូឌែលនៅមិនទាន់ផ្ទុករួច — មើល log ចុងក្រោយ៖"
  tail -15 api.log
fi
INFO="$(curl -s "http://127.0.0.1:$PORT/")"
echo "API ដំណើរការហើយ ✅  $INFO"

say "៥/៦  បើក tunnel (Cloudflare)"

LOG="$DIR/cloudflared.log"
CF_BIN="$(command -v cloudflared 2>/dev/null || true)"
if [ -z "$CF_BIN" ]; then
  CF_BIN="$DIR/cloudflared"
  if [ ! -x "$CF_BIN" ]; then
    case "$(uname -m)" in
      aarch64|arm64) A=arm64 ;;
      armv7l|armv8l) A=arm ;;
      *) A=amd64 ;;
    esac
    echo "ដំឡើង cloudflared ($A)..."
    curl -fsSL -o "$CF_BIN" \
      "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$A" \
      || { echo "❌ ទាញ cloudflared មិនបាន"; exit 1; }
    chmod +x "$CF_BIN" 2>/dev/null || true
  fi
fi

REUSE=""
PREV=""
if [ -f "$DIR/tunnel-url.txt" ]; then
  PREV=$(head -n 1 "$DIR/tunnel-url.txt" 2>/dev/null | tr -d ' \r\n')
fi
if [ -n "$PREV" ] && curl -s --max-time 10 "$PREV/" 2>/dev/null | grep -q '"status"'; then
  REUSE="$PREV"
fi

if [ -z "$REUSE" ]; then
  : > "$LOG"
  pkill -f "cloudflared tunnel" 2>/dev/null || true
  sleep 1
  setsid "$CF_BIN" tunnel --protocol http2 --edge-ip-version 4 --no-autoupdate \
    --url "http://127.0.0.1:$PORT" > "$LOG" 2>&1 < /dev/null &
else
  echo "Tunnel ចាស់នៅដើរទេ — ប្រើ URL ដដែល ✅"
fi

wait_url() { # $1=log $2=គំរូ $3=វិនាទី
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

if [ -n "$REUSE" ]; then
  URL="$REUSE"
else
  echo "រង់ចាំ URL ពី Cloudflare (រហូត ៩០ វិនាទី, ចំណុច = កំពុងដំណើរការ)"
  printf '  '
  URL=$(wait_url "$LOG" 'https://[a-zA-Z0-9-]*\.trycloudflare\.com' 90 || true)
  printf '\n'
fi

if [ -z "$URL" ]; then
  echo "❌ Cloudflare មិនចេញ URL ទេ។ log ចុងក្រោយ៖"
  tail -10 "$LOG"
  exit 1
fi

printf '%s\n' "$URL" > "$DIR/tunnel-url.txt" 2>/dev/null || true

say "៦/៦  ពិនិត្យថា URL ដើរពិតពីខាងក្រៅ"
ok=0
k=0
while [ "$k" -lt 8 ]; do
  body=$(curl -s --max-time 15 "$URL/" 2>/dev/null || true)
  case "$body" in
    *'"status"'*) ok=1; break ;;
  esac
  k=$((k + 1))
  echo "  នៅមិនទាន់ឆ្លើយ — សាកម្តងទៀត ($k/8)"
  sleep 6
done

echo
if [ "$ok" = "1" ]; then
  cat <<EOF

✅ ✅ ✅  NLLB លើ COLAB ដំណើរការហើយ!

  ចម្លងតម្លៃទាំង ២ នេះទៅក្នុងកាត «បកប្រែ · NLLB API» លើគេហទំព័រ
  រួចចុច «រក្សាទុក និងសាកល្បង»៖

    URL      : $URL
    API Key  : $KEY

  បើសាកល្បងជោគជ័យ វាបង្ហាញឈ្មោះ service **និង device** — ត្រូវឃើញ «cuda» (= កំពុងប្រើ GPU)។

  ⚠️ ទុក tab នេះចោលបើកចុះ។ បិទ tab ឬទុក idle ~៩០ នាទី = session ដាច់ ហើយការបកប្រែឈប់
     (ជំហានផ្សេងទៀតរបស់ការងារនៅដើរដដែល)។ ពេលនោះ៖ បើក cell នេះម្ដងទៀត រួច paste URL ថ្មី
     ក្នុងកាត (API Key ដដែល បើអ្នកកំណត់ NLLB_API_KEY ខាងលើ)។

  មើល log ផ្ទាល់៖   tail -f $DIR/api.log
  បិទ API៖           pkill -f nllb_api.py
  បិទ tunnel៖        pkill -f 'cloudflared tunnel'
EOF
else
  echo "❌ TUNNEL នៅមិនដើរទេ (URL នោះទទេពីខាងក្រៅ)។ log ចុងក្រោយ៖"
  tail -12 "$LOG"
  echo
  echo "សាកម្ដងទៀត៖ pkill -f 'cloudflared tunnel' រួចរត់ cell នេះម្តងទៀត"
  exit 1
fi

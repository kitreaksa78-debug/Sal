#!/usr/bin/env sh
# បើក Demucs API នៅលើ Google Colab (GPU) + tunnel — បញ្ជាតែមួយ។
#
# ក្នុង Colab cell មួយ គ្រាន់តែ paste បន្ទាត់នេះ (runtime គួរជា GPU)៖
#
#   !curl -fsSL https://raw.githubusercontent.com/kitreaksa78-debug/Sal/main/tools/demucs-colab/colab-start.sh | sh
#
# វាធ្វើអ្វីខ្លះ៖
#   ១. ពិនិត្យ GPU (គ្មាន GPU ក៏ដើរបាន តែយឺតដូច CPU)
#   ២. ដំឡើង demucs + fastapi/uvicorn (ធ្វើតែម្ដងក្នុងមួយ session)
#   ៣. ទាញ `demucs_api.py` ពី repo — ឯកសារដូចគ្នាបេះបិទនឹងកំណែ Termux
#   ៤. បើក API នៅ port 8001 ដោយប្រើ GPU (DEMUCS_DEVICE=auto) — port ដោយឡែកពី NLLB (8000)
#      ដើម្បីឲ្យទាំងពីរសេវារត់ជាមួយគ្នាបានក្នុង Colab តែមួយ (បើមិនដូច្នេះ សេវាទី ២ បើកលើ port
#      ដដែលមិនបាន ហើយ tunnel នឹងបញ្ជូនទៅសេវាចាស់ខុស)។
#   ៥. បើក cloudflared quick tunnel រួចពិនិត្យពីខាងក្រៅថាដើរពិតៗ
#   ៦. បង្ហាញ **URL + API key** ដែលត្រូវ paste ក្នុងកាត «ញែកភ្លេង · Demucs API» លើគេហទំព័រ
#
# កំណត់តាម env បាន (ស្រេចចិត្ត)៖
#   DEMUCS_API_KEY=<key ផ្ទាល់ខ្លួន>  បើទទេ = បង្កើត key ថ្មីឲ្យស្វ័យប្រវត្តិ
#   DEMUCS_MODEL=htdemucs            ម៉ូឌែល (htdemucs លឿន · htdemucs_ft ល្អជាង តែយឺត)
#   DEMUCS_HOME=/content/demucs-api  កន្លែងទុកឯកសារ
#   PORT=8001                        port (tunnel បញ្ជូនមក port នេះ; NLLB ប្រើ 8000)
#
# ⚠️ Colab គឺជាម៉ាស៊ីនបណ្តោះអាសន្ន៖ បិទ tab ឬទុកចោល (idle) ប្រហែល ៩០ នាទី = session ដាច់
#    ហើយ URL នោះស្លាប់។ បើយ៉ាងនោះ បើក cell នេះម្ដងទៀត រួច paste URL ថ្មីក្នុងកាត។
set -u

PORT="${PORT:-8001}"
RAW="${DEMUCS_RAW:-https://raw.githubusercontent.com/kitreaksa78-debug/Sal/main/tools/demucs-termux}"

# កន្លែងទុកឯកសារ៖ Colab មាន `/content` ដែលសរសេរបាន — បើគ្មាន ប្រើផ្ទះរបស់អ្នក។
DIR="${DEMUCS_HOME:-}"
if [ -z "$DIR" ]; then
  if [ -d /content ] && [ -w /content ]; then
    DIR=/content/demucs-api
  else
    DIR="$HOME/demucs-api"
  fi
fi

say() { printf '\n===== %s =====\n' "$1"; }
# ពិនិត្យថាអ្វីដែលនៅលើ port នេះជា Demucs ពិត — មិនមែនគ្រាន់តែ «មានអ្វីមួយឆ្លើយតប»។
# NLLB API ក៏ឆ្លើយ {"status":"ok"} ដូចគ្នា ដូច្នេះបើសាកត្រឹម status យើងអាចចាប់ tunnel ទៅ
# សេវាខុស (ឧ. NLLB ដែលកំពុងរត់) ហើយគេហទំព័រនឹងទទួល URL ខុស។
api_up() { curl -s --max-time 3 "http://127.0.0.1:$PORT/" 2>/dev/null | grep -qi 'demucs'; }
# តើមានអ្វីកំពុងស្តាប់អ្វីមួយនៅ port $1 ឬអត់ (គ្មានអ្វី = ទំនេរ)។
port_listening() { curl -s --max-time 2 "http://127.0.0.1:$1/" >/dev/null 2>&1; }

mkdir -p "$DIR" || { echo "❌ បង្កើតថត $DIR មិនបានទេ"; exit 1; }
cd "$DIR" || { echo "❌ ចូលថត $DIR មិនបានទេ"; exit 1; }

say "១/៦  ពិនិត្យ GPU"
python3 - <<'PY' || echo "  (រកមិនឃើញ torch — នឹងដំឡើងនៅជំហានបន្ទាប់)"
try:
    import torch
    if torch.cuda.is_available():
        print("  GPU:", torch.cuda.get_device_name(0), "· CUDA", torch.version.cuda)
    else:
        print("  គ្មាន GPU ក្នុង runtime នេះ — API នឹងដើរលើ CPU (យឺតជាងច្រើន)")
        print("  ➜ ក្នុង Colab: Runtime → Change runtime type → T4 GPU")
except Exception as err:  # noqa: BLE001
    print("  torch មិនទាន់មាន៖", err)
PY

say "២/៦  ដំឡើង Demucs"
need_demucs() { ! python3 -c "import demucs" >/dev/null 2>&1; }

if need_demucs; then
  echo "ចំណាយពេល ១–៣ នាទី (ធ្វើតែម្ដងក្នុងមួយ session)..."
  # វិធីទី ១ — ដំឡើងតែ `demucs` និងបណ្ណាល័យដែលវាត្រូវការ ដោយ **រក្សា torch/torchaudio
  # របស់ Colab ដដែល**។ វាជាសំណុំដែលភ្ជាប់មកជាមួយ CUDA ស្រាប់ ដូច្នេះការទាញវាថ្មី
  # គ្រាន់តែធ្វើឲ្យ GPU ឈប់ដំណើរការ (និងចំណាយពេលច្រើន)។
  pip install -q --disable-pip-version-check --no-input demucs --no-deps || true
  pip install -q --disable-pip-version-check --no-input \
    einops julius lameenc openunmix pyyaml dora-search || true
  pip install -q --disable-pip-version-check --no-input \
    fastapi 'uvicorn[standard]' python-multipart || true

  if need_demucs; then
    # វិធីទី ២ — ឲ្យ pip ដោះស្រាយតម្រូវការទាំងអស់ដោយខ្លួនឯង (អាចធ្វើឲ្យ torch ប្តូរ)។
    echo "  សាកវិធីទី ២ (pip ដោះស្រាយតម្រូវការទាំងអស់)..."
    pip install -q --disable-pip-version-check --no-input \
      demucs fastapi 'uvicorn[standard]' python-multipart || true
  fi
fi

python3 -c "import demucs" >/dev/null 2>&1 || {
  echo "❌ ដំឡើង demucs មិនចេញទេ។ សារកំហុសចុងក្រោយ៖"
  pip install demucs 2>&1 | tail -15
  exit 1
}
python3 -c "import fastapi, uvicorn" >/dev/null 2>&1 || {
  echo "❌ ដំឡើង fastapi/uvicorn មិនចេញទេ — សាកម្ដងទៀតដោយ៖ pip install fastapi uvicorn"
  exit 1
}
echo "demucs រួចរាល់ ✅"

say "៣/៦  ទាញឯកសារ API (demucs_api.py)"
if ! curl -fsSL -o demucs_api.py.new "$RAW/demucs_api.py"; then
  echo "❌ ទាញឯកសារមិនបាន — ពិនិត្យ internet រួចសាកម្ដងទៀត"
  exit 1
fi
mv demucs_api.py.new demucs_api.py
ls -l demucs_api.py

# key៖ បើអ្នកមិនបានកំណត់ DEMUCS_API_KEY យើងបង្កើតមួយឲ្យ រួចបង្ហាញវា ដើម្បី paste ក្នុងកាត។
KEY="${DEMUCS_API_KEY:-}"
if [ -z "$KEY" ]; then
  KEY="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
fi
MODEL="${DEMUCS_MODEL:-htdemucs}"

# បិទជំនាន់ចាស់ (ឧ. ពេលរត់ cell នេះម្ដងទៀត) ដើម្បីកុំឲ្យមានពីរនៅលើ port តែមួយ។
pkill -f demucs_api.py 2>/dev/null || true
sleep 1

# បើ port នេះមានសេវាផ្សេង (ឧ. NLLB) កាន់រួច សាក port បន្ទាប់ ដើម្បីកុំបើកលើសេវានោះ។
_tries=0
while [ "$_tries" -lt 12 ]; do
  if ! port_listening "$PORT" || api_up; then break; fi
  echo "  ⚠️ port $PORT មានសេវាផ្សេងកាន់រួច — សាក port $((PORT + 1))..."
  PORT=$((PORT + 1))
  _tries=$((_tries + 1))
done

say "៤/៦  បើក API នៅ port $PORT (model: $MODEL)"
# កត់ត្រា port ពិតដែលកំពុងប្រើ — notebook cell ទី ៣ និងមនុស្សអាចមើលវាបាន។
printf '%s\n' "$PORT" > "$DIR/port.txt" 2>/dev/null || true
: > api.log

# setsid ដើម្បីឲ្យ API មិនត្រូវបិទ ពេល cell ចប់។ `< /dev/null` សំខាន់ពេលស្គ្រីបមកពី `curl | sh`៖
# កូន process មិនត្រូវកាន់ stdin (ដែលជា pipe) ទេ បើមិនដូច្នេះវាទាញអក្សរស្គ្រីបខាងក្រោមបាត់។
DEMUCS_API_KEY="$KEY" DEMUCS_MODEL="$MODEL" DEMUCS_DEVICE="${DEMUCS_DEVICE:-auto}" \
  DEMUCS_DATA_DIR="$DIR/stems" DEMUCS_HOST=127.0.0.1 PORT="$PORT" \
  setsid python3 demucs_api.py > api.log 2>&1 < /dev/null &

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

# ---- បើ tunnel ចាស់ (ក្នុង session នេះ) នៅដើរ និង URL នៅឆ្លើយតប — ប្រើវាបន្ត ----
REUSE=""
PREV=""
if [ -f "$DIR/tunnel-url.txt" ]; then
  PREV=$(head -n 1 "$DIR/tunnel-url.txt" 2>/dev/null | tr -d ' \r\n')
fi
if [ -n "$PREV" ] && curl -s --max-time 10 "$PREV/" 2>/dev/null | grep -qi 'demucs'; then
  REUSE="$PREV"
fi

if [ -z "$REUSE" ]; then
  : > "$LOG"
  pkill -f "cloudflared tunnel" 2>/dev/null || true
  sleep 1
  # `127.0.0.1` ដោយចំ (មិនមែន `localhost`) ព្រោះ API ស្តាប់តែ IPv4។
  setsid "$CF_BIN" tunnel --protocol http2 --edge-ip-version 4 --no-autoupdate \
    --url "http://127.0.0.1:$PORT" > "$LOG" 2>&1 < /dev/null &
else
  echo "Tunnel ចាស់នៅដើរទេ — ប្រើ URL ដដែល ✅"
fi

wait_url() { # $1=log  $2=គំរូ  $3=វិនាទី
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
  if printf '%s' "$body" | grep -qi 'demucs'; then ok=1; break; fi
  if printf '%s' "$body" | grep -qi 'nllb'; then
    echo "❌ tunnel នេះបញ្ជូនទៅ NLLB API មិនមែន Demucs — port $PORT កំពុងត្រូវសេវាផ្សេងកាន់។"
    echo "   បិទសេវានោះមុន (pkill -f nllb_api.py) រួចរត់ cell នេះម្តងទៀត។"
    exit 1
  fi
  k=$((k + 1))
  echo "  នៅមិនទាន់ឆ្លើយ — សាកម្តងទៀត ($k/8)"
  sleep 6
done

echo
if [ "$ok" = "1" ]; then
  cat <<EOF

✅ ✅ ✅  DEMUCS លើ COLAB ដំណើរការហើយ!

  ចម្លងតម្លៃទាំង ២ នេះទៅក្នុងកាត «ញែកភ្លេង · Demucs API» លើគេហទំព័រ
  (ជំហានទី ៤ ក្នុងកាត) រួចចុច «រក្សាទុក និងសាកល្បង»៖

    URL      : $URL
    API Key  : $KEY

  បើសាកល្បងជោគជ័យ វាបង្ហាញឈ្មោះ service **និង device** — ត្រូវឃើញ «cuda» (= កំពុងប្រើ GPU)។
  បើឃើញ «cpu» នោះ runtime គ្មាន GPU៖ Runtime → Change runtime type → T4 GPU រួចរត់ cell នេះម្តងទៀត។

  ផ្ទៀងផ្ទាត់ក្នុង browser បានផង៖  $URL/   (គួរឃើញ {"status":"ok",...,"device":"cuda"})

  ⚠️ ទុក tab នេះចោលបើកចុះ។ បិទ tab ឬទុក idle ~៩០ នាទី = session ដាច់ ហើយការញែកភ្លេងឈប់
     (ការងារបកប្រែនៅតែដំណើរការ តែគ្មានការញែកភ្លេង)។ ពេលនោះ៖ បើក cell នេះម្ដងទៀត
     រួច paste URL ថ្មីក្នុងកាត (API Key ដដែល បើអ្នកកំណត់ DEMUCS_API_KEY ខាងលើ)។

  មើល log ផ្ទាល់៖   tail -f $DIR/api.log
  បិទ API៖           pkill -f demucs_api.py
  បិទ tunnel៖        pkill -f 'cloudflared tunnel'
EOF
else
  echo "❌ TUNNEL នៅមិនដើរទេ (URL នោះទទេពីខាងក្រៅ)។ log ចុងក្រោយ៖"
  tail -12 "$LOG"
  echo
  echo "សាកម្ដងទៀត៖ pkill -f 'cloudflared tunnel' រួចរត់ cell នេះម្តងទៀត"
  exit 1
fi

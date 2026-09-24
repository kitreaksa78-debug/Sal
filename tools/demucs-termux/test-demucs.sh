#!/usr/bin/env sh
# ពិនិត្យថា Demucs API ដំណើរការឬអត់ — ដោយបញ្ជាតែមួយ។
#
# របៀបប្រើ (ក្នុង Ubuntu នៃ proot លើទូរស័ព្ទ ឬលើម៉ាស៊ីនធម្មតា)៖
#
#     sh test-demucs.sh                                  # សាកម៉ាស៊ីនខ្លួនឯង (127.0.0.1:8000)
#     sh test-demucs.sh "$(cat ~/demucs-api/tunnel-url.txt)"   # សាក URL សាធារណៈ (ដូចគេហទំព័រធ្វើ)
#
# វាធ្វើ ៣ ជំហាន៖
#   ១. ហៅ `/` មើលថា API ឆ្លើយតបឬអត់
#   ២. ញែកភ្លេងពិតៗលើសំឡេងសាកល្បង ២ វិនាទី (បង្កើតដោយ python ខ្លួនឯង — គ្មានឯកសារខាងក្រៅ)
#   ៣. ទាញ stems មកវាស់ទំហំ រួចប្រាប់ថាជោគជ័យ ឬបរាជ័យ
set -u

BASE="${1:-http://127.0.0.1:8000}"

# python ធម្មតាក៏បាន — ស្គ្រីបនេះប្រើតែ stdlib (urllib, wave) មិនត្រូវការ torch ទេ
PY=""
for c in "$HOME/demucs-env/bin/python" "$HOME/demucs-venv/bin/python" python3 python; do
  if [ -x "$c" ] || command -v "$c" >/dev/null 2>&1; then
    PY="$c"
    break
  fi
done
if [ -z "$PY" ]; then
  echo "❌ រកមិនឃើញ python ទេ" >&2
  exit 1
fi

echo "ពិនិត្យ: $BASE"
echo

"$PY" - "$BASE" <<'PYEOF'
import json
import math
import os
import struct
import sys
import time
import urllib.error
import urllib.request
import uuid
import wave

base = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000").rstrip("/")
api_key = os.environ.get("DEMUCS_API_KEY", "").strip()
auth = {"Authorization": f"Bearer {api_key}"} if api_key else {}


def get(path, timeout=30):
    req = urllib.request.Request(base + path, headers=auth)
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.status, res.read()


# ---- ១. API ឆ្លើយតបឬអត់ -------------------------------------------------
try:
    _, raw = get("/", 20)
except Exception as err:
    print(f"❌ ហៅ API មិនបាន: {err}")
    print("   បើកវាមុន:  sh phone-start.sh")
    sys.exit(2)

try:
    info = json.loads(raw.decode("utf-8", "replace"))
except Exception:
    print(f"❌ ចម្លើយមិនមែន JSON: {raw[:200]!r}")
    sys.exit(2)

if not isinstance(info, dict) or "status" not in info:
    print(f"❌ URL នេះមិនមែន Demucs API ទេ: {raw[:200]!r}")
    sys.exit(2)

print(
    f"✅ ជំហាន ១/៣  API ឆ្លើយតប — "
    f"{info.get('service', '?')} v{info.get('version', '?')} · "
    f"model={info.get('model', '?')} · busy={info.get('busy')}"
)

# ---- ២. ញែកភ្លេងពិតៗលើសំឡេងសាកល្បង ---------------------------------------
rate = 22050
seconds = 2
tmp = os.path.join("/tmp", f"demucs-selftest-{uuid.uuid4().hex[:8]}.wav")
with wave.open(tmp, "wb") as handle:
    handle.setnchannels(1)
    handle.setsampwidth(2)
    handle.setframerate(rate)
    frames = b"".join(
        struct.pack("<h", int(9000 * math.sin(2 * math.pi * 440 * i / rate)))
        for i in range(rate * seconds)
    )
    handle.writeframes(frames)

with open(tmp, "rb") as handle:
    payload = handle.read()
os.unlink(tmp)

boundary = uuid.uuid4().hex
head = (
    f'--{boundary}\r\nContent-Disposition: form-data; name="audio"; '
    f'filename="selftest.wav"\r\nContent-Type: audio/wav\r\n\r\n'
).encode()
body = head + payload + f"\r\n--{boundary}--\r\n".encode()

request = urllib.request.Request(
    base + "/separate",
    data=body,
    headers={**auth, "Content-Type": f"multipart/form-data; boundary={boundary}"},
)

print(f"⏳ ជំហាន ២/៣  កំពុងញែកភ្លេងសាកល្បង (សំឡេង {seconds} វិនាទី) — លើទូរស័ព្ទអាច ១–៣ នាទី...")
started = time.time()
try:
    with urllib.request.urlopen(request, timeout=1800) as res:
        answer = json.loads(res.read().decode("utf-8", "replace"))
except urllib.error.HTTPError as err:
    print(f"❌ ញែកភ្លេងបរាជ័យ (HTTP {err.code}): {err.read().decode('utf-8', 'replace')[:300]}")
    print("   បើ 401 — ដាក់ key ដូច DEMUCS_API_KEY ពេលហៅស្គ្រីបនេះ")
    sys.exit(3)
except Exception as err:
    print(f"❌ ញែកភ្លេងបរាជ័យ: {err}")
    sys.exit(3)
elapsed = time.time() - started

if answer.get("status") != "done":
    print(f"❌ ចម្លើយមិនធម្មតា: {str(answer)[:300]}")
    sys.exit(3)

print(f"✅ ជំហាន ២/៣  ញែកភ្លេងជោគជ័យក្នុង {elapsed:.0f} វិនាទី · model={answer.get('model', '?')}")

# ---- ៣. ទាញ stems មកវាស់ទំហំ -------------------------------------------
print("⏳ ជំហាន ៣/៣  កំពុងទាញ stems មកវាស់ទំហំ...")
sizes = {}
for name in ("vocals", "instrumental"):
    path = answer.get(name)
    if not path:
        sizes[name] = None
        continue
    try:
        _, blob = get(path, 120)
        sizes[name] = len(blob)
    except Exception as err:
        sizes[name] = f"ហៅមិនបាន: {err}"

if all(isinstance(v, int) and v > 1000 for v in sizes.values()):
    print(
        f"✅ ជំហាន ៣/៣  stems ពេញលេញ — "
        f"vocals {sizes['vocals'] / 1024:.0f} KB · instrumental {sizes['instrumental'] / 1024:.0f} KB"
    )
    print()
    print("✅ ✅ ✅  Demucs ដំណើរការល្អ — ត្រៀមបកប្រែវីដេអូបានហើយ")
    sys.exit(0)

print(f"⚠️  ញែកភ្លេងចេញ តែទាញ stems មិនពេញលេញ: {sizes}")
sys.exit(4)
PYEOF

STATUS=$?
echo
case "$STATUS" in
  0) echo "សរុប៖ ជោគជ័យ — អ្នកអាចយក URL នេះទៅដាក់ក្នុងកាត «ញែកភ្លេង · Demucs API»" ;;
  2) echo "សរុប៖ API មិនឆ្លើយតប — បើកវាមុន (sh phone-start.sh)" ;;
  3) echo "សរុប៖ API ឆ្លើយ តែញែកភ្លេងបរាជ័យ — មើលសារកំហុសខាងលើ" ;;
  *) echo "សរុប៖ មានបញ្ហា (លេខកូដ $STATUS) — មើលសារខាងលើ" ;;
esac

if [ -z "${1:-}" ] && [ -f "${DEMUCS_HOME:-$HOME/demucs-api}/tunnel-url.txt" ]; then
  echo
  echo "ចង់សាក URL សាធារណៈផង (ជាអ្វីដែលគេហទំព័រប្រើ)៖"
  echo "    sh test-demucs.sh \"\$(cat ${DEMUCS_HOME:-$HOME/demucs-api}/tunnel-url.txt)\""
fi

# បញ្ជូនលេខកូដត្រឹមត្រូវតាមលទ្ធផល (ស្គ្រីបផ្សេងអាចពិនិត្យវាបាន)
exit "$STATUS"

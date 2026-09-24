#!/usr/bin/env sh
# Demucs API លើម៉ាស៊ីននេះ — បើកនៅ http://127.0.0.1:8000
#
# នៅទីនេះ គេហទំព័រ (backend នៃ workspace) រត់លើម៉ាស៊ីនតែមួយ ដូច្នេះវាហៅ
# `http://127.0.0.1:8000` បានផ្ទាល់ — **មិនត្រូវការ tunnel ទេ**។
#
# របៀបប្រើ (ក្នុង Terminal នៃ workspace នេះ)៖
#
#     sh ./tools/demucs-termux/run-local.sh
#
# បន្ទាប់មកកំណត់ URL ក្នុងកាត «ញែកភ្លេង · Demucs API» ជា http://127.0.0.1:8000។
# ត្រូវទុក terminal នេះបើកចោល — បិទ = ការញែកភ្លេងនឹងឈប់ (គ្មានការជំនួសទេ)។
#
# បើកលើទូរស័ព្ទវិញ សូមប្រើ README.md (Termux + tunnel) ជំនួសឯកសារនេះ។
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
HOST=${DEMUCS_HOST:-127.0.0.1}
PORT=${PORT:-8000}

# ប្រើ venv ដែលមាន demucs រួចហើយ បើមិនមាន បង្កើតថ្មី។ ការដំឡើងវាទាញ torch
# (~200 MB) ដូច្នេះវាចំណាយពេលច្រើននាទីតែម្តងគត់។
PY=""
for candidate in "$ROOT/.venv-demucs/bin/python" "$ROOT/tmp-demucs-verify/venv/bin/python"; do
  if [ -x "$candidate" ]; then
    PY=$candidate
    break
  fi
done

if [ -z "$PY" ]; then
  echo "==> Creating .venv-demucs (downloads torch — several minutes, once)"
  python3 -m venv "$ROOT/.venv-demucs"
  PY="$ROOT/.venv-demucs/bin/python"
fi

# requirements.txt only lists the API server libraries. Demucs is installed by
# install-demucs.sh because its `lameenc` dependency has no build on Android/arm.
if ! "$PY" -c "import demucs, fastapi, uvicorn, multipart" >/dev/null 2>&1; then
  echo "==> Installing Demucs + the API dependencies into $PY"
  sh "$HERE/install-demucs.sh" "$PY"
fi

echo "==> Demucs API on http://$HOST:$PORT  (Ctrl+C to stop)"
echo "    data dir: ${DEMUCS_DATA_DIR:-$HOME/demucs-api/stems}"

export DEMUCS_HOST="$HOST"
export PORT="$PORT"
exec "$PY" "$HERE/demucs_api.py"

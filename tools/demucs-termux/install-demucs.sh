#!/usr/bin/env sh
# ដំឡើង Demucs + បណ្ណាល័យរបស់ Demucs API សម្រាប់ទូរស័ព្ទ (Termux) ឬម៉ាស៊ីនធម្មតា។
#
# របៀបប្រើ៖
#     sh install-demucs.sh                              # ប្រើ python3 ក្នុង PATH
#     sh install-demucs.sh ~/demucs-env/bin/python      # ឬ python របស់ venv ជាក់លាក់
#
# ហេតុអ្វីត្រូវការស្គ្រីបនេះ ជំនួស `pip install -r requirements.txt`?
#
# `demucs` ប្រកាសតម្រូវការ `lameenc` ដែលជាកូដ C++ សម្រាប់សរសេរ MP3 តែប៉ុណ្ណោះ។
# លើ Android (aarch64) វាគ្មាន wheel ឲ្យដំឡើង ដូច្នេះ pip ដួលទាំងស្រុង ទោះបី API
# នេះសរសេរតែ WAV ក៏ដោយ៖
#
#     ERROR: Cannot install -r requirements.txt because these package versions
#     have conflicting dependencies ... demucs depends on lameenc>=1.2
#     ... no matching distributions available for your environment: lameenc
#
# ដូច្នេះ៖ សាកល្បងតាមធម្មតាមុន (លើ x86 វាដំណើរការល្អ)។ បើដួល — ដំឡើង `demucs`
# ដោយ `--no-deps` រួចដំឡើងបណ្ណាល័យដែលវាត្រូវការពិតៗម្តងមួយៗ ដោយឆ្លងកាត់ lameenc។
# demucs import lameenc តែពេលបញ្ជា `--mp3` ប៉ុណ្ណោះ (នៅក្នុងអនុគមន៍ encode_mp3)
# ដូច្នេះការខ្វះវាមិនប៉ះពាល់ដល់ការបញ្ចេញ WAV ទេ។
set -eu

PY="${1:-python3}"

step() { printf '\n==> %s\n' "$1"; }

if ! "$PY" -c 'import sys' >/dev/null 2>&1; then
  echo "❌ រកមិនឃើញ python ដែលប្រើបានទេ: $PY" >&2
  exit 1
fi

step "ដំឡើងបណ្ណាល័យរបស់ API (fastapi, uvicorn)"
"$PY" -m pip install --upgrade pip >/dev/null 2>&1 || true
"$PY" -m pip install --disable-pip-version-check \
  "fastapi>=0.115" "uvicorn>=0.30" "python-multipart>=0.0.9"

if "$PY" -c "import demucs" >/dev/null 2>&1; then
  step "Demucs មានរួចហើយ ✅"
  exit 0
fi

step "ដំឡើង Demucs (ធំ — ទាញ torch ប្រហែល ២០០MB ឡើងទៅ)"
if "$PY" -m pip install --disable-pip-version-check "demucs>=4.0"; then
  step "Demucs រួចរាល់ ✅"
  exit 0
fi

step "ការដំឡើងធម្មតាដួល — សាកម្តងទៀត ដោយឆ្លងកាត់ lameenc (ត្រូវការតែសម្រាប់ MP3)"
"$PY" -m pip install --disable-pip-version-check --no-deps "demucs>=4.0"

if "$PY" -m pip install --disable-pip-version-check \
  dora-search einops "julius>=0.2.3" openunmix pyyaml torch torchaudio tqdm numpy \
  && "$PY" -c "import demucs" >/dev/null 2>&1; then
  step "Demucs រួចរាល់ ✅ (ដោយគ្មាន lameenc — មិនចាំបាច់ទេ)"
  exit 0
fi

cat >&2 <<'MSG'

❌ ដំឡើង Demucs មិនបានទេ។

   សាកម្តងទៀត៖ ពិនិត្យ internet រួចបើកស្គ្រីបនេះម្តងទៀត។

   បើនៅតែដួល មូលហេតុញឹកញាប់គឺ torch ដែលម៉ូឌែល Demucs ត្រូវការ
   មិនអាចដំឡើងលើ Android ដោយផ្ទាល់បាន។ ជម្រើសដែលដំណើរការជាក់លាក់៖

   ១. ប្រើ `proot-distro ubuntu` លើទូរស័ព្ទ (មាន glibc ពេញ) រួចបើកស្គ្រីបនេះ
      ក្នុង proot — មើល README.md ជំហាន ២ ជម្រើស B។
   ២. ឬបើក Demucs លើកុំព្យូទ័រ/VPS វិញ៖ sh tools/demucs-termux/run-local.sh

   មិនចាំបាច់បារម្ភទេ — ផ្នែកផ្សេងទៀតនៃគេហទំព័រមិនខូចទេ តែការញែកភ្លេង
   ត្រូវការ Demucs ដូច្នេះវានឹងឈប់នៅជំហាននោះ។

MSG
exit 1

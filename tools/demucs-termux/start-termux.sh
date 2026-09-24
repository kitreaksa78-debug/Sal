#!/usr/bin/env sh
# បើក Demucs API + tunnel លើទូរស័ព្ទ — បញ្ជូនតទៅ phone-start.sh។
#
# ហេតុអ្វីគ្រាន់តែជាស្គ្រីបខ្លី? ព្រោះ Termux ដើមដំឡើង Demucs មិនបានទេ៖
# pip ត្រូវសង់ `pydantic-core` ដែលត្រូវការ Rust (ដែលមិនស្គាល់ target របស់ Android)
# ហើយ `torch` ក៏គ្មាន wheel សម្រាប់ Android ដែរ៖
#
#     Target triple not supported by rustup: aarch64-unknown-linux-android
#     ERROR: Failed to build 'pydantic-core' when installing build dependencies
#
# ដូច្នេះផ្លូវត្រូវគឺ៖ ប្រើ Ubuntu ក្នុង `proot-distro` (មាន glibc ពេញ)។ `phone-start.sh`
# ធ្វើការនោះឲ្យដោយស្វ័យប្រវត្តិ៖ វាឃើញថាជា Termux ដើម រួចចូល Ubuntu ឯង។
#
# របៀបប្រើ៖
#     sh tools/demucs-termux/start-termux.sh
#
# ឬលើគ្រប់ប្រព័ន្ធ (គ្មានត្រូវ clone repo)៖
#     curl -fsSL https://raw.githubusercontent.com/kitreaksa78-debug/Sal/main/tools/demucs-termux/phone-start.sh | sh
set -u

DIR=$(cd "$(dirname "$0")" 2>/dev/null && pwd || echo ".")

if [ -f "$DIR/phone-start.sh" ]; then
  exec sh "$DIR/phone-start.sh"
fi

# មិនមានឯកសារក្នុងថត (ឧ. មកពី curl ផ្ទាល់) — ទាញវាមករត់
RAW="https://raw.githubusercontent.com/kitreaksa78-debug/Sal/main/tools/demucs-termux"
echo "ទាញ phone-start.sh..."
curl -fsSL "$RAW/phone-start.sh" -o /tmp/phone-start.sh || {
  echo "❌ ទាញមិនបាន — ពិនិត្យ internet រួចសាកម្តងទៀត" >&2
  exit 1
}
exec sh /tmp/phone-start.sh

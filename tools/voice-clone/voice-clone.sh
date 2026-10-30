#!/bin/sh
# -------------------------------------------------------------- voice cloning
# Give the Khmer dub the original singer's voice.
#
# The translation keeps the words; this step keeps the timbre. It is zero-shot
# voice conversion (Seed-VC): the Khmer speech is the content, a slice of the
# original vocal is the voice, and the output is those Khmer words in that
# voice. Nothing is trained, no account is needed.
#
#   REF     original vocal stem                (studio: សំឡេង)
#   SPEECH  the Khmer words with no music      (studio: សំឡេងខ្មែរ ឥតភ្លេង)
#   MUSIC   optional instrumental to mix back  (studio: ភ្លេង)
#   MODE    space (default, hosted GPU) | local (install Seed-VC here)
#   OUT     where to write the result (default $WORK/cloned.mp3)
#
# One line in Colab or Kaggle:
#   !curl -fsSL <raw-url> | REF=<url> SPEECH=<url> MUSIC=<url> sh
#
# It is not the same person at 100%: the timbre is copied, while the accent and
# the rhythm come from the Khmer voice that spoke the words.

set -eu

say() { printf '\033[36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31mx\033[0m %s\n' "$*" >&2; exit 1; }

REF="${REF:-}"
SPEECH="${SPEECH:-}"
MUSIC="${MUSIC:-}"
MODE="${MODE:-space}"
CHUNK="${CHUNK:-20}"

[ -n "$REF" ] && [ -n "$SPEECH" ] ||
  die "ត្រូវការ REF=<សំឡេងដើម> និង SPEECH=<សំឡេងខ្មែរឥតភ្លេង>"

if [ -d /content ] && [ -w /content ]; then
  WORK="${WORK:-/content/voice-clone}"
elif [ -d /kaggle/working ] && [ -w /kaggle/working ]; then
  WORK="${WORK:-/kaggle/working/voice-clone}"
else
  WORK="${WORK:-$PWD/voice-clone}"
fi
mkdir -p "$WORK"
OUT="${OUT:-$WORK/cloned.mp3}"

command -v ffmpeg >/dev/null 2>&1 || die "រកមិនឃើញ ffmpeg"
command -v ffprobe >/dev/null 2>&1 || die "រកមិនឃើញ ffprobe"

fetch() { # $1 = url or path, $2 = destination
  case "$1" in
    http://* | https://*) curl -fsSL "$1" -o "$2" || die "ទាញយកបរាជ័យ: $1" ;;
    *) cp "$1" "$2" || die "រកឯកសារមិនឃើញ: $1" ;;
  esac
}

say "ទាញឯកសារចូល $WORK"
fetch "$REF" "$WORK/ref.src"
fetch "$SPEECH" "$WORK/speech.src"

# Seed-VC wants a short, clean, 16 kHz reference. A whole song carries music
# bleed and key changes that drag the timbre around, so a middle slice is used.
REF_DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$WORK/ref.src" 2>/dev/null || echo 0)
START=$(awk -v d="${REF_DUR:-0}" 'BEGIN { s = d / 2 - 6; if (s < 0) s = 0; printf "%.2f", s }')
say "កាត់ reference ១២ វិនាទី ចាប់ពី ${START}s"
ffmpeg -y -v error -ss "$START" -t 12 -i "$WORK/ref.src" -ac 1 -ar 16000 "$WORK/ref.wav" ||
  die "កាត់ reference បរាជ័យ"
ffmpeg -y -v error -i "$WORK/speech.src" -ac 1 -ar 16000 "$WORK/speech.wav" ||
  die "បម្លែងសំឡេងខ្មែរបរាជ័យ"

rm -rf "$WORK/chunks" "$WORK/conv"
mkdir -p "$WORK/chunks" "$WORK/conv"
ffmpeg -y -v error -i "$WORK/speech.wav" -f segment -segment_time "$CHUNK" \
  -c:a pcm_s16le "$WORK/chunks/part_%03d.wav" || die "បែងចែកសំឡេងបរាជ័យ"
PARTS=$(ls "$WORK/chunks"/part_*.wav 2>/dev/null | wc -l | tr -d ' ')
[ "$PARTS" -gt 0 ] || die "គ្មានផ្នែកសំឡេងត្រូវបម្លែង"
say "បម្លែង $PARTS ផ្នែក (mode=$MODE)"

if [ "$MODE" = "local" ]; then
  if [ ! -f "$WORK/seed-vc/inference.py" ]; then
    say "តំឡើង Seed-VC (លើកដំបូង ~៥–១០ នាទី, ត្រូវ GPU)"
    git clone --depth 1 https://github.com/Plachtaa/seed-vc "$WORK/seed-vc" ||
      die "clone Seed-VC បរាជ័យ"
    (cd "$WORK/seed-vc" && python3 -m pip install -q -e .) ||
      die "pip install Seed-VC បរាជ័យ"
  fi
  convert_one() {
    (cd "$WORK/seed-vc" && python3 inference.py \
      --source "$1" --target "$WORK/ref.wav" --output "$WORK/conv" \
      --diffusion-steps 30 --length-adjust 1.0 --inference-cfg-rate 0.7 \
      --f0-condition False --auto-f0-adjust False --fp16 True) >/dev/null 2>&1 ||
      return 1
    NEW=$(ls -t "$WORK/conv"/*.wav 2>/dev/null | head -1)
    [ -n "$NEW" ] || return 1
    mv "$NEW" "$2"
  }
else
  python3 -c "import gradio_client" 2>/dev/null ||
    python3 -m pip install -q gradio_client || die "តំឡើង gradio_client បរាជ័យ"
  convert_one() {
    python3 - "$1" "$WORK/ref.wav" "$2" <<'PY'
import shutil
import sys

from gradio_client import Client, handle_file

src, ref, dst = sys.argv[1], sys.argv[2], sys.argv[3]
client = Client("Plachta/Seed-VC")
result = client.predict(
    source_audio_path=handle_file(src),
    target_audio_path=handle_file(ref),
    diffusion_steps=30,
    length_adjust=1.0,
    inference_cfg_rate=0.7,
    f0_condition=False,
    auto_f0_adjust=False,
    pitch_shift=0,
    api_name="/predict_1",
)
path = result[0] if isinstance(result, (list, tuple)) else result
if isinstance(path, dict):
    path = path.get("path") or path.get("name") or path.get("url")
if not path:
    raise SystemExit("the converter returned nothing")
shutil.copy(path, dst)
PY
  }
fi

DONE=0
for part in "$WORK"/chunks/part_*.wav; do
  name=$(basename "$part" .wav)
  target="$WORK/conv/$name.wav"
  if convert_one "$part" "$target"; then
    DONE=$((DONE + 1))
    say "រួច $DONE/$PARTS — $name"
  else
    say "ផ្នែក $name បម្លែងបរាជ័យ — ប្រើសំឡេខ្មែរដើមជំនួស"
    ffmpeg -y -v error -i "$part" "$target" || die "ចម្លងផ្នែកបរាជ័យ"
    DONE=$((DONE + 1))
  fi
done

LIST="$WORK/conv/list.txt"
: >"$LIST"
for f in "$WORK"/conv/part_*.wav; do printf "file '%s'\n" "$f" >>"$LIST"; done
ffmpeg -y -v error -f concat -safe 0 -i "$LIST" -ac 2 -ar 44100 "$WORK/voice.wav" ||
  die "បញ្ចូលផ្នែកបរាជ័យ"

if [ -n "$MUSIC" ]; then
  fetch "$MUSIC" "$WORK/music.src"
  say "លាយសំឡេងដែល clone រួច ជាមួយភ្លេង"
  ffmpeg -y -v error -i "$WORK/voice.wav" -i "$WORK/music.src" \
    -filter_complex "[0:a]volume=1.25[v];[1:a]volume=0.55[m];[v][m]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11[out]" \
    -map "[out]" -codec:a libmp3lame -q:a 2 "$OUT" || die "លាយបរាជ័យ"
else
  ffmpeg -y -v error -i "$WORK/voice.wav" \
    -af "loudnorm=I=-16:TP=-1.5:LRA=11" -codec:a libmp3lame -q:a 2 "$OUT" ||
    die "សរសេរឯកសារបរាជ័យ"
fi

say "រួចរាល់: $OUT ($(du -h "$OUT" | cut -f1))"
say "ទាញយកពីផ្ទាំង Files ខាងឆ្វេង។ ចំណាំ៖ timbre ដូចដើម, តែ accent/ចង្វាក់ជារបស់ TTS ។"

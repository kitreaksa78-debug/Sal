#!/bin/sh
# colab-start.sh — ប្តូរសំឡេងច្រៀង ទៅជាសំឡេងអ្នកច្រៀងដើម ដោយបន្ទាត់តែមួយ។
#
# វាជា Amphion DiffWaveNetSVC — model ដដែលដែល lucataco/singing_voice_conversion
# ហៅលើ Replicate, តែរត់ក្នុង Colab ផ្ទាល់: ឥត key ឥតគិតលុយតាមដង។
#
# ក្នុង cell របស់ Google Colab (Runtime → Change runtime type → T4 GPU)៖
#
#   !curl -fsSL https://raw.githubusercontent.com/kitreaksa78-debug/Sal/main/tools/voice-clone/colab-start.sh | sh
#
# វារកឯកសារសំឡេងក្នុង /content ដោយស្វ័យប្រវត្តិ។ បើមានច្រើន ឬចង់កំណត់ខ្លួនឯង៖
#
#   !curl -fsSL …/colab-start.sh | AUDIO=/content/khmer.wav SINGER="Taylor Swift" sh
#   !curl -fsSL …/colab-start.sh | sh -s -- /content/khmer.wav "Faye Wong 王菲"
#
# អ្នកច្រៀងដែលគាំទ្រ (១៥ នាក់)៖ Adele · Beyonce · Bruno Mars · John Mayer ·
# Michael Jackson · Taylor Swift · David Tao 陶喆 · Eason Chan 陈奕迅 · Feng Wang 汪峰 ·
# Jian Li 李健 · Ying Na 那英 · Yijie Shi 石倚洁 · Jacky Cheung 张学友 · Faye Wong 王菲 · Tsai Chin 蔡琴
#
# អថេរស្រេចចិត្ត៖
#   AUDIO=/path/file.wav    ឯកសារសំឡេង (គួរជា vocal ឥតភ្លេង)
#   SINGER="Taylor Swift"   អ្នកច្រៀងគោលដៅ
#   PITCH="Auto Shift"      ឬ "Key Shift"
#   KEY_SHIFT=0             ពេល PITCH="Key Shift" (−6 … +6 សេមីតូន)
#   STEPS=200               គុណភាព (ខ្ពស់=យឺត) 50–1000
#   OUT=/content/out.mp3    កន្លែងរក្សាលទ្ធផល
#   SKIP_INSTALL=1          រំលង pip ពេលដំឡើងរួច
#   CHECK_ONLY=1            ពិនិត្យតែប៉ុណ្ណោះ មិនតំឡើង មិនបម្លែង
#
# ស្គ្រីបពិនិត្យអ្វីៗជាមុន (ឯកសារ, ឈ្មោះអ្នកច្រៀង) ដើម្បីកុំឲ្យចំណាយ ៦ នាទី
# តំឡើង library រួចទើបដឹងថាវាយឈ្មោះខុស។

set -u

WORK_DEFAULT="/content"
if [ ! -d "$WORK_DEFAULT" ] || [ ! -w "$WORK_DEFAULT" ]; then
  WORK_DEFAULT="$PWD/svc-colab"
fi
WORK="${WORK:-$WORK_DEFAULT}"
mkdir -p "$WORK" || exit 1

AUDIO="${AUDIO:-${1:-}}"
SINGER="${SINGER:-${2:-Taylor Swift}}"
PITCH="${PITCH:-Auto Shift}"
KEY_SHIFT="${KEY_SHIFT:-0}"
STEPS="${STEPS:-200}"
OUT="${OUT:-}"

say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
die() {
  printf '\n!! %s\n' "$*" >&2
  exit 1
}

# ---------------------------------------------------------------- 1. the machine
step "1/5 ពិនិត្យម៉ាស៊ីន"
command -v python3 >/dev/null 2>&1 || die "python3 រកមិនឃើញ — សូមប្រើ Google Colab។"
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi -L 2>/dev/null | head -1 || true
else
  say "⚠️  គ្មាន GPU — វានឹងដើរលើ CPU យឺតខ្លាំង (~៣០ ដង)។"
  say "    ក្នុង Colab: Runtime → Change runtime type → T4 GPU ។"
fi
if ! command -v ffmpeg >/dev/null 2>&1; then
  say "តំឡើង ffmpeg ..."
  (apt-get -qq update && apt-get -qq install -y ffmpeg) >/dev/null 2>&1 || true
fi

# ------------------------------------------------------------------ 2. the audio
step "2/5 រកឯកសារសំឡេង"
if [ -n "$AUDIO" ]; then
  [ -f "$AUDIO" ] || die "រកឯកសារមិនឃើញ: $AUDIO"
else
  FOUND=$(find "$WORK" -maxdepth 2 -type f \
    \( -name '*.wav' -o -name '*.mp3' -o -name '*.flac' -o -name '*.m4a' -o -name '*.ogg' \) \
    -not -path "$WORK/Amphion/*" -not -path "$WORK/svc-input/*" \
    -printf '%T@\t%p\n' 2>/dev/null | sort -rn | head -5 | cut -f2-)
  if [ -z "$FOUND" ]; then
    FOUND=$(find "$WORK" -maxdepth 2 -type f \
      \( -name '*.wav' -o -name '*.mp3' -o -name '*.flac' -o -name '*.m4a' -o -name '*.ogg' \) \
      -not -path "$WORK/Amphion/*" -not -path "$WORK/svc-input/*" 2>/dev/null | head -5)
  fi
  [ -n "$FOUND" ] || die "គ្មានឯកសារសំឡេងក្នុង $WORK។
    សូម upload សំឡេងច្រៀង (ឥតភ្លេង) ចូល Colab រួចរត់បន្ទាត់នេះម្តងទៀត។
    ឬកំណត់ផ្ទាល់:  !curl -fsSL …/colab-start.sh | AUDIO=/content/song.wav sh"
  COUNT=$(printf '%s\n' "$FOUND" | grep -c . || true)
  AUDIO=$(printf '%s\n' "$FOUND" | sed -n '1p')
  if [ "${COUNT:-0}" -gt 1 ]; then
    say "ឃើញ $COUNT ឯកសារ — ប្រើថ្មីបំផុត។ បើចង់ជ្រើសផ្សេង៖"
    printf '%s\n' "$FOUND" | sed 's/^/    /'
    say "    → AUDIO=/content/សំឡេងរបស់អ្នក.wav"
  fi
fi
say "ប្រើ: $AUDIO ($(wc -c <"$AUDIO" 2>/dev/null | tr -d ' ') bytes)"

# ------------------------------------------- 3. write the worker + check the input
step "3/5 ពិនិត្យឈ្មោះអ្នកច្រៀង"
cat >"$WORK/svc_run.py" <<'PYEOF'
"""រត់ការប្តូរសំឡេង Amphion DiffWaveNetSVC ក្នុង Colab។"""
import glob
import os
import shutil
import subprocess
import sys

WORK = os.environ.get("SV_WORK") or "/content"
ROOT = os.path.join(WORK, "Amphion")
AUDIO = os.environ.get("SV_AUDIO") or ""
SINGER = (os.environ.get("SV_SINGER") or "Taylor Swift").strip()
PITCH = os.environ.get("SV_PITCH") or "Auto Shift"
KEY_SHIFT = os.environ.get("SV_KEY_SHIFT") or "0"
STEPS = os.environ.get("SV_STEPS") or "200"
OUT = os.environ.get("SV_OUT") or ""

SINGERS = {
    "Adele": "vocalist_l1_Adele",
    "Beyonce": "vocalist_l1_Beyonce",
    "Bruno Mars": "vocalist_l1_BrunoMars",
    "John Mayer": "vocalist_l1_JohnMayer",
    "Michael Jackson": "vocalist_l1_MichaelJackson",
    "Taylor Swift": "vocalist_l1_TaylorSwift",
    "David Tao 陶喆": "vocalist_l1_陶喆",
    "Eason Chan 陈奕迅": "vocalist_l1_陈奕迅",
    "Feng Wang 汪峰": "vocalist_l1_汪峰",
    "Jian Li 李健": "vocalist_l1_李健",
    "Ying Na 那英": "vocalist_l1_那英",
    "Yijie Shi 石倚洁": "vocalist_l1_石倚洁",
    "Jacky Cheung 张学友": "vocalist_l1_张学友",
    "Faye Wong 王菲": "vocalist_l1_王菲",
    "Tsai Chin 蔡琴": "vocalist_l1_蔡琴",
}

REQUIRED = ["ckpts/svc", "pretrained/bigvgan", "pretrained/contentvec", "pretrained/whisper"]


def say(message):
    print(message, flush=True)


def die(message):
    print("\n!! " + message, file=sys.stderr, flush=True)
    raise SystemExit(2)


def human(size):
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return "%.1f %s" % (size, unit)
        size /= 1024.0


def resolve_singer(raw):
    if raw in SINGERS:
        return SINGERS[raw]
    low = raw.lower()
    for name, singer_id in SINGERS.items():
        if name.lower() == low or singer_id.lower() == low:
            return singer_id
    hits = [sid for name, sid in SINGERS.items() if low in name.lower() or low in sid.lower()]
    if len(hits) == 1:
        return hits[0]
    die("ឈ្មោះអ្នកច្រៀង «%s» មិនស្គាល់។\n   មាន: %s" % (raw, " · ".join(SINGERS)))


def check_audio():
    if not AUDIO:
        die("គ្មានឯកសារសំឡេង (AUDIO ទទេ)")
    if not os.path.isfile(AUDIO):
        die("រកឯកសារមិនឃើញ: " + AUDIO)
    if os.path.getsize(AUDIO) == 0:
        die("ឯកសារសំឡេងទទេ: " + AUDIO)


def ensure_weights():
    ready = all(os.path.isdir(os.path.join(ROOT, part)) for part in REQUIRED)
    if ready and os.path.exists(os.path.join(ROOT, "inference.py")):
        say("model មានរួចហើយ — រំលងការទាញយក")
        return
    say("ទាញយក model ពី Hugging Face (~៥ GB, លើកដំបូងតែម្តង) ...")
    os.environ.setdefault("HF_HUB_ENABLE_HF_TRANSFER", "1")
    try:
        from huggingface_hub import snapshot_download
    except ImportError:
        die("huggingface_hub គ្មាន — សូមរត់ស្គ្រីបម្តងទៀត (វាដំឡើងឲ្យ)")
    snapshot_download(
        repo_id="amphion/singing_voice_conversion",
        repo_type="space",
        local_dir=ROOT,
        allow_patterns=[
            "*.py", "*.json", "*.yaml", "*.yml", "*.txt",
            "ckpts/**", "pretrained/**", "models/**", "processors/**",
            "modules/**", "utils/**", "text/**", "egs/**", "config/**",
            "optimizer/**", "preprocessors/**",
        ],
        ignore_patterns=["*.md", "*.gitattributes"],
    )
    missing = [p for p in REQUIRED if not os.path.isdir(os.path.join(ROOT, p))]
    if missing:
        die("weights ខ្វះ: " + ", ".join(missing) + " — សូមរត់ម្តងទៀត")


def prepare_input():
    """Converters expect 44.1 kHz mono, and it converts every file in a folder."""
    in_dir = os.path.join(WORK, "svc-input")
    shutil.rmtree(in_dir, ignore_errors=True)
    os.makedirs(in_dir, exist_ok=True)
    name = os.path.splitext(os.path.basename(AUDIO))[0]
    name = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in name) or "input"
    target = os.path.join(in_dir, name + ".wav")
    say("រៀបចំសំឡេង → %s" % target)
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", AUDIO, "-ac", "1", "-ar", "44100", target],
        check=True,
    )
    return in_dir, name


def run_inference(in_dir, singer_id):
    sys.path.insert(0, ROOT)
    os.chdir(ROOT)
    os.environ["WORK_DIR"] = "./"
    import inference  # noqa: E402  (imported after chdir: it reads args.json paths)

    result_dir = os.path.join(ROOT, "result")
    shutil.rmtree(result_dir, ignore_errors=True)
    say("បម្លែងទៅ %s (steps=%s, pitch=%s) ..." % (singer_id, STEPS, PITCH))
    inference.main([
        "--config", "ckpts/svc/vocalist_l1_contentvec+whisper/args.json",
        "--acoustics_dir", "ckpts/svc/vocalist_l1_contentvec+whisper",
        "--vocoder_dir", "pretrained/bigvgan",
        "--target_singer", singer_id,
        "--trans_key", "autoshift" if PITCH.lower().startswith("auto") else str(KEY_SHIFT),
        "--diffusion_inference_steps", str(STEPS),
        "--source", in_dir,
        "--output_dir", "result",
        "--log_level", "warning",
    ])


def to_mp3(singer_id, name):
    expected = os.path.join(ROOT, "result", name, "%s_%s.wav" % (name, singer_id))
    if os.path.isfile(expected):
        wav = expected
    else:
        found = sorted(glob.glob(os.path.join(ROOT, "result", "**", "*.wav"), recursive=True))
        if not found:
            die("បម្លែងរួច តែរកឯកសារលទ្ធផលមិនឃើញក្នុង result/")
        wav = found[-1]

    out = OUT or os.path.join(WORK, "%s_%s.mp3" % (name, singer_id))
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", wav, "-codec:a", "libmp3lame", "-q:a", "2", out],
        check=True,
    )
    print("SV_RESULT: " + out, flush=True)
    say("បញ្ចប់ · %s · %s" % (os.path.basename(out), human(os.path.getsize(out))))
    print("SV_DONE", flush=True)


def main():
    singer_id = resolve_singer(SINGER)
    check_audio()

    if "--validate" in sys.argv[1:]:
        say("✅ សំឡេង: %s (%s)" % (os.path.basename(AUDIO), human(os.path.getsize(AUDIO))))
        say("✅ អ្នកច្រៀងគោលដៅ: %s" % singer_id)
        say("✅ ffmpeg: %s" % (shutil.which("ffmpeg") or "រកមិនឃើញ"))
        return 0

    ensure_weights()
    in_dir, name = prepare_input()
    run_inference(in_dir, singer_id)
    to_mp3(singer_id, name)
    return 0


if __name__ == "__main__":
    sys.exit(main())
PYEOF

SV_WORK="$WORK" SV_AUDIO="$AUDIO" SV_SINGER="$SINGER" SV_PITCH="$PITCH" \
  SV_KEY_SHIFT="$KEY_SHIFT" SV_STEPS="$STEPS" SV_OUT="$OUT" \
  python3 "$WORK/svc_run.py" --validate || die "ពិនិត្យមិនជាប់ — មើលសារខាងលើ។"

if [ "${CHECK_ONLY:-0}" = "1" ]; then
  say "ពិនិត្យរួច (CHECK_ONLY=1) — ឈប់ត្រង់នេះ។"
  exit 0
fi

# ------------------------------------------------------------------ 4. packages
step "4/5 តំឡើង library (លើកដំបូង ~៦ នាទី)"
if [ "${SKIP_INSTALL:-0}" = "1" ]; then
  say "រំលង (SKIP_INSTALL=1)"
elif python3 -c 'import torch, librosa, einops, omegaconf, fairseq, encodec, transformers, diffusers; assert transformers.__version__.startswith("4.30")' >/dev/null 2>&1; then
  say "មានរួចហើយ — រំលងការតំឡើង"
else
  python3 -m pip install -q --upgrade pip >/dev/null 2>&1 || true
  python3 -m pip install -q "setuptools<70" ruamel.yaml tqdm colorama easydict \
    tabulate loguru json5 Cython unidecode inflect librosa typeguard einops omegaconf \
    hydra-core humanfriendly praat-parselmouth pedalboard ffmpeg-python pyworld diffsptk \
    nnAudio torchmetrics pymcd encodec "transformers==4.30.2" "diffusers==0.19.3" \
    accelerate "huggingface_hub[hf_transfer]" ||
    die "pip install បរាជ័យ — សូមរត់បន្ទាត់នេះម្តងទៀត (របស់ដែលរួចហើយមិនដំឡើងទេ)។"
  # ContentVec ត្រូវការ fairseq; build របស់ដើមអាចខូចលើ Python ថ្មី
  python3 -m pip install -q fairseq ||
    python3 -m pip install -q "git+https://github.com/One-sixth/fairseq.git" ||
    die "fairseq តំឡើងមិនបាន — សាកប្តូរ runtime ទៅ Python 3.10"
  say "តំឡើងរួចរាល់"
fi

# ------------------------------------------------------------------ 5. the work
step "5/5 ប្តូរសំឡេង"
LOG="$WORK/svc-run.log"
SV_WORK="$WORK" SV_AUDIO="$AUDIO" SV_SINGER="$SINGER" SV_PITCH="$PITCH" \
  SV_KEY_SHIFT="$KEY_SHIFT" SV_STEPS="$STEPS" SV_OUT="$OUT" \
  python3 "$WORK/svc_run.py" 2>&1 | tee "$LOG"

if ! grep -q '^SV_DONE' "$LOG" 2>/dev/null; then
  say ""
  say "៣០ បន្ទាត់ចុងក្រោយ៖"
  tail -30 "$LOG" 2>/dev/null || true
  die "ប្តូរសំឡេងមិនបាន (log: $LOG)"
fi

RESULT=$(grep -m1 '^SV_RESULT: ' "$LOG" | sed 's/^SV_RESULT: //')

printf '\n============================================================\n'
printf '  សំឡេងដូចដើម — រួចរាល់\n'
printf '============================================================\n'
printf 'ឯកសារ : %s\n' "$RESULT"
printf 'អ្នកច្រៀង : %s\n' "$SINGER"
printf '============================================================\n'
say "• ទាញយក: ចុចស្តាំលើឯកសារក្នុង folder ឆ្វេង → Download (ឬ copy ចូល Drive)។"
say "• សំឡេងនេះជាសំឡេងសុទ្ធ — លាយជាមួយភ្លេងវិញលើ site ដើម្បីបានបទពេញ។"
say "• រត់ម្តងទៀតក្នុង session ដដែល = ឥតទាញ weights ម្តងទៀត (ប្តូរ SINGER / STEPS បានសេរី)។"
say "• log: $LOG"

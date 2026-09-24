#!/usr/bin/env sh
# បង្ហាញ URL របស់ tunnel ដែលកំពុងរត់ឥឡូវនេះ រួចពិនិត្យថាវាដើរពីខាងក្រៅពិតឬអត់។
#
# របៀបប្រើ (ក្នុង terminal ដដែលដែលអ្នកបើក phone-start.sh)៖
#
#     sh tunnel-url.sh
#
# ហេតុអ្វីត្រូវការវា? Quick tunnel ទទួលបាន **URL ថ្មីរាល់ពេលបើក** ហើយ URL ចាស់
# បាត់ពី DNS ទាំងស្រុង។ បើកាត «ញែកភ្លេង · Demucs API» នៅចាំ URL ចាស់ គេហទំព័រ
# នឹងរាយការណ៍ថា `fetch failed` (រកអាសយដ្ឋានមិនឃើញ)។ ស្គ្រីបនេះប្រាប់ URL ដែលរស់ពិត។
set -u

PORT="${PORT:-8000}"
LOG="${TUNNEL_LOG:-${DEMUCS_HOME:-$HOME/demucs-api}/cloudflared.log}"

echo "== API ក្នុងទូរស័ព្ទ =="
if curl -s --max-time 4 "http://127.0.0.1:$PORT/" | grep -q '"status"'; then
  echo "✅ រត់នៅ http://127.0.0.1:$PORT/"
else
  echo "❌ មិនរត់ទេ — បើកវាមុន៖  sh phone-start.sh"
fi

echo
echo "== Tunnel =="
if [ ! -f "$LOG" ]; then
  echo "❌ រកមិនឃើញ log: $LOG"
  echo "   បើអ្នកបើក tunnel ដោយវិធីផ្សេង សូមកំណត់ទីតាំង log ដោយ TUNNEL_LOG=/path/to/log"
  exit 1
fi

URL=$(grep -o 'https://[a-zA-Z0-9-]*\.trycloudflare\.com' "$LOG" 2>/dev/null | tail -1 || true)
if [ -z "$URL" ]; then
  echo "❌ log មិនទាន់មាន URL ទេ — tunnel មិនទាន់ឡើងរួច។ log ចុងក្រោយ៖"
  tail -10 "$LOG"
  exit 1
fi

echo "URL: $URL"

# ផ្ទះរបស់ Termux និងផ្ទះក្នុង proot Ubuntu ខុសគ្នា — ចម្លងទៅផ្ទះ Termux ផង ដើម្បីងាយមើល
T="${TERMUX_URL_FILE:-/data/data/com.termux/files/home/demucs-tunnel-url.txt}"
if [ -d "$(dirname "$T")" ]; then
  printf '%s\n' "$URL" > "$T" 2>/dev/null || true
  echo "(បានចម្លងទៅផង — មើលពី Termux បាន៖ cat ~/demucs-tunnel-url.txt)"
fi

echo "កំពុងពិនិត្យពីខាងក្រៅ (ដូចដែលគេហទំព័រធ្វើ)..."
body=$(curl -s --max-time 20 "$URL/" 2>/dev/null || true)

case "$body" in
  *'"status"'*)
    echo "✅ ដើរពិត — paste URL នេះក្នុងកាត «ញែកភ្លេង · Demucs API» លើគេហទំព័រ"
    echo "   បើកាតនៅចាំ URL ចាស់ ត្រូវលុបចេញ រួចដាក់ URL នេះជំនួស រួចចុច «រក្សាទុក» → «សាកល្បង»"
    ;;
  *)
    echo "❌ URL នេះមិនឆ្លើយតបពីខាងក្រៅទេ — tunnel បានបិទ ឬបណ្តាញដាច់។"
    echo "   បើកវាឡើងវិញ៖"
    echo "       pkill -f 'cloudflared tunnel'"
    echo "       sh phone-start.sh"
    echo "   log ចុងក្រោយរបស់ cloudflared៖"
    tail -10 "$LOG"
    ;;
esac

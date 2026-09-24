#!/usr/bin/env sh
# បើក tunnel សាធារណៈទៅ Demucs API (localhost:8000) រួចបង្ហាញ URL ឲ្យត្រង់ៗ។
#
# របៀបប្រើ (k្នុង Termux ឬ proot-distro ubuntu នៃទូរស័ព្ទ)៖
#
#     sh ./tools/demucs-termux/tunnel-cloudflared.sh
#
# វាបើក cloudflared ជា background, រង់ចាំ URL, រួចបោះពុម្ពវាចេញ — ដូច្នេះអ្នក
# មិនត្រូវអាន log យូរៗដើម្បីរក `https://…trycloudflare.com` ទៀតទេ។
#
# ចំណាំ៖ quick tunnel ទទួលបាន **URL ថ្មីរាល់ពេលបើក**។ បើចង់បាន hostname ថេរ
# (កុំប្តូរ URL រាល់ដង) ត្រូវប្រើ named tunnel ជាមួយគណនី Cloudflare + domain។
set -eu

PORT=${PORT:-8000}
LOG=${TUNNEL_LOG:-$HOME/cloudflared-demucs.log}

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "រកមិនឃើញ cloudflared — សូមដំឡើងមុន (មើល README.md ជំហាន ២)" >&2
  exit 1
fi

# បើកថ្មី៖ បិទវាចាស់ និងសម្អាត log
pkill -f "cloudflared tunnel" 2>/dev/null || true
: > "$LOG"

# http2 (TCP) ស្ថិតស្ថេរជាង QUIC លើបណ្តាញទូរស័ព្ទ; edge-ip-version 4 ជួយពេល IPv6 ខូច។
cloudflared tunnel --protocol http2 --edge-ip-version 4 --no-autoupdate \
  --url "http://localhost:$PORT" > "$LOG" 2>&1 &

echo "កំពុងរង់ចាំ URL (រហូត ៤០ វិនាទី)..."
url=""
i=0
while [ "$i" -lt 40 ]; do
  url=$(grep -o 'https://[a-zA-Z0-9-]*\.trycloudflare\.com' "$LOG" 2>/dev/null | tail -1 || true)
  if [ -n "$url" ]; then
    break
  fi
  i=$((i + 1))
  sleep 1
done

if [ -z "$url" ]; then
  echo "រក URL មិនឃើញ។ ពិនិត្យ log៖" >&2
  tail -20 "$LOG" >&2
  exit 1
fi

echo
echo "URL:  $url"
echo "សាកល្បងពីទូរស័ព្ទ:  curl -s $url/"
echo "មើល log:  tail -f $LOG"
echo "បិទ tunnel:  pkill -f 'cloudflared tunnel'"

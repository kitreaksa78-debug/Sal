#!/bin/sh
# colab-game.sh — play a free, open-source game from a Google Colab notebook.
#
# In a Colab cell (Runtime → Change runtime type → T4 GPU):
#
#   !curl -fsSL https://raw.githubusercontent.com/kitreaksa78-debug/Sal/main/tools/colab-game/colab-game.sh | sh
#
# What it does: installs the dependencies and the game, starts a virtual screen
# (Xvfb) with a window manager, exposes it to the browser through noVNC, streams
# the game's sound as MP3, opens Cloudflare tunnels so both are reachable from
# your phone, and prints the single link to click.
#
# Every game below is free and open source — none of them is a commercial title:
#
#   GAME=stk        SuperTuxKart (racing, apt / GitHub tarball)
#   GAME=0ad        0 A.D. (real-time strategy, apt)
#   GAME=openra     OpenRA (Command & Conquer engine, GitHub AppImage)
#   GAME=xonotic    Xonotic (arena shooter, xonotic.org)
#
# Optional environment:
#   GAME=stk            which game (default stk)
#   WIDTH / HEIGHT      virtual screen size (default 1280x720)
#   PORT                port noVNC listens on (default 6080)
#   AUDIO_PORT          port the MP3 stream listens on (default 6081)
#   GL=hw               try the machine's GPU instead of CPU rendering
#   STOP=1              stop everything this script started and exit
#   SKIP_INSTALL=1      do not run apt (the packages are already there)
#
# Everything is POSIX sh and reads nothing from stdin, because the script itself
# arrives on stdin through the pipe. Its children get /dev/null as stdin.

set -u

GAME="${GAME:-stk}"
WIDTH="${WIDTH:-1280}"
HEIGHT="${HEIGHT:-720}"
PORT="${PORT:-6080}"
AUDIO_PORT="${AUDIO_PORT:-6081}"
DISPLAY_NUM=":1"

# /content is Colab's session disk; elsewhere keep the files beside the caller.
if [ -d /content ] && [ -w /content ]; then
  WORK="${WORK:-/content/colab-game}"
else
  WORK="${WORK:-$PWD/colab-game}"
fi
mkdir -p "$WORK" "$WORK/web" "$WORK/runtime" || exit 1
chmod 700 "$WORK/runtime" 2>/dev/null || true

# PulseAudio and every client that talks to it must agree on this before either
# starts, so it is set here rather than just before the game launches.
export XDG_RUNTIME_DIR="$WORK/runtime"

say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
die() {
  printf '\n!! %s\n' "$*" >&2
  exit 1
}

# Root in Colab, an ordinary user elsewhere: one of the two works.
as_root() {
  if [ "$(id -u)" = "0" ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    "$@"
  fi
}

# Only what this script started. The patterns name this script's own ports and
# its own sink, so nothing else on the machine is touched.
kill_all() {
  pkill -f "ffmpeg.*colabgame.monitor" >/dev/null 2>&1 || true
  pkill -f "cloudflared tunnel --url http://localhost:$PORT" >/dev/null 2>&1 || true
  pkill -f "cloudflared tunnel --url http://localhost:$AUDIO_PORT" >/dev/null 2>&1 || true
  pkill -f "websockify --web=.*$WORK/web" >/dev/null 2>&1 || true
  pkill -f "x11vnc -display $DISPLAY_NUM" >/dev/null 2>&1 || true
  pkill -f "Xvfb $DISPLAY_NUM " >/dev/null 2>&1 || true
}

if [ "${STOP:-0}" = "1" ]; then
  kill_all
  say "បានបញ្ឈប់ហ្គេម និង tunnel ទាំងអស់។"
  exit 0
fi

say "==> ហ្គេម: $GAME · អេក្រង់ ${WIDTH}x${HEIGHT}"

# A previous run of this same script must be gone before new ports are bound.
kill_all
sleep 1

# ---------------------------------------------------------------- 1. packages
step "1/6 តំឡើងបណ្ណាល័យ (លើកដំបូង ~១–២ នាទី)"
if [ "${SKIP_INSTALL:-0}" = "1" ]; then
  say "រំលងការតំឡើង (SKIP_INSTALL=1)"
else
  export DEBIAN_FRONTEND=noninteractive
  as_root apt-get -qq update >/dev/null 2>&1 || true
  # x11vnc + noVNC + websockify = the screen in the browser; pulseaudio + ffmpeg
  # = the sound in the browser.
  as_root apt-get -qq install -y --no-install-recommends \
    xvfb x11vnc novnc websockify openbox pulseaudio ffmpeg curl unzip \
    ca-certificates x11-utils xfonts-base >/dev/null 2>&1 ||
    die "apt install បរាជ័យ។ សូមរត់បន្ទាត់នេះម្តងទៀត។"
  say "បណ្ណាល័យរួចរាល់"
fi

for cmd in Xvfb x11vnc websockify ffmpeg; do
  command -v "$cmd" >/dev/null 2>&1 || die "រកមិនឃើញ $cmd — សូមរត់ជំហានដំឡើងម្តងទៀត។"
done

NOVNC_WEB=""
for candidate in /usr/share/novnc /usr/share/webapps/novnc "$WORK/novnc"; do
  if [ -f "$candidate/vnc.html" ]; then
    NOVNC_WEB="$candidate"
    break
  fi
done

# Some images ship the VNC tools but not the browser files; noVNC is a plain
# static bundle, so fetching it is all that is needed.
if [ -z "$NOVNC_WEB" ]; then
  say "apt គ្មាន noVNC — ទាញយកផ្ទាល់ ..."
  TGZ="$WORK/novnc.tar.gz"
  if curl -fL --retry 3 -o "$TGZ" \
    "https://github.com/novnc/noVNC/archive/refs/tags/v1.5.0.tar.gz"; then
    rm -rf "$WORK/novnc"
    mkdir -p "$WORK/novnc"
    tar -xzf "$TGZ" -C "$WORK/novnc" --strip-components=1 || true
    rm -f "$TGZ"
    [ -f "$WORK/novnc/vnc.html" ] && NOVNC_WEB="$WORK/novnc"
  fi
fi
[ -n "$NOVNC_WEB" ] || die "រកមិនឃើញ noVNC (vnc.html) ក្នុងម៉ាស៊ីននេះទេ។"

# -------------------------------------------------------------- 2. the game
step "2/6 ទាញយក/តំឡើងហ្គេម ($GAME)"

# /usr/games is not always on PATH, and the apt builds of STK and 0 A.D. live there.
found_bin() {
  command -v "$1" >/dev/null 2>&1 && {
    command -v "$1"
    return 0
  }
  [ -x "/usr/games/$1" ] && {
    printf '/usr/games/%s' "$1"
    return 0
  }
  return 1
}

install_game() {
  case "$GAME" in
    stk)
      if found_bin supertuxkart >/dev/null 2>&1; then
        say "SuperTuxKart មានរួចហើយ"
        return 0
      fi
      if as_root apt-get -qq install -y --no-install-recommends supertuxkart >/dev/null 2>&1 &&
        found_bin supertuxkart >/dev/null 2>&1; then
        say "SuperTuxKart តំឡើងរួច"
        return 0
      fi
      # No apt package on this image: the official 1.5 build bundles its own libs.
      say "apt មិនមាន — ទាញ SuperTuxKart 1.5 ពី GitHub ..."
      TGZ="$WORK/stk.tar.gz"
      curl -fL --retry 3 -o "$TGZ" \
        "https://github.com/supertuxkart/stk-code/releases/download/1.5/SuperTuxKart-1.5-linux-x86_64.tar.gz" ||
        die "ទាញ SuperTuxKart បរាជ័យ"
      rm -rf "$WORK/stk"
      mkdir -p "$WORK/stk"
      tar -xzf "$TGZ" -C "$WORK/stk" --strip-components=1 || die "ពន្លា SuperTuxKart បរាជ័យ"
      rm -f "$TGZ"
      ;;
    0ad)
      if found_bin 0ad >/dev/null 2>&1; then
        say "0 A.D. មានរួចហើយ"
        return 0
      fi
      say "0 A.D. ធំ (~១ GB) — សូមរង់ចាំ ..."
      as_root apt-get -qq install -y --no-install-recommends 0ad >/dev/null 2>&1 ||
        die "តំឡើង 0 A.D. បរាជ័យ"
      ;;
    openra)
      APP="$WORK/OpenRA.AppImage"
      if [ ! -x "$APP" ]; then
        say "ទាញ OpenRA (Red Alert) ..."
        curl -fL --retry 3 -o "$APP" \
          "https://github.com/OpenRA/OpenRA/releases/download/release-20250330/OpenRA-Red-Alert-x86_64.AppImage" ||
          die "ទាញ OpenRA បរាជ័យ"
        chmod +x "$APP"
        as_root apt-get -qq install -y --no-install-recommends \
          libsdl2-2.0-0 libopenal1 libfreetype6 >/dev/null 2>&1 || true
      fi
      ;;
    xonotic)
      DIR="$WORK/xonotic"
      if [ ! -x "$DIR/Xonotic/xonotic-linux64-sdl" ]; then
        say "ទាញ Xonotic (~១ GB) ..."
        ZIP="$WORK/xonotic.zip"
        curl -fL --retry 3 -o "$ZIP" "https://dl.xonotic.org/xonotic-0.8.6.zip" ||
          die "ទាញ Xonotic បរាជ័យ"
        rm -rf "$DIR"
        mkdir -p "$DIR"
        unzip -q "$ZIP" -d "$DIR" || die "ពន្លា Xonotic បរាជ័យ"
        rm -f "$ZIP"
        as_root apt-get -qq install -y --no-install-recommends \
          libsdl2-2.0-0 libopenal1 libcurl4 libfreetype6 libpng16-16 >/dev/null 2>&1 || true
      fi
      ;;
    *)
      die "GAME=$GAME មិនស្គាល់ទេ។ សូមប្រើ stk, 0ad, openra ឬ xonotic។"
      ;;
  esac
}
install_game

game_binary() {
  case "$GAME" in
    stk)
      found_bin supertuxkart 2>/dev/null && return 0
      find "$WORK/stk" -type f -name supertuxkart -perm -u+x 2>/dev/null | head -1
      ;;
    0ad) found_bin 0ad 2>/dev/null || true ;;
    openra) printf '%s' "$WORK/OpenRA.AppImage" ;;
    xonotic) printf '%s' "$WORK/xonotic/Xonotic/xonotic-linux64-sdl" ;;
  esac
}

BIN=$(game_binary)
[ -n "$BIN" ] || die "រកមិនឃើញឯកសារហ្គេម — សូមរត់ម្តងទៀត។"

# ---------------------------------------------------------------- 3. the sound
step "3/6 បើកសំឡេង (PulseAudio → MP3 ទៅ browser)"
SOUND_OK=0
if command -v pulseaudio >/dev/null 2>&1; then
  pulseaudio --start --exit-idle-time=-1 >/dev/null 2>&1 ||
    pulseaudio -D --exit-idle-time=-1 >/dev/null 2>&1 ||
    pulseaudio -D --system --exit-idle-time=-1 >/dev/null 2>&1 || true
  sleep 1
  if command -v pactl >/dev/null 2>&1 && pactl info >/dev/null 2>&1; then
    pactl load-module module-null-sink sink_name=colabgame \
      sink_properties=device.description=colabgame rate=44100 channels=2 >/dev/null 2>&1 || true
    pactl set-default-sink colabgame >/dev/null 2>&1 || true
    pactl set-sink-mute colabgame 0 >/dev/null 2>&1 || true
    pactl set-sink-volume colabgame 80% >/dev/null 2>&1 || true
    SOUND_OK=1
  fi
fi

if [ "$SOUND_OK" = "1" ]; then
  # The game plays into `colabgame`; this reads that sink's monitor and serves it
  # as a plain MP3 stream the browser plays in an <audio> element. ffmpeg exits
  # when a listener leaves, so it is restarted in a loop.
  (
    while :; do
      ffmpeg -hide_banner -loglevel error \
        -f pulse -i colabgame.monitor \
        -c:a libmp3lame -b:a 128k -ar 44100 -ac 2 \
        -f mp3 -listen 1 "http://0.0.0.0:$AUDIO_PORT/audio.mp3" || sleep 1
    done
  ) </dev/null >>"$WORK/audio.log" 2>&1 &
  sleep 2
else
  say "PulseAudio មិនដំណើរការ — ហ្គេមនឹងលេងដោយគ្មានសំឡេង (អេក្រង់ដំណើរការធម្មតា)។"
fi

# ------------------------------------------------------------- 4. the screen
step "4/6 បើកអេក្រង់និម្មិត (Xvfb + x11vnc + noVNC)"
nohup Xvfb "$DISPLAY_NUM" -screen 0 "${WIDTH}x${HEIGHT}x24" -nolisten tcp \
  </dev/null >"$WORK/xvfb.log" 2>&1 &
sleep 2

DISPLAY="$DISPLAY_NUM" nohup openbox </dev/null >"$WORK/openbox.log" 2>&1 &
sleep 1

# A page that loads but cannot connect is what a missing VNC server looks like
# from the phone, so both halves are proved here instead of assumed: the display
# must answer, and port 5900 must greet with the RFB banner.
start_vnc() {
  nohup x11vnc -display "$DISPLAY_NUM" -nopw -forever -shared -xkb \
    -rfbport 5900 -noxdamage -repeat </dev/null >"$WORK/x11vnc.log" 2>&1 &
  i=0
  while [ "$i" -lt 15 ]; do
    if curl -s --max-time 2 telnet://127.0.0.1:5900 2>/dev/null | grep -q '^RFB'; then
      return 0
    fi
    i=$((i + 1))
    sleep 1
  done
  return 1
}

VNC_OK=0
for attempt in 1 2 3; do
  if DISPLAY="$DISPLAY_NUM" xdpyinfo >/dev/null 2>&1 && start_vnc; then
    VNC_OK=1
    break
  fi
  pkill -f "x11vnc -display $DISPLAY_NUM" >/dev/null 2>&1 || true
  sleep 1
done

if [ "$VNC_OK" != "1" ]; then
  printf -- '--- x11vnc.log ចុងក្រោយ ---\n'
  tail -6 "$WORK/x11vnc.log" 2>/dev/null | sed 's/^/    /'
  die "x11vnc មិនឆ្លើយនៅ port 5900 — noVNC ឡើងទំព័របាន តែចុច Connect មិនចេញ។"
fi
say "VNC ឆ្លើយតបហើយ (RFB 5900)"

# One page holds the screen and the sound, so the visitor clicks a single link.
cp -r "$NOVNC_WEB"/. "$WORK/web"/ 2>/dev/null || true
cat >"$WORK/web/index.html" <<'HTML'
<!doctype html>
<html lang="km">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Colab Game</title>
<style>
  html, body { margin: 0; height: 100%; background: #0b1020; color: #e2e8f0;
               font-family: system-ui, "Noto Sans Khmer", sans-serif; }
  #bar { display: flex; align-items: center; gap: 10px; padding: 8px 12px;
         background: #111827; border-bottom: 1px solid #1f2937; flex-wrap: wrap; }
  #bar strong { font-size: 14px; }
  #bar audio { height: 32px; max-width: 100%; }
  #bar a { color: #67e8f9; font-size: 12px; }
  #hint { color: #94a3b8; font-size: 11px; }
  iframe { display: block; width: 100%; height: calc(100% - 54px); border: 0; }
</style>
</head>
<body>
  <div id="bar">
    <strong>Colab Game</strong>
    <audio id="sound" controls preload="none" src="__AUDIO__"></audio>
    <a href="__VNC__" target="_blank" rel="noopener">open full screen</a>
    <span id="hint">សំឡេង៖ ចុច ▶ ក្នុងកម្មវិធីចាក់ខាងលើ</span>
  </div>
  <iframe src="__VNC__" allow="autoplay; fullscreen; clipboard-read; clipboard-write"></iframe>
</body>
</html>
HTML

nohup websockify --web="$WORK/web" "$PORT" 127.0.0.1:5900 \
  </dev/null >"$WORK/websockify.log" 2>&1 &
sleep 3

curl -fsS "http://127.0.0.1:$PORT/vnc.html" >/dev/null 2>&1 ||
  die "noVNC មិនឆ្លើយនៅ port $PORT (មើល $WORK/websockify.log)"

# ------------------------------------------------------------------ 5. tunnel
step "5/6 បើក tunnel (Cloudflare)"
BIN_DIR="$WORK/bin"
mkdir -p "$BIN_DIR"
if command -v cloudflared >/dev/null 2>&1; then
  CF=$(command -v cloudflared)
elif [ -x "$BIN_DIR/cloudflared" ]; then
  CF="$BIN_DIR/cloudflared"
else
  case "$(uname -m)" in
    aarch64 | arm64) ARCH=arm64 ;;
    *) ARCH=amd64 ;;
  esac
  say "ទាញ cloudflared ($ARCH) ..."
  curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$ARCH" \
    -o "$BIN_DIR/cloudflared" || die "ទាញ cloudflared បរាជ័យ"
  chmod +x "$BIN_DIR/cloudflared"
  CF="$BIN_DIR/cloudflared"
fi

# $1 = local port, $2 = log file; prints the https URL
start_tunnel() {
  : >"$2"
  nohup "$CF" tunnel --no-autoupdate --url "http://localhost:$1" \
    </dev/null >"$2" 2>&1 &
  i=0
  while [ "$i" -lt 40 ]; do
    URL=$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$2" 2>/dev/null | head -1)
    [ -n "$URL" ] && printf '%s' "$URL" && return 0
    i=$((i + 1))
    sleep 2
  done
  return 1
}

SCREEN_URL=$(start_tunnel "$PORT" "$WORK/tunnel-screen.log") ||
  die "tunnel សម្រាប់អេក្រង់បរាជ័យ (មើល $WORK/tunnel-screen.log)"
AUDIO_URL=""
if [ "$SOUND_OK" = "1" ]; then
  AUDIO_URL=$(start_tunnel "$AUDIO_PORT" "$WORK/tunnel-audio.log") || AUDIO_URL=""
fi

VNC_URL="$SCREEN_URL/vnc.html?autoconnect=1&resize=scale&path=websockify&reconnect=1&reconnect_delay=2000"
PAGE_URL="$SCREEN_URL/index.html"

if [ -n "$AUDIO_URL" ]; then
  python3 - "$WORK/web/index.html" "$AUDIO_URL/audio.mp3" "$VNC_URL" <<'PY' 2>/dev/null || true
import sys
path, audio, vnc = sys.argv[1], sys.argv[2], sys.argv[3]
html = open(path, encoding='utf-8').read()
open(path, 'w', encoding='utf-8').write(html.replace('__AUDIO__', audio).replace('__VNC__', vnc))
PY
else
  python3 - "$WORK/web/index.html" "$VNC_URL" <<'PY' 2>/dev/null || true
import sys
path, vnc = sys.argv[1], sys.argv[2]
html = open(path, encoding='utf-8').read()
open(path, 'w', encoding='utf-8').write(html.replace('__AUDIO__', '').replace('__VNC__', vnc))
PY
fi

# Wait until the tunnel really answers, not just until it has a name.
READY=0
i=0
while [ "$i" -lt 30 ]; do
  if curl -fsS "$PAGE_URL" >/dev/null 2>&1; then
    READY=1
    break
  fi
  i=$((i + 1))
  sleep 2
done

# ---------------------------------------------------------------- 6. the game
step "6/6 បើកហ្គេម"
# There is no screen on the GPU, so Mesa paints with the CPU unless the owner
# asks for the card (GL=hw), which only works when the driver exports GLX here.
if [ "${GL:-sw}" != "hw" ]; then
  export LIBGL_ALWAYS_SOFTWARE=1
  export GALLIUM_DRIVER=llvmpipe
fi
export SDL_AUDIODRIVER=pulse
export ALSOFT_DRIVERS=pulse
[ "$SOUND_OK" = "1" ] && export PULSE_SINK=colabgame

if [ "$GAME" = "openra" ]; then
  DISPLAY="$DISPLAY_NUM" APPIMAGE_EXTRACT_AND_RUN=1 \
    nohup "$BIN" </dev/null >>"$WORK/game.log" 2>&1 &
else
  DISPLAY="$DISPLAY_NUM" nohup "$BIN" </dev/null >>"$WORK/game.log" 2>&1 &
fi
sleep 6

printf '\n============================================================\n'
printf '  ចុច link ខាងក្រោមដើម្បីលេង (ហ្គេមបើករួចហើយ)\n'
printf '============================================================\n'
printf 'ហ្គេម  : %s\n' "$GAME"
printf 'លេង    : %s\n' "$PAGE_URL"
printf 'អេក្រង់ : %s\n' "$VNC_URL"
[ -n "$AUDIO_URL" ] && printf 'សំឡេង  : %s\n' "$AUDIO_URL/audio.mp3"
printf '============================================================\n'
if [ "$READY" = "1" ]; then
  printf 'ស្ថានភាព : រួចរាល់ — link ឆ្លើយតបរួចហើយ\n'
else
  printf 'ស្ថានភាព : tunnel បើកហើយ តែមិនទាន់ឆ្លើយ — សូមរង់ចាំ ~១៥ វិ រួចចុចម្តងទៀត\n'
fi
printf '\n'
say "• ទុក tab នេះបើកចុះ — បិទ tab ឬ idle ~៩០ នាទី = session ដាច់ ហើយ link ស្លាប់។"
say "• លេងរួច → រត់បន្ទាត់ដដែលម្តងទៀត (តំឡើងរួចនឹងរំលង)។"
say "• បើទំព័រនិយាយ Failed to connect: រត់ STOP=1 ដើម្បីសម្អាត រួចរត់ធម្មតាម្តងទៀត។"
say "• បញ្ឈប់ទាំងអស់: !curl -fsSL <ខ្លួនឯង> | STOP=1 sh"
say "• log: $WORK/game.log · $WORK/websockify.log · $WORK/audio.log · $WORK/tunnel-*.log"

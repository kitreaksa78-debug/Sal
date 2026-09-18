#!/bin/sh
# KhmerDub AI — one-shot installer for an Oracle Cloud "Always Free" VM
# (Ubuntu 22.04/24.04 or Oracle Linux 9 / RHEL 9).
#
# Run it ON the VM, as root:
#   curl -fsSL https://raw.githubusercontent.com/kitreaksa78-debug/Sal/main/scripts/setup-vps.sh | sudo sh
# or, after cloning the repo:
#   sudo sh scripts/setup-vps.sh
#
# Re-running the script updates the app: git pull -> rebuild -> restart.
#
# Overridable:
#   KH_REPO=https://github.com/you/your-fork.git
#   KH_BRANCH=main
#   KH_DIR=/opt/khmerdub
#   KH_PORT=3000
set -eu

KH_REPO="${KH_REPO:-https://github.com/kitreaksa78-debug/Sal.git}"
KH_BRANCH="${KH_BRANCH:-main}"
KH_DIR="${KH_DIR:-/opt/khmerdub}"
KH_PORT="${KH_PORT:-3000}"
KH_USER="${KH_USER:-khmerdub}"
SERVICE=khmerdub

log() { printf '\033[1;32m→\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Please run as root: sudo sh scripts/setup-vps.sh"

# ---------------------------------------------------------------- base packages
log "Installing base packages"
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq git curl ca-certificates >/dev/null
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y -q git curl ca-certificates >/dev/null
else
  die "Unsupported distribution: need apt-get or dnf."
fi

# ------------------------------------------------------------------- Node.js 22
NODE_BIN=$(command -v node || true)
NODE_OK=no
if [ -n "$NODE_BIN" ]; then
  NODE_MAJOR=$("$NODE_BIN" -v | sed 's/^v\([0-9]*\).*/\1/')
  if [ "$NODE_MAJOR" -ge 20 ]; then
    NODE_OK=yes
  fi
fi

if [ "$NODE_OK" = no ]; then
  log "Installing Node.js 22"
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
    apt-get install -y -qq nodejs >/dev/null
  else
    # Oracle Linux 9 / RHEL 9 modules ship Node 22.
    dnf module install -y nodejs:22/common >/dev/null 2>&1 || dnf install -y nodejs npm >/dev/null
  fi
  NODE_BIN=$(command -v node) || die "Node.js installation failed."
fi
log "Node.js $(node -v) at $NODE_BIN"

# ---------------------------------------------------------------- service user
if ! id "$KH_USER" >/dev/null 2>&1; then
  log "Creating system user $KH_USER"
  useradd --system --create-home --shell /usr/sbin/nologin "$KH_USER" 2>/dev/null \
    || useradd --system --create-home --shell /sbin/nologin "$KH_USER"
fi

# ----------------------------------------------------------------------- code
if [ -d "$KH_DIR/.git" ]; then
  log "Updating $KH_DIR (git pull)"
  git -C "$KH_DIR" fetch --depth 1 origin "$KH_BRANCH"
  git -C "$KH_DIR" checkout -q "$KH_BRANCH"
  git -C "$KH_DIR" reset --hard "origin/$KH_BRANCH" || warn "Could not fast-forward; kept current tree"
else
  log "Cloning $KH_REPO into $KH_DIR"
  rm -rf "$KH_DIR"
  git clone --depth 1 --branch "$KH_BRANCH" "$KH_REPO" "$KH_DIR"
fi

# ---------------------------------------------------------------------- build
log "Installing dependencies (npm install) — this pulls FFmpeg, ~2 minutes"
cd "$KH_DIR"
npm install --no-audit --no-fund --loglevel=error

log "Building (vite client + esbuild server bundle)"
npm run build --silent

mkdir -p "$KH_DIR/data"
chown -R "$KH_USER:$KH_USER" "$KH_DIR"

# ------------------------------------------------------------------ env file
ENV_FILE="$KH_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
  log "Creating $ENV_FILE — fill in your keys afterwards"
  cat > "$ENV_FILE" <<'ENVEOF'
# KhmerDub AI server configuration.
# Required:
GROQ_API_KEY=
# Optional: extra Groq keys, used automatically when a key is rate-limited or revoked.
GROQ_API_KEY2=
GROQ_API_KEY3=
STT_PROVIDER=groq
TRANSLATION_PROVIDER=groq
# Optional: keep uploads/results in Cloudflare R2 (recommended on a VPS too).
# S3_ENDPOINT=
# S3_BUCKET=
# S3_ACCESS_KEY_ID=
# S3_SECRET_ACCESS_KEY=
ENVEOF
else
  log "$ENV_FILE already exists — left untouched"
fi
chown "$KH_USER:$KH_USER" "$ENV_FILE"
chmod 600 "$ENV_FILE"

# ------------------------------------------------------------------- systemd
log "Installing systemd service '$SERVICE'"
cat > "/etc/systemd/system/$SERVICE.service" <<UNITEOF
[Unit]
Description=KhmerDub AI (video dubbing API + web UI)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$KH_USER
WorkingDirectory=$KH_DIR
EnvironmentFile=-$ENV_FILE
Environment=NODE_ENV=production
Environment=PORT=$KH_PORT
ExecStart=$NODE_BIN dist/server.cjs
Restart=always
RestartSec=5
# Video rendering is CPU heavy; keep the service out of the way of SSH logins.
Nice=5
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
UNITEOF

systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1 || true
systemctl restart "$SERVICE"

# ------------------------------------------------------------------ firewall
log "Opening TCP $KH_PORT in the VM firewall"
# Oracle's Ubuntu images reject everything except SSH with iptables rules, so the
# ACCEPT has to go in before those REJECT rules.
if command -v iptables >/dev/null 2>&1; then
  iptables -C INPUT -p tcp --dport "$KH_PORT" -j ACCEPT 2>/dev/null \
    || iptables -I INPUT 1 -p tcp --dport "$KH_PORT" -j ACCEPT
  if command -v netfilter-persistent >/dev/null 2>&1; then
    netfilter-persistent save >/dev/null 2>&1 || true
  elif [ -d /etc/iptables ]; then
    iptables-save > /etc/iptables/rules.v4 2>/dev/null || true
  fi
fi
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "^Status: active"; then
  ufw allow "$KH_PORT"/tcp >/dev/null 2>&1 || true
fi
if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port="$KH_PORT"/tcp >/dev/null 2>&1 || true
  firewall-cmd --reload >/dev/null 2>&1 || true
fi

# ---------------------------------------------------------------- health check
log "Waiting for the app to answer"
HEALTH=no
i=0
while [ "$i" -lt 30 ]; do
  if curl -fsS "http://127.0.0.1:$KH_PORT/api/health" >/dev/null 2>&1; then
    HEALTH=yes
    break
  fi
  i=$((i + 1))
  sleep 2
done

PUBLIC_IP=""
PUBLIC_IP=$(curl -fsS -H 'Authorization: Bearer Oracle' \
  http://169.254.169.254/opc/v2/vnics/ 2>/dev/null \
  | sed -n 's/.*"publicIp"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1 || true)

echo
if [ "$HEALTH" = yes ]; then
  printf '\033[1;32m✓ KhmerDub AI is running\033[0m\n'
else
  printf '\033[1;31m✗ The service did not answer in time\033[0m — check: journalctl -u %s -n 50\n' "$SERVICE"
fi
echo
echo "  local:        http://127.0.0.1:$KH_PORT"
if [ -n "$PUBLIC_IP" ]; then
  echo "  public IP:    http://$PUBLIC_IP:$KH_PORT"
fi
echo "  env file:     $ENV_FILE"
echo "  logs:         journalctl -u $SERVICE -f"
echo "  restart:      systemctl restart $SERVICE  (run after editing $ENV_FILE)"
echo "  update app:   sudo sh $KH_DIR/scripts/setup-vps.sh"
echo
echo "Last step in the Oracle console: add an Ingress rule in your VCN"
echo "Security List / Network Security Group allowing TCP $KH_PORT from 0.0.0.0/0."
echo "Without it the VM firewall is open but the cloud network still blocks it."

#!/bin/bash
# EdgeController post-update migration script
# Runs automatically after each `git pull && npm install` update.
# Every step must be idempotent — safe to run on an already-correct install.

APP_DIR="/home/alans/edgecontroller"
APP_USER="alans"

log() { echo "[migrate] $*"; }

# ── cage + chromium (HDMI kiosk) ─────────────────────────────────────────────
if ! command -v cage >/dev/null 2>&1; then
  log "Installing cage and chromium-browser"
  apt-get update -qq
  apt-get install -y -qq cage chromium-browser xwayland
else
  log "cage already installed — skipping"
fi

# ── tty7 autologin drop-in ────────────────────────────────────────────────────
GETTY_DROP_IN="/etc/systemd/system/getty@tty7.service.d"
mkdir -p "$GETTY_DROP_IN"
# Always copy — ensures chvt 7 is present even on older installs that had the conf without it
cp "$APP_DIR/systemd/getty-tty7-autologin.conf" "$GETTY_DROP_IN/autologin.conf"
systemctl daemon-reload
systemctl enable getty@tty7.service
log "tty7 autologin drop-in installed"

# ── .bash_profile kiosk launch ────────────────────────────────────────────────
BASH_PROFILE="/home/$APP_USER/.bash_profile"
if ! grep -q 'cage' "$BASH_PROFILE" 2>/dev/null; then
  log "Writing ~/.bash_profile with kiosk launch"
  cat > "$BASH_PROFILE" << 'BPEOF'
# Start HDMI kiosk on tty7
if [ "$(tty)" = '/dev/tty7' ]; then
  sleep 3
  exec cage -- /usr/bin/chromium-browser \
    --kiosk \
    --noerrdialogs \
    --disable-infobars \
    --no-first-run \
    --disable-translate \
    --disable-features=TranslateUI \
    --autoplay-policy=no-user-gesture-required \
    --disable-session-crashed-bubble \
    --force-device-scale-factor=1 \
    http://localhost:3000/hdmi
fi
BPEOF
  chown "$APP_USER:$APP_USER" "$BASH_PROFILE"
else
  log "~/.bash_profile already has kiosk config — skipping"
fi

# ── ecosystem.config.cjs — ensure UV_THREADPOOL_SIZE is set ──────────────────
ECO="$APP_DIR/ecosystem.config.cjs"
if ! grep -q 'UV_THREADPOOL_SIZE' "$ECO" 2>/dev/null; then
  log "Adding UV_THREADPOOL_SIZE to ecosystem.config.cjs"
  # Insert after PROVISION_KEY line
  sed -i "s/PROVISION_KEY: '[^']*'/&,\n      UV_THREADPOOL_SIZE: '16'/" "$ECO"
else
  log "UV_THREADPOOL_SIZE already set — skipping"
fi

log "Migration complete"

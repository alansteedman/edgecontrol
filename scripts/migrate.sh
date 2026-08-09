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

# ── go2rtc ───────────────────────────────────────────────────────────────────
GO2RTC_BIN="/home/$APP_USER/go2rtc"
if [ ! -f "$GO2RTC_BIN" ]; then
  log "Downloading go2rtc v1.9.14"
  curl -fsSL https://github.com/AlexxIT/go2rtc/releases/download/v1.9.14/go2rtc_linux_arm64 -o "$GO2RTC_BIN"
  chmod +x "$GO2RTC_BIN"
  chown "$APP_USER:$APP_USER" "$GO2RTC_BIN"
  sudo -u "$APP_USER" pm2 delete go2rtc 2>/dev/null || true
  sudo -u "$APP_USER" pm2 start "$GO2RTC_BIN" --name go2rtc -- --config go2rtc.yaml
  sudo -u "$APP_USER" pm2 save
else
  log "go2rtc already installed — skipping"
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

# ── cifs-utils (media player SMB shares) ──────────────────────────────────────
if ! command -v mount.cifs >/dev/null 2>&1; then
  log "Installing cifs-utils"
  apt-get update -qq
  apt-get install -y -qq cifs-utils
else
  log "cifs-utils already installed — skipping"
fi

# ── smbclient (media player SMB share listing) ────────────────────────────────
if ! command -v smbclient >/dev/null 2>&1; then
  log "Installing smbclient"
  apt-get update -qq
  apt-get install -y -qq smbclient
else
  log "smbclient already installed — skipping"
fi

# ── PipeWire (HDMI audio for the kiosk) ───────────────────────────────────────
if ! command -v pactl >/dev/null 2>&1; then
  log "Installing pipewire (HDMI audio)"
  apt-get update -qq
  apt-get install -y -qq pipewire pipewire-pulse wireplumber pipewire-audio-client-libraries pulseaudio-utils alsa-utils
  loginctl enable-linger "$APP_USER"
  APP_UID="$(id -u "$APP_USER")"
  mkdir -p "/run/user/$APP_UID"
  chown "$APP_USER:$APP_USER" "/run/user/$APP_UID"
  runuser -l "$APP_USER" -c "XDG_RUNTIME_DIR=/run/user/$APP_UID systemctl --user daemon-reload"
  runuser -l "$APP_USER" -c "XDG_RUNTIME_DIR=/run/user/$APP_UID systemctl --user enable --now pipewire pipewire-pulse wireplumber" || true
  # Chromium's audio service only connects to PipeWire at startup — restart the
  # kiosk session so it picks up the newly available audio server.
  systemctl restart getty@tty7.service 2>/dev/null || true
  log "PipeWire enabled — kiosk restarted to pick up audio"
else
  log "pipewire already installed — skipping"
fi

# ── video/render groups (HDMI hw decode) ──────────────────────────────────────
# Set directly on a couple of Pis during live debugging but never made it
# into a script until now.
if ! id -nG "$APP_USER" | grep -qw render; then
  log "Adding $APP_USER to video, render groups"
  usermod -aG video,render "$APP_USER" 2>/dev/null || true
else
  log "video/render groups already set — skipping"
fi

# ── Cooling fan: free GPIO14 from the serial console getty ───────────────────
# GPIO14 defaults to UART TXD0. The software-controlled fan feature (and the
# official gpio-fan overlay it's modeled on) repurposes that pin as a plain
# GPIO output, which conflicts with the serial console getty listening on it.
# This Pi is managed over SSH/network, never physical serial console, so
# disabling it is the standard trade-off — matches what dtoverlay=gpio-fan
# itself assumes.
if [ "$(systemctl is-enabled serial-getty@ttyAMA0.service 2>/dev/null)" != "masked" ]; then
  log "Masking serial-getty@ttyAMA0 (frees GPIO14 for the cooling fan)"
  # It's runtime-generated (systemd re-detects the UART and re-enables the
  # getty at every boot), so a plain `disable` doesn't survive a reboot —
  # masking it does.
  systemctl mask serial-getty@ttyAMA0.service 2>/dev/null || true
else
  log "serial-getty@ttyAMA0 already masked — skipping"
fi

log "Migration complete"

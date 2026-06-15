#!/bin/bash
# EdgeController Install Script
# Tested on Ubuntu 26.04 LTS on Raspberry Pi 5
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/alansteedman/edgecontroller/main/install.sh | sudo bash

set -euo pipefail

# Stop unattended-upgrades so it doesn't hold the apt lock during install
systemctl stop unattended-upgrades 2>/dev/null || true
systemctl stop apt-daily.service apt-daily-upgrade.service 2>/dev/null || true
systemctl kill --kill-who=all apt-daily.service apt-daily-upgrade.service 2>/dev/null || true
# Wait for any running apt/dpkg to finish
while fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; do sleep 1; done

REPO="https://github.com/alansteedman/edgecontrol"
APP_DIR="/home/alans/edgecontroller"
APP_USER="alans"
NODE_VERSION="22"
PROVISION_KEY="8bc536e97a3996ea7b660e400c321e3132772ec0a5ac50367c24309391014fa9"

log()  { echo -e "\n\033[1;36m▶ $*\033[0m"; }
ok()   { echo -e "\033[1;32m✓ $*\033[0m"; }
err()  { echo -e "\033[1;31m✗ $*\033[0m" >&2; exit 1; }

[ "$EUID" -ne 0 ] && err "Please run with sudo:  curl -fsSL ... | sudo bash"

# ── System packages ───────────────────────────────────────────────────────────
log "Updating package lists"
apt-get update -qq

log "Installing system dependencies"
apt-get install -y -qq \
  curl git avahi-daemon avahi-utils \
  network-manager \
  bluetooth bluez \
  build-essential \
  libusb-1.0-0-dev libudev-dev \
  libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
  iptables

# ── Node.js ───────────────────────────────────────────────────────────────────
log "Installing Node.js $NODE_VERSION"
if ! node --version 2>/dev/null | grep -q "^v$NODE_VERSION"; then
  curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs
fi
ok "Node $(node --version)"

# ── pm2 ───────────────────────────────────────────────────────────────────────
log "Installing pm2"
npm install -g pm2 --quiet --no-progress 2>/dev/null
ok "pm2 $(pm2 --version)"

# ── cloudflared ───────────────────────────────────────────────────────────────
log "Installing cloudflared"
ARCH=$(dpkg --print-architecture)
curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}" \
  -o /usr/local/bin/cloudflared
chmod +x /usr/local/bin/cloudflared
ok "cloudflared $(cloudflared --version 2>&1 | head -1)"

# ── User ─────────────────────────────────────────────────────────────────────
log "Setting up user: $APP_USER"
if ! id "$APP_USER" &>/dev/null; then
  useradd -m -s /bin/bash "$APP_USER"
  ok "Created user $APP_USER"
else
  ok "User $APP_USER already exists"
fi
usermod -aG sudo,bluetooth,dialout,plugdev "$APP_USER" 2>/dev/null || true

log "Configuring sudoers"
echo "$APP_USER ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/edgecontroller
chmod 440 /etc/sudoers.d/edgecontroller

# ── App ───────────────────────────────────────────────────────────────────────
log "Installing edgecontroller app"
if [ -d "$APP_DIR/.git" ]; then
  cd "$APP_DIR" && git pull --quiet
  ok "Updated from git"
else
  rm -rf "$APP_DIR"
  git clone --quiet "$REPO" "$APP_DIR"
  ok "Cloned from $REPO"
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

log "Installing npm dependencies"
cd "$APP_DIR"
sudo -u "$APP_USER" npm install --quiet --no-progress 2>/dev/null

# ── Device ID ─────────────────────────────────────────────────────────────────
log "Generating device ID from CPU serial"
BOX_ID=$(node -e "
const {createHash} = require('crypto')
const {readFileSync} = require('fs')
try {
  const m = readFileSync('/proc/cpuinfo', 'utf8').match(/Serial\s*:\s*([0-9a-f]+)/i)
  console.log(m ? createHash('sha256').update(m[1]).digest('hex').slice(0,4) : 'xxxx')
} catch { console.log('xxxx') }
" 2>/dev/null)
ok "Device ID: $BOX_ID"

# ── Config files ──────────────────────────────────────────────────────────────
log "Writing config.json"
CONFIG_FILE="$APP_DIR/config.json"
if [ ! -f "$CONFIG_FILE" ] || ! python3 -c "import json; d=json.load(open('$CONFIG_FILE')); assert d.get('boxId')" 2>/dev/null; then
  SESSION_SECRET=$(openssl rand -hex 32)
  cat > "$CONFIG_FILE" << EOF
{
  "devices": [],
  "groups": [],
  "sessionSecret": "$SESSION_SECRET",
  "auth": {
    "enabled": false
  },
  "boxId": "$BOX_ID"
}
EOF
  chown "$APP_USER:$APP_USER" "$CONFIG_FILE"
  ok "Created config.json with boxId=$BOX_ID"
else
  ok "config.json already exists — skipping"
fi

log "Writing ecosystem.config.cjs"
cat > "$APP_DIR/ecosystem.config.cjs" << EOF
module.exports = {
  apps: [{
    name: 'edgecontroller',
    script: './server.js',
    env: {
      PROVISION_KEY: '$PROVISION_KEY'
    }
  }]
}
EOF
chown "$APP_USER:$APP_USER" "$APP_DIR/ecosystem.config.cjs"

# ── Hostname ──────────────────────────────────────────────────────────────────
log "Setting hostname to $BOX_ID"
hostnamectl set-hostname "$BOX_ID"
echo "$BOX_ID" > /etc/hostname

# ── Scripts ───────────────────────────────────────────────────────────────────
log "Installing edge-network boot script"
cp "$APP_DIR/scripts/edge-network" /usr/local/bin/edge-network
chmod +x /usr/local/bin/edge-network

log "Installing fan control script"
cp "$APP_DIR/scripts/fan-control.sh" /usr/local/bin/fan-control.sh
chmod +x /usr/local/bin/fan-control.sh

log "Installing first-boot script"
cp "$APP_DIR/scripts/firstboot.sh" /usr/local/bin/edgecontroller-firstboot.sh
chmod +x /usr/local/bin/edgecontroller-firstboot.sh

# ── Systemd ───────────────────────────────────────────────────────────────────
log "Installing systemd services"
cp "$APP_DIR/systemd/edge-network.service" /etc/systemd/system/
cp "$APP_DIR/systemd/fan-control.service" /etc/systemd/system/
cp "$APP_DIR/systemd/edgecontroller-firstboot.service" /etc/systemd/system/

PM2_DROP_IN="/etc/systemd/system/pm2-${APP_USER}.service.d"
mkdir -p "$PM2_DROP_IN"
cp "$APP_DIR/systemd/pm2-drop-in.conf" "$PM2_DROP_IN/edge-network.conf"

systemctl daemon-reload
systemctl enable edge-network.service
systemctl enable fan-control.service
systemctl enable edgecontroller-firstboot.service

# ── NetworkManager captive portal ─────────────────────────────────────────────
log "Configuring NetworkManager captive portal"
mkdir -p /etc/NetworkManager/dnsmasq-shared.d
cp "$APP_DIR/config/captive-portal.conf" /etc/NetworkManager/dnsmasq-shared.d/captive-portal.conf
systemctl reload NetworkManager 2>/dev/null || true

# ── Boot config ───────────────────────────────────────────────────────────────
log "Installing /boot/firmware/edgecontroller.conf"
cp "$APP_DIR/config/edgecontroller.conf" /boot/firmware/edgecontroller.conf

log "Configuring fan control in /boot/firmware/config.txt"
if ! grep -q 'fan_temp0' /boot/firmware/config.txt 2>/dev/null; then
  cat >> /boot/firmware/config.txt << 'EOF'

# EdgeController fan control
dtparam=fan_temp0=50000,fan_temp0_hyst=5000,fan_temp0_speed=75
dtparam=fan_temp1=60000,fan_temp1_hyst=5000,fan_temp1_speed=128
dtparam=fan_temp2=70000,fan_temp2_hyst=5000,fan_temp2_speed=189
dtparam=fan_temp3=75000,fan_temp3_hyst=5000,fan_temp3_speed=255
EOF
fi

# ── Runtime directory ─────────────────────────────────────────────────────────
log "Creating runtime directory"
mkdir -p /run/edgecontroller

# ── Avahi ─────────────────────────────────────────────────────────────────────
log "Enabling avahi mDNS"
systemctl enable avahi-daemon
systemctl start avahi-daemon

# ── pm2 ───────────────────────────────────────────────────────────────────────
log "Starting edgecontroller with pm2"
cd "$APP_DIR"
sudo -u "$APP_USER" pm2 delete edgecontroller 2>/dev/null || true
sudo -u "$APP_USER" pm2 start ecosystem.config.cjs
sudo -u "$APP_USER" pm2 save

log "Enabling pm2 on boot"
env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u "$APP_USER" --hp "/home/$APP_USER"
sudo -u "$APP_USER" pm2 save

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║       EdgeController installed successfully!     ║"
echo "║                                                  ║"
printf  "║   Device ID : %-35s║\n" "$BOX_ID"
printf  "║   Local URL : %-35s║\n" "http://$BOX_ID.local:3000"
echo "║                                                  ║"
echo "║   Remote access will be set up on first boot     ║"
echo "║   after connecting to WiFi.                      ║"
echo "║                                                  ║"
echo "║   Reboot to complete:  sudo reboot               ║"
echo "╚══════════════════════════════════════════════════╝"

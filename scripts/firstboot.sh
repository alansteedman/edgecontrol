#!/bin/bash
# EdgeController first-boot setup
# Derives hostname and boxId from this Pi's CPU serial, then disables itself.

APP_DIR="/home/alans/edgecontroller"

BOX_ID=$(node -e "
const {createHash} = require('crypto')
const {readFileSync} = require('fs')
try {
  const m = readFileSync('/proc/cpuinfo', 'utf8').match(/Serial\s*:\s*([0-9a-f]+)/i)
  console.log(m ? createHash('sha256').update(m[1]).digest('hex').slice(0,4) : 'xxxx')
} catch { console.log('xxxx') }
" 2>/dev/null)

if [ -z "$BOX_ID" ] || [ "$BOX_ID" = "xxxx" ]; then
  echo "[firstboot] Could not derive boxId from CPU serial — skipping"
else
  echo "[firstboot] Setting hostname to $BOX_ID"
  hostnamectl set-hostname "$BOX_ID"
  echo "$BOX_ID" > /etc/hostname

  # Update boxId in config.json
  if [ -f "$APP_DIR/config.json" ]; then
    python3 -c "
import json, sys
path = '$APP_DIR/config.json'
with open(path) as f:
    c = json.load(f)
c['boxId'] = '$BOX_ID'
with open(path, 'w') as f:
    json.dump(c, f, indent=2)
print('[firstboot] Updated config.json boxId to $BOX_ID')
"
  fi

  # Restart avahi so mDNS picks up the new hostname immediately
  systemctl restart avahi-daemon 2>/dev/null || true
fi

# Disable this service — never run again
systemctl disable edgecontroller-firstboot.service
echo "[firstboot] Done — service disabled"

#!/bin/sh
# Pi 5 fan control — runs with user_space thermal policy
# Thresholds match config.txt dtparam values
ZONE=/sys/class/thermal/thermal_zone0/temp
FAN=/sys/class/thermal/cooling_device1/cur_state

# Wait for sysfs to appear
while [ ! -f "$ZONE" ] || [ ! -f "$FAN" ]; do sleep 1; done

while true; do
  TEMP=$(cat "$ZONE")
  if   [ "$TEMP" -ge 75000 ]; then STATE=4
  elif [ "$TEMP" -ge 70000 ]; then STATE=3
  elif [ "$TEMP" -ge 60000 ]; then STATE=2
  elif [ "$TEMP" -ge 50000 ]; then STATE=1
  else STATE=0
  fi
  echo "$STATE" > "$FAN"
  sleep 5
done

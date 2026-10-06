#!/bin/bash
# Installs a daily job on this Mac (launchd) that renews the Google Health access of a
# kibbl. user before Google ends it: quiet while the token has more than 3 days left,
# then a notification and the consent in the browser, and the new token on the server
# (deploy/renew-health-token.sh). A day the Mac slept through runs after it wakes.
#
#   HOST=jh@100.84.217.119 SSH_PORT=4711 ./deploy/install-health-renewal.sh user@example.com
#   ./deploy/install-health-renewal.sh --remove

set -euo pipefail

LABEL="com.kibbl.health-renewal"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/kibbl-health-renewal.log"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOMAIN="gui/$(id -u)"

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true

if [ "${1:-}" = "--remove" ]; then
    rm -f "$PLIST"
    echo "Removed the daily renewal."
    exit 0
fi

EMAIL="${1:-}"
if [ -z "$EMAIL" ]; then
    echo "usage: $0 <kibbl user e-mail> | --remove" >&2
    exit 1
fi

xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$(xml "$ROOT/deploy/renew-health-token.sh")</string>
        <string>--when-expiring</string>
        <string>72</string>
        <string>$(xml "$EMAIL")</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOST</key><string>$(xml "${HOST:-jhubuntu}")</string>
        <key>SSH_PORT</key><string>$(xml "${SSH_PORT:-}")</string>
        <key>WHOOFIT_DIR</key><string>$(xml "${WHOOFIT_DIR:-$ROOT/../whoofit}")</string>
        <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin</string>
    </dict>
    <key>StartCalendarInterval</key>
    <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
    <key>StandardOutPath</key><string>$(xml "$LOG")</string>
    <key>StandardErrorPath</key><string>$(xml "$LOG")</string>
</dict>
</plist>
EOF
plutil -lint "$PLIST" > /dev/null
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "Installed: every day at 9:00 (or after waking), renewal once the token has 3 days left."
echo "Log: $LOG"

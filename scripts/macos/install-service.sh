#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEMPLATE="$SCRIPT_DIR/com.apexvelo.lab.plist.template"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/com.apexvelo.lab.plist"
LOG_DIR="$HOME/Library/Logs/ApexVeloLab"

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "Error: node was not found in PATH. Install Node.js 24+ (e.g. brew install node@24)." >&2
  exit 1
fi

NODE_MAJOR="$("$NODE_BIN" -p "parseInt(process.versions.node.split('.')[0], 10)")"
if [[ "$NODE_MAJOR" -lt 24 ]]; then
  echo "Error: Node.js 24+ is required (found $("$NODE_BIN" -v) at $NODE_BIN)." >&2
  exit 1
fi

mkdir -p "$PLIST_DIR" "$LOG_DIR"

sed \
  -e "s|__NODE_BIN__|$NODE_BIN|g" \
  -e "s|__APP_DIR__|$APP_DIR|g" \
  -e "s|__LOG_DIR__|$LOG_DIR|g" \
  "$TEMPLATE" > "$PLIST_PATH"

launchctl bootout "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
launchctl kickstart -k "gui/$(id -u)/com.apexvelo.lab"

echo "Installed and started com.apexvelo.lab ($PLIST_PATH)."
echo "Logs: $LOG_DIR/server.out.log and $LOG_DIR/server.err.log"
echo ""
echo "Next steps on your Mac mini:"
echo "  1. Prevent sleep + auto-restart on power loss:"
echo "       sudo pmset -a sleep 0 disksleep 0 autorestart 1"
echo "  2. Expose private HTTPS over Tailscale:"
echo "       tailscale serve --bg http://127.0.0.1:8080"
echo "  3. Add your MagicDNS hostname to $APP_DIR/.env:"
echo "       APEX_ALLOW_TAILSCALE=1"
echo "       APEX_TAILSCALE_HOST=<your-mac-mini>.<your-tailnet>.ts.net"

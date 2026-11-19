#!/bin/sh
# Install (or reinstall) the launchd agents: the tick on a timer and the dashboard kept alive.
#   sh ~/.claude/factory/bin/install-launchd.sh [interval_seconds]
# Remove both: sh ~/.claude/factory/bin/install-launchd.sh --remove
set -e
ROOT="$HOME/.claude/factory"
NODE="$(command -v node)"
UID_="$(id -u)"
TICK=local.factory-tick
DASH=local.factory-dashboard
MON=local.factory-monitor
mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/state"

if [ "${1:-}" = "--remove" ]; then
  launchctl bootout "gui/$UID_/$TICK" 2>/dev/null || true
  launchctl bootout "gui/$UID_/$DASH" 2>/dev/null || true
  launchctl bootout "gui/$UID_/$MON" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/$TICK.plist" "$HOME/Library/LaunchAgents/$DASH.plist" "$HOME/Library/LaunchAgents/$MON.plist"
  echo "removed $TICK, $DASH and $MON"
  exit 0
fi

INTERVAL="${1:-600}"
CLAUDE_DIR="$(dirname "$(command -v claude)")"
GH_DIR="$(dirname "$(command -v gh)")"
PNPM_DIR="$(dirname "$(command -v pnpm 2>/dev/null || echo /usr/local/bin/pnpm)")"
PATHS="$(dirname "$NODE"):$CLAUDE_DIR:$GH_DIR:$PNPM_DIR:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

write_plist() { # label, program-args-xml, extra-xml
  cat > "$HOME/Library/LaunchAgents/$1.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$1</string>
  <key>ProgramArguments</key><array>$2</array>
  $3
  <key>RunAtLoad</key><true/>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>StandardOutPath</key><string>$ROOT/state/$1.out.log</string>
  <key>StandardErrorPath</key><string>$ROOT/state/$1.err.log</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$PATHS</string><key>HOME</key><string>$HOME</string></dict>
</dict></plist>
EOF
}

write_plist "$TICK" "<string>$NODE</string><string>$ROOT/bin/factory-tick.mjs</string>" "<key>StartInterval</key><integer>$INTERVAL</integer>"
write_plist "$DASH" "<string>$NODE</string><string>$ROOT/bin/factory-dashboard.mjs</string>" "<key>KeepAlive</key><true/>"
# The monitor is a headless Claude run of /factory-monitor every 30 minutes; it only reads and notifies. Its skill is
# user-scope and every gh call names its repo, so it runs from the factory root like the rest.
write_plist "$MON" "<string>$CLAUDE_DIR/claude</string><string>-p</string><string>--model</string><string>sonnet</string><string>--dangerously-skip-permissions</string><string>/factory-monitor headless</string>" "<key>StartInterval</key><integer>1800</integer>"

for L in "$TICK" "$DASH" "$MON"; do
  launchctl bootout "gui/$UID_/$L" 2>/dev/null || true
  # bootout returns before the service is gone; bootstrap right after can fail with "5: Input/output error"
  for attempt in 1 2 3 4 5; do
    if launchctl bootstrap "gui/$UID_" "$HOME/Library/LaunchAgents/$L.plist" 2>/dev/null; then break; fi
    sleep 2
  done
  launchctl print "gui/$UID_/$L" >/dev/null 2>&1 || echo "warning: $L did not load; run: launchctl bootstrap gui/$UID_ $HOME/Library/LaunchAgents/$L.plist"
done
echo "installed: $TICK every ${INTERVAL}s, $DASH at http://localhost:7788, $MON every 1800s (logs in $ROOT/state/)"

#!/bin/sh
# Install (or reinstall) the launchd agents: the tick on a timer, the dashboard kept alive, the monitor every 30 min.
#   sh bin/install-launchd.sh [interval_seconds]
# Remove all three: sh bin/install-launchd.sh --remove
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UID_="$(id -u)"
TICK=ai.uiverify.factory-tick
DASH=ai.uiverify.factory-dashboard
MON=ai.uiverify.factory-monitor
mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/state"

if [ "${1:-}" = "--remove" ]; then
  for L in "$TICK" "$DASH" "$MON"; do
    launchctl bootout "gui/$UID_/$L" 2>/dev/null || true
    rm -f "$HOME/Library/LaunchAgents/$L.plist"
  done
  echo "removed $TICK, $DASH and $MON"
  exit 0
fi

NODE="$(command -v node)" || { echo "node not found on PATH"; exit 1; }
CLAUDE="$(command -v claude)" || { echo "claude (Claude Code CLI) not found on PATH"; exit 1; }
GH="$(command -v gh)" || { echo "gh (GitHub CLI) not found on PATH"; exit 1; }
# The monitor runs from the target repo so gh and the repo's skills resolve.
REPO_PATH="$("$NODE" --input-type=module -e "import { loadConfig } from '$ROOT/lib/common.mjs'; console.log(loadConfig().repo.path)")"

INTERVAL="${1:-600}"
PNPM_DIR="$(dirname "$(command -v pnpm 2>/dev/null || echo /usr/local/bin/pnpm)")"
# launchd starts with a bare PATH, so bake in where node, claude, gh and the package manager live today.
PATHS="$(dirname "$NODE"):$(dirname "$CLAUDE"):$(dirname "$GH"):$PNPM_DIR:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

write_plist() { # label, program-args-xml, extra-xml, working-dir
  cat > "$HOME/Library/LaunchAgents/$1.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$1</string>
  <key>ProgramArguments</key><array>$2</array>
  $3
  <key>RunAtLoad</key><true/>
  <key>WorkingDirectory</key><string>$4</string>
  <key>StandardOutPath</key><string>$ROOT/state/$1.out.log</string>
  <key>StandardErrorPath</key><string>$ROOT/state/$1.err.log</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$PATHS</string><key>HOME</key><string>$HOME</string><key>FACTORY_ROOT</key><string>$ROOT</string></dict>
</dict></plist>
EOF
}

write_plist "$TICK" "<string>$NODE</string><string>$ROOT/bin/factory-tick.mjs</string>" "<key>StartInterval</key><integer>$INTERVAL</integer>" "$ROOT"
write_plist "$DASH" "<string>$NODE</string><string>$ROOT/bin/factory-dashboard.mjs</string>" "<key>KeepAlive</key><true/>" "$ROOT"
# The monitor is a headless Claude run of /factory-monitor every 30 minutes; it only reads and notifies.
write_plist "$MON" "<string>$CLAUDE</string><string>-p</string><string>--model</string><string>sonnet</string><string>--dangerously-skip-permissions</string><string>/factory-monitor headless</string>" "<key>StartInterval</key><integer>1800</integer>" "$REPO_PATH"

for L in "$TICK" "$DASH" "$MON"; do
  launchctl bootout "gui/$UID_/$L" 2>/dev/null || true
  # bootout returns before the service is gone; bootstrap right after can fail with "5: Input/output error"
  for attempt in 1 2 3 4 5; do
    if launchctl bootstrap "gui/$UID_" "$HOME/Library/LaunchAgents/$L.plist" 2>/dev/null; then break; fi
    sleep 2
  done
  launchctl print "gui/$UID_/$L" >/dev/null 2>&1 || echo "warning: $L did not load; run: launchctl bootstrap gui/$UID_ $HOME/Library/LaunchAgents/$L.plist"
done
echo "installed: $TICK every ${INTERVAL}s, $DASH (http://localhost:7788 unless dashboard.port says otherwise), $MON every 1800s (logs in $ROOT/state/)"

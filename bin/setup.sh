#!/bin/sh
# One-time setup on a new Mac: check the tools, create your local config files, link every skill in skills/ into Claude Code.
#   sh bin/setup.sh
# Safe to rerun: it never overwrites a file you already have.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
missing=0
need() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1 ($2)"; missing=1; }; }
need node "Node 20 or newer"
need claude "Claude Code CLI, https://claude.com/claude-code"
need gh "GitHub CLI, then: gh auth login"
need git "git"
command -v terminal-notifier >/dev/null 2>&1 || echo "optional: terminal-notifier for macOS banners (brew install terminal-notifier)"
gh extension list 2>/dev/null | grep -q "gh-stack" || echo "optional: gh stack for PR stacks (gh extension install github/gh-stack)"
[ "$missing" = 0 ] || { echo "install the missing tools above, then rerun"; exit 1; }
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' || { echo "Node 20 or newer is required"; exit 1; }

copy_once() { [ -e "$ROOT/$2" ] && echo "kept existing $2" || { cp "$ROOT/$1" "$ROOT/$2"; echo "created $2 from $1"; }; }
copy_once factory.example.json factory.json
copy_once .env.example .env
copy_once principles/TEMPLATE.md principles/principles.md

# Skills and the monitor find the factory at ~/.claude/factory.
if [ "$ROOT" != "$HOME/.claude/factory" ]; then
  if [ -e "$HOME/.claude/factory" ] && [ ! -L "$HOME/.claude/factory" ]; then
    echo "warning: ~/.claude/factory exists and is not a link to this checkout; skills will read that one"
  else
    ln -sfn "$ROOT" "$HOME/.claude/factory"
    echo "linked ~/.claude/factory -> $ROOT"
  fi
fi
mkdir -p "$HOME/.claude/skills"
for s in "$ROOT"/skills/*/; do
  name="$(basename "$s")"
  ln -sfn "${s%/}" "$HOME/.claude/skills/$name"
  echo "linked skill /$name"
done


cat <<MSG

Next:
  1. Put your Linear API key in .env
  2. Edit factory.json: repo, Linear team and states, owner, one target
  3. Fill in principles/principles.md
  4. Dry run: node bin/factory-tick.mjs --dry-run --verbose
  5. Start:   sh bin/install-launchd.sh 600   (or /factory-run start in Claude Code)
MSG

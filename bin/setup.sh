#!/bin/sh
# One-time setup on a new Mac: check the tools, create your local config files, link every skill in skills/ into Claude Code.
#   sh bin/setup.sh
# Safe to rerun: it never overwrites a file you already have. Rerun it after adding a repo to factory.json to get that
# repo's principles file.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
missing=0
need() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1 ($2)"; missing=1; }; }
need node "Node 20 or newer"
need claude "Claude Code CLI, https://claude.com/claude-code"
need gh "GitHub CLI, then: gh auth login"
need git "git"
command -v terminal-notifier >/dev/null 2>&1 || echo "optional: terminal-notifier for clickable macOS banners (brew install terminal-notifier)"
[ "$missing" = 0 ] || { echo "install the missing tools above, then rerun"; exit 1; }
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' || { echo "Node 20 or newer is required"; exit 1; }

copy_once() { [ -e "$ROOT/$2" ] && echo "kept existing $2" || { cp "$ROOT/$1" "$ROOT/$2"; echo "created $2 from $1"; }; }
copy_once factory.example.json factory.json
copy_once .env.example .env
mkdir -p "$ROOT/state" "$ROOT/projects"

# One principles file per repo in factory.json, started from the template.
node --input-type=module -e '
import fs from "node:fs"; import path from "node:path";
const root = process.argv[1];
const cfg = JSON.parse(fs.readFileSync(path.join(root, "factory.json"), "utf8"));
for (const [name, repo] of Object.entries(cfg.repos || {})) {
  const rel = repo.principles || `principles/${name}.md`;
  const file = rel.startsWith("~/") ? path.join(process.env.HOME, rel.slice(2)) : path.resolve(root, rel);
  if (fs.existsSync(file)) { console.log(`kept existing ${rel}`); continue; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, fs.readFileSync(path.join(root, "principles/TEMPLATE.md"), "utf8").replace("<owner/repo>", repo.github || name));
  console.log(`created ${rel} from principles/TEMPLATE.md`);
}
' "$ROOT"

# Skills, hooks and the monitor find the factory at ~/.claude/factory.
mkdir -p "$HOME/.claude/skills"
if [ "$ROOT" != "$HOME/.claude/factory" ]; then
  if [ -e "$HOME/.claude/factory" ] && [ ! -L "$HOME/.claude/factory" ]; then
    echo "warning: ~/.claude/factory exists and is not a link to this checkout; skills will read that one"
  else
    ln -sfn "$ROOT" "$HOME/.claude/factory"
    echo "linked ~/.claude/factory -> $ROOT"
  fi
fi
for s in "$ROOT"/skills/*/; do
  name="$(basename "$s")"
  dest="$HOME/.claude/skills/$name"
  # A skill of yours with the same name stays; only our own earlier link is refreshed.
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    case "$(readlink "$dest" 2>/dev/null)" in
      "$ROOT"/skills/*|"$HOME"/.claude/factory/skills/*) ;;
      *) echo "kept your own skill /$name (not linked; remove $dest to use the factory's)"; continue ;;
    esac
  fi
  ln -sfn "${s%/}" "$dest"
  echo "linked skill /$name"
done

cat <<MSG

Next:
  1. Edit factory.json: owner, your repos (GitHub slug, local clone, ship mode), one target
  2. Rerun this script to create principles/<repo>.md for each repo, then fill them in (principles/common.md is shared)
  3. In each repo's CLAUDE.md, import the issue flow: @~/.claude/factory/issues.md
  4. Dry run: node bin/factory-tick.mjs --dry-run --verbose
  5. Start:   sh bin/install-launchd.sh 600   (or /factory-run start in Claude Code)
MSG

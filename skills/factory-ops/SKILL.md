---
name: factory-ops
description: Start an operator session on the local factory (GitHub issues to shipped work across the repos in ~/.claude/factory/factory.json, via a launchd tick and Claude Code workers). Loads how the factory works, runs a health check, and reports in a few plain lines, leading with anything that needs the owner. Use for "talking about factory", "let's talk factory", "factory ops", "/factory-ops", "how is the factory doing", or any back-and-forth about how the factory behaves, why an issue or PR is stuck, or changing the tick, dashboard or factory skills. For a scheduled read-only report use factory-monitor; for start/stop/tick use factory-run.
---

# factory-ops

You operate the owner's local factory (`owner.name` in `factory.json`). Everything it needs lives on this machine under `~/.claude/`. Never rely on
project memory or a pasted handoff: the state is in GitHub issues and `~/.claude/factory/state/`, and the knowledge
is in the files below.

## 1. Load

Read, in this order:

1. `~/.claude/factory/README.md`: layout, one pass, issue life.
2. `~/.claude/factory/factory.json` with a script that drops `notify.relay_webhook` first, if present. **Never
   print this file raw.** Note each repo's `base`, `ship` mode and `ship_why`, the targets (paused or not), the caps.
3. `~/.claude/factory/issues.md` and the principles files (`principles/common.md`, `principles/<repo>.md`): what
   workers decide alone, when they stop, how each repo ships.

## 2. Health check

Run these, then answer. Wait for `state/tick.lock` to clear before a dry run.

```sh
launchctl list | grep local.factory                     # tick, dashboard, monitor loaded
grep -v '^    at ' ~/.claude/factory/state/tick.log | tail -40 | cut -c1-220
cat ~/.claude/factory/state/monitor.md ~/.claude/factory/state/status.md
ls ~/.claude/factory/state/limit.json 2>/dev/null        # present = paused for the usage limit
gh api rate_limit --jq '.resources | {core: .core.remaining, graphql: .graphql.remaining}'
claude agents --json --all | python3 -I -c "import json,sys;[print(s.get('id'),s.get('pid') and 'alive' or 'dead',s['state'],s.get('status'),s['cwd'].split('/')[-1]) for s in json.load(sys.stdin) if 'worktrees' in s.get('cwd','')]"
```

For each live worker, read the last few assistant turns of its transcript (section 5) and `git log` in its
worktree against the repo's `base`. For a push repo, check what landed on the base branch; for a PR repo, the
open factory PRs (`curl -s -m 120 http://127.0.0.1:7788/api/state`).

Report in at most 8 lines: loop alive, workers busy or stuck, limit pause, new parks, stuck PRs. Lead with what
needs the owner's call. Describe issues in plain words, with links, not bare numbers.

## 3. How to talk to the owner

- Short, plain words. No code unless they ask.
- Ask before outward actions: comments on other people's issues or PRs, posts, messages. Issue labels and factory
  config changes are fine when they ask for them.
- Back-and-forth before planning a big change. Give a recommendation, not a survey.
- A gap you find gets a GitHub issue in the repo it belongs to. A stuck PR or worker gets surfaced, never silently
  waited on.

## 4. Changing the factory

- `~/.claude/factory/` is a git checkout. Another session may have uncommitted edits there: commit only the files
  you changed, by path, then push if the owner keeps a remote for it. Then `node --check` the file.
- After editing `lib/common.mjs` or the dashboard: `launchctl kickstart -k gui/$(/usr/bin/id -u)/local.factory-dashboard`, then check `/api/state`.
- Verify a tick change with `node ~/.claude/factory/bin/factory-tick.mjs --dry-run --verbose`, then watch the next
  real tick in `state/tick.log`.
- A new durable fact goes into the README, the repo's principles file (repo-specific facts), or this skill (how to
  operate). Never into memory or a handoff.

## 5. Gotchas

- **GitHub's GraphQL budget is 5,000 points an hour, shared** by the tick, the dashboard, the monitor, every worker
  and every interactive session on the `gh` login. When it runs out the tick fails with "API rate limit already
  exceeded" until the reset; that is not a code bug. Check who spends it before adding a poll. A dashboard refresh
  costs about 28 points.
- `claude agents`: `state: "blocked"` with no pid is a dead leftover. Alive and idle is normal for about an hour
  after a turn. A permission prompt shows in `claude logs <id>` (strip ANSI, grep "Do you want to proceed").
- A worker's transcript is `~/.claude/projects/<cwd with every non-alphanumeric character as ->/<sessionId>.jsonl`.
  The directory name starts with `-`, so pass it to `ls` as `./-Users-...`. A busy session whose last entry is an old
  `tool_use` is waiting on a command; look at its child processes before calling it stuck.
- Workers share the machine's CPU with each other and with the owner's own sessions. At a high load average, timing tests
  fail and workers spend their time on stress runs; fewer slots (`workers.max_concurrent`) can finish sooner.
- The tick never wakes a busy session. "Force a tick" on a PR whose babysit is already running does nothing; check
  what that session is doing instead.
- The factory sees only issues a target selects (its `batch` parent and/or `labels`). Adding `factory: ready`
  yourself skips triage. The triage verdict is written once.
- The Mac sleeps, and no ticks run then. That is not a fault.
- Ad hoc query:
  `cd ~/.claude/factory && node --input-type=module -e "import { loadConfig } from './lib/common.mjs'; loadConfig(); …"`.

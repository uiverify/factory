---
name: factory-run
description: Operate the local factory in plain words. "start" installs the 10-minute tick and the dashboard and runs a first tick; "stop" removes them; "status" shows targets, workers, parked tickets and the last tick; "tick" runs one pass now; "pause <target>" / "resume <target>" flips a target; "add target" edits factory.json. Use for "/factory-run", "start the factory", "stop the factory", "factory status", "is the factory running", "run a tick now".
argument-hint: start | stop | status | tick [--dry-run] | pause <target> | resume <target> | add target
---

# factory-run

Everything lives in `~/.claude/factory/` (a link to the factory checkout made by `bin/setup.sh`: config `factory.json`, `bin/`, `state/`, `README.md`). Never ask the user to type a node command; run it for them and report in plain words.

## start

1. Check `~/.claude/factory/factory.json` exists (missing: run `sh ~/.claude/factory/bin/setup.sh` first) and `~/.claude/factory/.env` has `LINEAR_API_KEY`. Missing → tell the user exactly where to create one (Linear → Settings → Security & access → Personal API keys) and stop.
2. `node ~/.claude/factory/bin/factory-tick.mjs --dry-run` → summarize what it would do per target (counts, how many it would triage or dispatch). Anything failing → fix or report, do not install.
3. `sh ~/.claude/factory/bin/install-launchd.sh 600` → tick every 10 minutes, dashboard kept alive at http://localhost:7788, monitor every 30 minutes.
4. `node ~/.claude/factory/bin/factory-tick.mjs` once now. Report: targets, triaged, dispatched, parked. Then `open http://localhost:7788`.
5. One line on how to watch: dashboard, `claude agents`, `~/.claude/factory/state/tick.log`; and how they get pinged (a macOS banner, plus the `notify.relay_webhook` message if one is set, when a ticket is parked; answer as a Linear comment).

## stop

`sh ~/.claude/factory/bin/install-launchd.sh --remove`. Running workers keep running until they finish their turn; say so. Offer `claude agents` to stop individual ones.

## status

Read `~/.claude/factory/state/last-tick.json`, `state/status.md`, the last 15 lines of `state/tick.log`, and `claude agents --json --all` filtered to the worktrees dir. Report targets, busy workers, in review, parked (with the question), and whether the launchd agents are loaded (`launchctl print gui/$(id -u)/ai.uiverify.factory-tick` exit code).

## tick

`node ~/.claude/factory/bin/factory-tick.mjs [--dry-run] --verbose` and summarize the log lines it printed.

## pause / resume

Set `"paused": true|false` on the named target in `factory.json` (the tick skips paused targets). Report.

## add target

Ask for project, optional milestone, one-sentence scope rule, max in flight (default 3). Append to `targets` in `factory.json`. Run a dry tick for `--only=<name>` and report the counts.

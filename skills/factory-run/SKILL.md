---
name: factory-run
description: Operate the local factory (GitHub issues → shipped work, across every repo in ~/.claude/factory/factory.json) in plain words. "start" installs the 10-minute tick, the dashboard and the monitor and runs a first tick; "stop" removes them; "status" shows targets, workers, parked issues and the last tick; "tick" runs one pass now; "pause <target>" / "resume <target>" flips a target; "add target" adds one (repo + batch or labels + scope rule); "add repo" adds a repo. Use for "/factory-run", "start the factory", "stop the factory", "factory status", "is the factory running", "run a tick now", "add this to the factory".
argument-hint: start | stop | status | tick [--dry-run] | pause <target> | resume <target> | add target | add repo
---

# factory-run

Everything lives in `~/.claude/factory/` (config `factory.json`, `bin/`, `state/`, `README.md`, the shared issue flow `issues.md`). Never ask the user to type a node command; run it for them and report in plain words.

## start

1. `gh auth status` must show a logged-in account with `repo` scope (the factory acts as that account); `claude agents --json` must run. Either failing → say exactly what to do and stop.
2. At least one target unpaused, or ask which to start (recommend the one just discussed).
3. `node ~/.claude/factory/bin/factory-tick.mjs --dry-run --verbose` → summarize per target what it would triage and dispatch. Anything failing → fix or report, do not install.
4. `sh ~/.claude/factory/bin/install-launchd.sh 600` → tick every 10 minutes, dashboard at http://localhost:7788, monitor every 30 minutes.
5. `node ~/.claude/factory/bin/factory-tick.mjs` once now. Report: targets, triaged, dispatched, parked. Then `open http://localhost:7788`.
6. One line on how to watch (dashboard, `claude agents`, `~/.claude/factory/state/tick.log`) and how the owner gets pinged (a macOS banner, and the relay webhook when set, when an issue parks or a PR is green; they answer with a comment on the issue).

## stop

`sh ~/.claude/factory/bin/install-launchd.sh --remove`. Running workers keep running until they finish their turn; say so. Offer `claude agents` to stop individual ones.

## status

Read `state/last-tick.json`, `state/status.md`, the last 15 lines of `state/tick.log`, and `claude agents --json --all` filtered to the repos' worktrees dirs. Report targets per repo, busy workers, in review, parked (with the question), and whether the launchd agents are loaded (`launchctl print gui/$(id -u)/local.factory-tick` exit code).

## tick

`node ~/.claude/factory/bin/factory-tick.mjs [--dry-run] --verbose` and summarize the log lines it printed.

## pause / resume

Set `"paused": true|false` on the named target in `factory.json` (the tick skips paused targets). Report.

## add target

A target is one repo plus a selection of its issues. Ask only what the conversation hasn't settled:
- `repo`: a key of `repos` (add the repo first if it's new).
- `batch` (a parent issue number: its sub-issues) and/or `labels` (all must be present). A project is usually a batch parent; `/factory-project` creates one.
- `scope_rule`: one sentence on what this target does not do, ending "If unsure, 'later'."
- `max_in_flight` (default 2), and for PR repos `max_awaiting_review` (default 5). New targets start `"paused": true` unless the owner says start.

Append it to `targets`, run `--dry-run --only=<name>` and report the counts.

## add repo

Add an entry to `repos`: `github` slug, `path` (the main local clone, a directory Claude already trusts), `worktrees_dir` (default `<path>/.claude/worktrees`), `remote`, `base`, `branch_prefix` (e.g. `factory/`), `setup` (install command), `ship` (`push` when the repo's CLAUDE.md lands changes straight on its base branch, `pr` when it ships through PRs), `ship_why` (one line every worker prompt repeats), `principles` (default `principles/<repo>.md`; start it from `principles/TEMPLATE.md`: ship mode, when to park, repo-specific hard rules, pointing at the repo's CLAUDE.md rather than restating it). Then add a backlog section to the repo's `CLAUDE.md` that imports the issue flow: `@~/.claude/factory/issues.md`, plus the repo's own `stream:` labels.

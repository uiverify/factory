---
name: factory-monitor
description: Check that the local factory is doing what it should and say plainly what is wrong. Reads the tick log, the dashboard state, every open factory PR, every worker session, the queue and the parked issues across every repo in ~/.claude/factory/factory.json, then writes state/monitor.md and notifies the owner only about new problems. Read-only. Runs every 30 minutes from launchd (`headless`), or by hand. Use for "/factory-monitor", "check the factory", "is the factory ok", "why isn't the factory doing anything", "watch the factory".
argument-hint: "[headless]"
---

# factory-monitor

The factory lives in `~/.claude/factory/` (`factory.json`, `bin/`, `lib/common.mjs`, `state/`, `issues.md`). The tick (`bin/factory-tick.mjs`, every 10 min) is the control loop. Workers and babysit run as `claude --bg` sessions in `<repo path>/.claude/worktrees/factory-<issue>` for each repo in `factory.json`. A repo ships either by pushing to its `base` branch (`"ship": "push"`) or through PRs the owner merges (`"ship": "pr"`); a target can instead collect its issues on one long-lived branch that ends in one PR (`"ship": "branch"`). The owner is `owner.name` in `factory.json`. The goal of this skill is to catch the loop silently doing nothing: a PR green for hours that nobody told the owner about, a worker "busy" that had finished, an issue labelled `factory: working` that nobody works on.

**Read-only.** Do not merge, push, comment, relabel issues, edit factory code or config, or restart anything. Find the problem, show the evidence, name the fix. In an interactive session, offer the fix and wait for the owner. Never print secrets from `.env`.

## 1. Gather

Run these. Do not stop at the first problem.

- Loop health: `launchctl list | grep local.factory`, `cat state/last-tick.json`, `tail -80 state/tick.log`, `tail -20 state/local.factory-tick.err.log`.
- Dashboard state (it already joins GitHub and sessions): `curl -s -m 90 http://127.0.0.1:7788/api/state`. Save it to a temp file and read it with `python3 -I`; it is large. If the dashboard is down, that is finding #1. Key fields: `streams[].{repo, ship, working, ci_failing, changes, waiting_you, checks_running, open, needs_you, queued, blocked, decide, human, untriaged, in_flight, max_in_flight, awaiting_review, max_awaiting_review}`, each PR's `bucket`, `checks.failing`, `merge_state`, `review`; each package's `session`, `started_at`, `last_babysit`, `restarts`; top-level `needs_you`, `sessions`, `orphan_sessions`.
- Sessions: `claude agents --json --all`, filtered to cwd under a repo's worktrees dir. `status` (busy|idle) is the truth for a live session; `state: working` alone does not mean busy.
- What an agent last said: the newest `.jsonl` under `~/.claude/projects/<worktree path with every non-alphanumeric character as ->/`. Read the last 3 assistant text blocks and the last few tool calls with `python3 -I` (never cat the file).
- One issue or PR in detail when needed: `gh issue view <n> -R <repo> --comments`, `gh pr view <N> -R <repo> --json state,mergeStateStatus,reviewDecision,statusCheckRollup,comments`, `gh pr checks <N> -R <repo>`.

## 2. Check

Times are relative to now.

**A paused target is out of scope.** Skip its issues, PRs and parked questions entirely: never list them under Waiting on the owner and never notify about them (paused means not now). Only name it in one line under Moving if a worker of it is still busy.

**Loop**
- `local.factory-tick` and `local.factory-dashboard` loaded; last tick under 15 min ago. Otherwise BROKEN.
- `tick failed`, `claude CLI is not reachable`, or the same `triage failed` / `dispatch failed` line 3+ ticks in a row: BROKEN. The log cuts errors at 300 chars: rerun the failing call by hand to get the real error (for triage: `cd <repo path> && claude -p --model sonnet "/factory-triage <repo>#<n>"`), unless it is obviously an outage that already recovered.

- The same `push of <branch> for <issue> failed` or `merge of <issue> into <branch> failed` line on 3+ ticks in a row: STUCK, and name the branch (a branch-mode target dispatches nothing until it pushes). On a merge conflict the tick wakes a resolver session (`resolve the <branch> merge conflict`, up to 2 attempts) and then parks with a notify; no such line after a conflict, or a non-conflict failure repeating (auth, network): BROKEN. One unresolved conflict can freeze a branch-mode target silently for hours.

**Each open factory PR (PR repos)**
- Green and mergeable (`waiting_you`): the owner's call. The tick should have logged `notify: Factory PR ready for you to merge` for its head. No such line: BROKEN. Notified: WAITING ON THE OWNER, with age; repeat it past 24 h.
- CI failing: babysit should have woken after the failure and fixed it or called it a flake and rerun it. Failing 60+ min with no babysit since: STUCK. Same check failing 3+ times: say which and what the agent said.
- `merge_state` DIRTY or BEHIND, or changes requested, for 30+ min: babysit should rebase or answer. STUCK if not.
- A PR open but its issues still labelled `factory: working`: the tick should have moved them to `factory: in review`. STUCK.

**Workers**
- A package labelled `factory: working`: its session should be busy, or its lease still running. Session idle or gone and lease expired, with no `resume ... worker` in the log: STUCK. `restarts` equal to `workers.max_restarts`: one more death parks it; say so.
- Push repos: an issue the worker said it shipped (`FACTORY: shipped`) still open 30+ min later: the commit lacked `Fixes #n` and the worker didn't close it. STUCK.
- Busy session whose transcript has not changed for 45+ min: probably hung. STUCK, quote its last tool call.
- Orphan sessions still busy: worth a line.

**Queue**
- Slots free, review cap not hit, `queued` not empty, but no `dispatch` in the last 2 ticks: STUCK. Read the tick's dispatch logic for why.
- `blocked` issues whose blockers are closed: GitHub relation stale. One line each.

**Humans**
- `needs_you`: parked issues, with age. Over 4 h: repeat it.
- `decide` and `human` issues: count only, unless one is `priority: high`.

## 3. Report

Write `~/.claude/factory/state/monitor.md` (overwrite):

```
# Factory monitor <ISO time>
Verdict: OK | <n> broken, <n> stuck, <n> waiting on the owner

## Broken
- [broken:<stable-key>] <what, where (repo#issue / PR / session), since when>. Evidence: <log line / agent quote>. Fix: <what>.
## Stuck
...
## Waiting on the owner
- <repo>#<N> <title>: <why> for <age>
## Moving
- one line per package that is progressing normally
```

End the file with `Last notified: <ISO time or never>`, carried over from the previous report unless this run notifies.

**Headless** (`headless` in the arguments): read the previous `state/monitor.md` before overwriting it. Notify only when there is a Broken or Stuck key that was not in the previous report, or a waiting-on-the-owner item is over 4 h old and the previous `Last notified` is over 4 h ago. Notify with a macOS banner that opens the most urgent item: `terminal-notifier -title Factory -subtitle "<first new line>" -message "<count> new problem(s)" -open <url> -sound default`, falling back to `osascript -e 'display notification "<count> new problem(s)" with title "Factory" subtitle "<first new line>"'` when terminal-notifier is missing. When `notify.relay_webhook` in `factory.json` is set, also POST `{"text": "Factory monitor: <new lines> Dashboard: http://localhost:7788"}` to it (read it with `python3 -I`, never echo it). Nothing new: no notification. End with the verdict line.

**Interactive**: print the report in chat, Broken and Stuck first, each with its fix, and offer to apply the fixes. Do not apply them unasked.

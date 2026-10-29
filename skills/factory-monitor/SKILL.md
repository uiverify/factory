---
name: factory-monitor
description: Check that the local factory is doing what it should and say plainly what is wrong. Reads the tick log, the dashboard state, every open factory PR (approval, verdict, CI, what babysit last said), every worker session, the queue and the parked tickets, then writes state/monitor.md and notifies the owner only about new problems. Read-only. Runs every 30 minutes from launchd (`headless`), or by hand. Use for "/factory-monitor", "check the factory", "is the factory ok", "why isn't the factory merging", "watch the factory".
argument-hint: "[headless]"
---

# factory-monitor

The factory lives in `~/.claude/factory/` (`factory.json`, `bin/`, `lib/`, `state/`). The tick
(`bin/factory-tick.mjs`, every 10 min) is the control loop. Workers and babysit passes run as `claude --bg`
sessions in `<repo.worktrees_dir>/<KEY>` (default `<repo.path>/.claude/worktrees/<KEY>`). Rules for verdicts and
reviewers: the principles file (`principles_file` in `factory.json`), section 7. The goal of this skill is to catch the loop silently doing nothing, which is
how every past failure looked: a PR approved and green for hours, a worker "busy" that had finished, a ticket
In Progress that nobody works on.

**Read-only.** Do not merge, push, comment, move tickets, request reviewers, edit factory code or config, or
restart anything. Find the problem, show the evidence, name the fix. In an interactive session, offer the fix
and wait for the owner. Never print `LINEAR_API_KEY` or the relay webhook URL.

## 1. Gather

Run these. Do not stop at the first problem.

- Loop health: `launchctl list | grep ai.uiverify.factory`, `cat state/last-tick.json`, `tail -80 state/tick.log`,
  `tail -20 state/ai.uiverify.factory-tick.err.log`.
- Dashboard state (it already joins Linear, GitHub and sessions): `curl -s -m 90 http://127.0.0.1:7788/api/state`.
  Save it to a temp file and read it with `python3 -I`; it is large. If the dashboard is down, that is finding #1.
  Key fields: `streams[].{working, ci_failing, waiting_you, waiting_human, approved_soon, checks_running, open,
  needs_you, queued, blocked, manual, in_flight, max_in_flight, awaiting_review, max_awaiting_review}`, each PR's
  `bucket`, `checks.failing`, `review`, `approved_by`, `verdict.{kind,reason}`,
  `auto_merge`, `merge_state`, `reviewers_requested`, `waiting_since`, `created_at`; each package's `session`,
  `started_at`, `last_babysit`, `restarts`; top-level `needs_you`, `waiting_you`, `sessions`, `orphan_sessions`.
- Sessions: `claude agents --json --all`, filtered to cwd under the worktrees dir. `status` (busy|idle) is the
  truth for a live session; `state: working` alone does not mean busy.
- What an agent last said: newest `.jsonl` under `~/.claude/projects/<the worktree's absolute path with every / and . replaced by ->/`.
  Read the last 3 assistant text blocks and the last few tool calls with `python3 -I` (never cat the file). Also
  `<worktree>/.context/babysit-pr-<N>.md` when it exists: babysit's own state (verdicts, reviewers, flakes).
- One PR in detail when needed: `gh pr view <N> --json state,mergeStateStatus,reviewDecision,reviews,autoMergeRequest,statusCheckRollup,comments`
  and `gh pr checks <N>`.

## 2. Check

For each check, the expected behavior and what counts as a finding. Times are relative to now.

**Loop**
- Both `ai.uiverify.factory-tick` and `ai.uiverify.factory-dashboard` loaded; last tick under 15 min ago. Otherwise BROKEN.
- `tick failed`, `claude CLI is not reachable`, or the same `triage failed` / `dispatch failed` line 3+ ticks in a
  row. BROKEN. The log cuts errors at 300 chars: rerun the failing call by hand (for triage:
  `cd <repo.path> && claude -p --model sonnet "/factory-triage <KEY>"`) to get the real error, unless it is
  obviously an API outage that already recovered.

**Each open factory PR**: decide who should act next, then check they are acting.
- Approved, verdict `auto`, checks green: it should be merging. A single PR on `main` needs `auto_merge` armed; a
  stack merges through babysit's `gh stack merge`. Still open 30+ min after it became mergeable: STUCK. Look at
  `last_babysit`, whether the tick logged `babysit <KEY>` since the approval, and what the babysit session last
  said (did it plan to merge, and why didn't it?).
- Approved only by a trusted review bot (`merge.trusted_bot_reviewers`), verdict `hold`: the owner's call (`waiting_you`). The tick should have logged
  `notify: Factory hold needs your call (<KEY>)` within a tick of the approval. No such line: BROKEN. Pinged:
  WAITING ON OWNER, with age.
- Not approved: someone must be requested. No `reviewers_requested`: BROKEN (babysit should have requested the
  target's `reviewers` from `factory.json`). Requested: WAITING ON <login>, with age; flag over 24 h.
- CI failing: babysit should have woken after the failure and either fixed it or called it a flake and rerun it.
  Failing 60+ min with no babysit since: STUCK. Same check failing 3+ times: say which and what the agent said.
- `merge_state` DIRTY or BEHIND for 30+ min: babysit should rebase. STUCK if not. GitHub checks a PR in a stack
  against `main`, so test with `git merge-tree --write-tree origin/main <head>`, not against its base. Never
  accept "the flag is stale" from babysit or from yourself.
- PR open but its ticket is still In Progress: the tick's step 3 should have moved it to In Review. STUCK.

**Workers**
- A claimed In Progress ticket with no PR: its session should be busy, or its lease still running. Session idle or
  done and lease expired, with no `resume dead worker` in the log: STUCK. `restarts` equal to
  `workers.max_restarts`: one more death parks it; say so.
- Busy session whose transcript has not changed for 45+ min: probably hung (a stalled codex run, a Monitor waiting
  on nothing). STUCK, quote its last tool call.
- Orphan sessions (`orphan_sessions`) still busy: worth a line.

**Queue**
- Slots free (`in_flight < max_in_flight`), review cap not hit, and `queued` not empty, but no `dispatch` in the
  last 2 ticks: STUCK. Read the tick's dispatch logic for why (blockers, stack base).
- `blocked` tickets whose blockers are In Progress with no factory claim and no open PR: likely an
  integration-moved ticket. STUCK.
- `manual` (In Progress, not factory) tickets with no open PR: nobody is working on them. One line each.

**Humans**
- `needs_you`: parked tickets, with age. Over 4 h: repeat it.
- Merged PRs whose ticket is not Done 30+ min later: drift, one line.

## 3. Report

Write `~/.claude/factory/state/monitor.md` (overwrite):

```
# Factory monitor <ISO time>
Verdict: OK | <n> broken, <n> stuck, <n> waiting on humans

## Broken
- <one line: what, where (PR/ticket/session), since when> . Evidence: <log line / agent quote>. Fix: <what>.
## Stuck
...
## Waiting on humans
- #<N> <title>: waiting on <who> for <age> (<why>)
## Moving
- one line per package that is progressing normally
```

End the file with `Last notified: <ISO time or never>`, carried over from the previous report unless this run sends one.

Give each Broken/Stuck line a stable key in brackets at the start, e.g. `[stuck:pr-123-merge]`, so runs can be
compared.

**Headless** (`headless` in the arguments): read the previous `state/monitor.md` before overwriting it. Notify the
owner only when there is a Broken or Stuck key that was not in the previous report, or a `needs_you` / `waiting_you`
item is over 4 h old and the previous `Last notified` is over 4 h ago. When `notify.relay_webhook` in `factory.json` is set, POST `{"text": "<message>"}` to it
(read it with `python3 -I`, never echo it). A Slack incoming webhook works as is. The message: `Factory monitor:` then the new lines only, then
`Dashboard: http://localhost:7788`. In the message, every PR is a Slack-style link `<PR url|#N title>`
and every ticket `<ticket url|KEY title>`; a webhook posts text verbatim, so a bare `#N` is not clickable.
With each message, also show a macOS banner that opens the most urgent item on click:
`terminal-notifier -title Factory -subtitle "<first new line, plain text>" -message "<count> new problem(s)" -open <PR or ticket URL> -sound default`.
Nothing new: no message, no banner. End with the verdict line.

**Interactive**: print the report in chat, Broken and Stuck first, each with its fix, and offer to apply the
fixes. Do not apply them unasked.

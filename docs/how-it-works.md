# How the factory works

The detail behind the [README](../README.md).

## How it works

```
                launchd (macOS)
   ┌──────────────┬──────────────────┬───────────────────────┐
   │ every 10 min │ always on        │ every 30 min          │
   ▼              ▼                  ▼
factory-tick   factory-dashboard   claude -p /factory-monitor headless
(node)         (node, :7788)       (Sonnet, read-only, notifies on new problems)
   │
   │ reads/writes            reads                 starts / wakes
   ├──────────────► Linear   ├──► GitHub (gh)      ├──► claude --bg  (workers, babysit passes)
   │                         │                     └──► claude -p    (triage, plan; JSON out)
   └── state/ (tick.log, status.md, last-tick.json, signals.json, tick.lock)
```

- **The tick** (`bin/factory-tick.mjs`) does one pass and exits. A lock file stops two passes from overlapping. Every shell call has a 2 minute timeout, so a call that hangs after the Mac sleeps fails that tick instead of freezing the loop.
- **Workers** are background Claude sessions (Opus by default) that run `/factory-auto <ticket keys>` in their own git worktree on a branch named `<branch_prefix><key>`.
- **The babysit pass** is the same worker session, woken with `/factory-auto babysit <PR>` whenever its PRs change. One pass fixes CI and review comments, computes a merge verdict, merges when the rules allow, and ends.
- **Triage and planning** are short headless `claude -p` runs on Sonnet that return JSON against a schema the tick passes in.
- **The dashboard** (`bin/factory-dashboard.mjs`) is a zero-dependency page on `127.0.0.1:7788`: PRs grouped by who should act next, parked questions, agents, recent merges and the tick log. `/api/state` serves the same data as JSON.
- **The monitor** (`skills/factory-monitor`) is a read-only Sonnet run every 30 minutes that looks for the ways the loop fails quietly: a PR approved and green for hours, a "busy" worker that had finished, a ticket In Progress that nobody works on.

### A ticket's life

```
Backlog ──triage──► Todo ──dispatch──► In Progress ──PR opened──► In Review ──merged──► Done
   │                                       │                         │
   └─ split / decide / later (labels)      └──────── parked: "Needs Info" label + question comment
                                                     a human reply on the ticket resumes the worker
```

A **target** in `factory.json` is a Linear project plus an optional milestone, with a one-sentence **scope rule** that says what the target does not do. The tick only looks at tickets inside a target.

1. **Triage (Backlog to Todo).** `factory-triage` reads the ticket, the project documents, the scope rule and the principles file, and returns one verdict: `ready` (moves to Todo, with a `## Verify` checklist written into the description), `split` (files sub-tickets), `decide` (a product fork; leaves one comment with options), or `later` (out of scope).
2. **Dispatch (Todo to In Progress).** Ready tickets are sorted by priority, then age. `factory-plan` groups related tickets into **packages**, each one PR stack built by one worker. Each package gets a worktree and a worker, within the caps.
3. **Build (In Progress to In Review).** The worker runs `/factory-auto`, opens the PR or stack (title carries the ticket key, body says `Fixes <KEY>`), runs one babysit pass and ends.
4. **Review and merge (In Review to Done).** The babysit pass owns review and merge, following the merge rules in your principles file. When every PR of a package is closed, the tick removes the worker session and the worktree.

A worker that hits something it must not decide alone **parks**: one question comment on the ticket, the `Needs Info` label, and the session ends. You get a banner (and a webhook message if you set one). Answer with a comment on the ticket, and the next tick resumes the worker with your answer.

With `build_on_unmerged: true`, a ticket whose only open blockers are factory packages already in review starts right away, stacked on the blocker's top PR.

### One tick, in order

For each target that is not paused:

1. Clean up closed tickets: remove the finished session and worktree.
2. Parked tickets: resume on a human reply, or notify once.
3. Undo Linear's GitHub integration moving a ticket to In Progress just because a factory PR mentioned it.
4. Dead workers (no session, no PR, lease expired): resume, and after `max_restarts` park with a question.
5. Wake the babysit pass for packages whose PR signals changed (head, checks, reviews, comments, labels, merge state, parent branch), or on a heartbeat. A red or conflicting PR is retried after 1 h, 2 h, 4 h, capped at the heartbeat.
6. Triage up to 20 untriaged Backlog tickets.
7. Dispatch new packages within `workers.max_concurrent`, the target's `max_in_flight`, and its `max_awaiting_review`.

`--dry-run` logs every action without doing it. `--verbose` adds detail. `--only=<target>` limits the pass to one target.

## Configuration

`factory.json` (start from `factory.example.json`). Paths may start with `~`; relative paths are relative to the factory checkout.

| Key | Meaning |
|---|---|
| `owner.name`, `owner.linear_mention` | who parked questions are addressed to, e.g. `"Alex"` and `"@alex"` |
| `repo.path`, `remote`, `base` | the main checkout that worker worktrees branch from |
| `repo.worktrees_dir` | where worker worktrees go. Default `<repo.path>/.claude/worktrees`. Must be inside a directory Claude Code trusts, or `claude --bg` will not start there |
| `repo.branch_prefix` | e.g. `factory/`. The factory recognizes its own PRs by this prefix |
| `repo.setup` | a command run once in each new worktree, e.g. installing dependencies |
| `linear.team`, `linear.states.*` | the team key and your status name for each role |
| `linear.needs_human_label`, `linear.triage_labels` | the park label and the optional triage labels |
| `targets[]` | `name`, `project`, `milestone`, `scope_rule`, `max_in_flight`, `max_awaiting_review`, `build_on_unmerged`, `reviewers` (GitHub logins to request), `paused`, `runtime: "local"`, optional `links` (label to URL, shown on the dashboard) |
| `workers` | `max_concurrent`, `model`, `effort`, `claude_args`, `env`, `lease_minutes`, `max_restarts` |
| `triage`, `planner` | on or off, model, batch sizes |
| `babysit` | on or off, `heartbeat_hours`, `command` (the skill call that runs one babysit pass) |
| `merge.trusted_bot_reviewers` | logins of review bots whose approval counts toward GitHub's floor. Empty means every merge needs a human approval |
| `notify.relay_webhook` | optional URL that receives `{ "text": ... }` when a ticket parks or a hold needs you. A Slack incoming webhook works |
| `dashboard.port` | default 7788 |
| `principles_file`, `tick.state_dir`, `tick.lock_stale_minutes` | paths and lock staleness |

## The principles file

`principles/TEMPLATE.md` is a documented template with examples. Its sections are what workers read and what the skills refer to:

1. what workers decide alone and record,
2. the only reasons to stop, and how to stop,
3. user experience defaults,
4. architecture defaults,
5. scope,
6. design freeze,
7. merge rules: the floor GitHub enforces, when a PR is `auto` and when it is `hold`,
8. the metrics the factory reports.

The fastest way to write it: look at the questions your agents asked you last month. Every question you answered the same way twice is a rule.

## Watching it

- The dashboard at http://localhost:7788.
- `claude agents` for the fleet of sessions; `claude attach <id>` to look inside one.
- `state/tick.log`, `state/status.md`, `state/monitor.md`.

## Things to know

- Resuming a session with new flags makes Claude Code copy the conversation into a new session. The tick then removes the old one, so each worktree has one session.
- `claude agents` can report `state: working` for an idle session. The tick and the monitor trust `status: busy|idle` instead.
- If `claude` is not on launchd's PATH, the tick refuses to dispatch or wake anything and logs it. The installer bakes your PATH into the launchd agents, so rerun it after moving Node or Claude Code.
- A PR belongs to a ticket when the key is in the PR title or on a `Fixes/Closes/Resolves` line. A bare mention in the body does not count.
- The dashboard reads the first 100 PRs from each search, with no pagination.

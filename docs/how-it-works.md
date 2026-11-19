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
   ├──────────────► GitHub   ├──► transcripts      ├──► claude --bg  (workers, babysit passes)
   │  (issues, PRs, labels)  │   (live step,       └──► claude -p    (triage, plan; JSON out)
   │                         │    tokens, usage)
   └── state/ (tick.log, status.md, last-tick.json, signals.json, notified.json, limit.json, tick.lock)
```

- **The tick** (`bin/factory-tick.mjs`) does one pass over every repo with an active target and exits. A lock file stops two passes from overlapping. Every shell call has a 2 minute timeout, so a call that hangs after the Mac sleeps fails that tick instead of freezing the loop.
- **Workers** are background Claude sessions that run `/factory-auto <issues>` in their own git worktree (`<repo>/.claude/worktrees/factory-<lead>`, branch `<branch_prefix><lead>`). Each gets the repo's principles file, the issue flow, the ship mode and the exact line to end its session with.
- **The babysit pass** is the same worker session, woken with `/babysit-pr <PR>` when its PR's signals change. One pass fixes CI and answers review comments, then ends. The factory never merges unless you open a merge window (below); you merge.
- **Triage and planning** are short headless `claude -p` runs on Sonnet that return JSON against a schema the tick passes in.
- **The dashboard** (`bin/factory-dashboard.mjs`) is a zero-dependency page on `127.0.0.1:7788` with four pages. **Now**: what needs you (green PRs, parked questions, product forks) and a live Workers panel with each worker's step in the loop, context size, tokens, background agents, latest messages and an estimate of when it finishes. **History**: issues closed and PRs merged over time. **Targets**: each target's queue, plus a comparison of worker models on finished packages. **Usage**: the live weekly Claude allowance and the share each issue and each of your own sessions spent. `/api/state`, `/api/live` and `/api/usage` serve the same data as JSON.
- **The monitor** (`skills/factory-monitor`) is a read-only Sonnet run every 30 minutes that looks for the ways the loop fails quietly: a PR green for hours that nobody announced, a "busy" worker that had finished, an issue labelled `factory: working` that nobody works on.
- **Two hooks** ride along on every worker (`worker-settings.json`, passed as `--settings`): `factory-context-hook.mjs` asks a worker whose context passed 500k tokens to hand off at its next natural break, and `factory-stop-hook.mjs` kicks the tick right after a worker hands off, so the fresh session starts within a minute instead of at the next tick.

### An issue's life

```
untriaged ──triage──► factory: ready ──dispatch──► factory: working ──PR opened──► factory: in review ──merged──► closed
   │                                                    │                                │
   └─ split / decide / human / later (labels)           └─── parked: factory: needs info + a question comment
                                                             your reply comment on the issue resumes the worker
```

A **target** in `factory.json` names a repo and selects issues by a `batch` parent (its open sub-issues), by `labels` (all must be present), or both, with a one-sentence **scope rule** that says what the target does not do. The tick only looks at issues inside a target. A target that names a batch owns that batch: a labels-only target never takes its sub-issues.

1. **Triage.** `factory-triage` reads the issue, its batch, the scope rule and the principles, and returns one verdict: `ready` (with a `## Verify` checklist written into the body), `split` (makes it a batch with sub-issues), `decide` (a product fork; one comment with options), `human` (needs a step only you can do), or `later` (out of scope or a duplicate). It fills in a missing priority (never `high`), `stream:` label or kind.
2. **Dispatch.** Ready, unblocked issues are sorted by priority, then age. `factory-plan` groups related issues into **packages**, each built as one change by one worker. Each package gets a worktree and a worker, within the caps.
3. **Build.** The worker runs `/factory-auto`: the repo's `/factory` loop with no check-ins. It records every judgment call under **Decisions taken**, keeps the issue's state comment current and ends with the hand-off line.
4. **Ship.** Per the repo's `ship` mode: a PR (the tick moves the issues to `factory: in review`, wakes babysit on changes and tells you when it is green), a push to the base branch (the commit's `Fixes #n` closes the issue), or a commit on a long-lived branch (`ship: "branch"`). When every issue of a package is closed and no PR is open, the tick removes the worker session, the worktree and the factory labels.

A worker that hits something it must not decide alone **parks**: one `<!-- factory-question -->` comment on the issue, the `factory: needs info` label, and the session ends. You get a banner (and a webhook message if you set one). Answer with a comment on the issue, and the next tick resumes the worker with your answer. A package is parked only when every open issue in it waits on you; a worker that parks one issue of a batch carries on with the rest.

### One tick, in order

Once, before the repos: if any worker's last turn hit the Claude usage limit (or is retrying a 429), the tick writes `state/limit.json` and does no agent work (no dispatch, resume, wake or triage) until the limit resets. It tells you once per outage.

For each repo with an active target:

1. Create any missing `factory: *` labels.
2. Finished packages (every issue closed or moved to `later`, no PR open): remove the session and worktree, drop the factory labels. A branch-mode package is pushed first; a `land_on` package is merged into its shared branch. A merge conflict there gets up to two resolver sessions, then a question to you.
3. Parked issues: resume on a human reply, or notify once.
4. Working packages: a PR appeared → `factory: in review`. A dead session, an API error, a session that froze mid-turn or waited 60 minutes on a background job that never reports, or a clean handoff → resume. A crash counts against `max_restarts`, after which the package parks with a question; the usage limit, a handoff and a frozen request don't count.
5. In review: wake one babysit pass when something new needs the worker (a check that newly failed, a conflict, a review or comment, a base change), or on the heartbeat. A red or conflicting PR is retried after 1 h, 2 h, 4 h, capped at the heartbeat. A green, mergeable PR: tell you once per head commit. Every PR merged but an issue still open (a PR that did only part of it): the worker resumes and decides what is left.
6. Triage up to `triage.max_per_tick` untriaged issues.
7. Dispatch new packages within `workers.max_concurrent`, the target's `max_in_flight` and (PR repos) `max_awaiting_review`. With `stack: true`, an issue whose one open blocker has a single green PR starts on top of that PR's branch instead of waiting for the merge.
8. A branch-mode target with nothing left to build gets its one PR (or, with `pr_early`, a PR as soon as the branch has work).

`--dry-run` logs every action without doing it. `--verbose` adds detail. `--only=<target>` limits the pass to one target.

### Long sessions and handoffs

Every turn re-reads the whole context, so a worker that runs on from 500k tokens pays several times what a fresh one does for the same step. Before ending any turn that leaves the job waiting, a worker rewrites `.context/handoff.md` in its worktree for a successor with no context. A wake (a babysit, your answer) on an idle conversation over 200k tokens starts a fresh session from that handoff instead of resuming the big one. These thresholds are constants at the bottom of `lib/common.mjs`.

## Configuration

`factory.json` (start from `factory.example.json`). Paths may start with `~`; relative paths are relative to the factory checkout.

| Key | Meaning |
|---|---|
| `owner.name`, `owner.github` | who workers and questions address, and the login @-mentioned on a stalled package |
| `repos.<name>.github`, `path`, `remote`, `base` | the GitHub slug and the main local clone worker worktrees branch from (required), its remote (default `origin`) and base branch (default `main`) |
| `repos.<name>.worktrees_dir` | where worker worktrees go. Default `<path>/.claude/worktrees`. Must be inside a directory Claude Code trusts, or `claude --bg` will not start there |
| `repos.<name>.branch_prefix` | default `factory/`. The factory recognizes its own PRs by this prefix |
| `repos.<name>.setup` | a command run once in each new worktree, e.g. installing dependencies |
| `repos.<name>.ship`, `ship_why` | `pr` or `push`, and the one-line reason every worker prompt repeats |
| `repos.<name>.principles` | the repo's principles file. Default `principles/<name>.md` |
| `repos.<name>.worker_model`, `worker_effort` | the model and `--effort` this repo's workers run on (falls back to `workers.*`) |
| `repos.<name>.plugins` | the Claude Code plugins workers keep enabled (by name or `name@marketplace`); every other plugin you have enabled is turned off for workers, since each plugin's skill listing costs every session tokens |
| `repos.<name>.merge_window` | optional `{ "until": ISO, "why", "not" }`: until then, babysit may squash-merge a PR that is green, reviewed and up to date, except what `not` describes |
| `targets[]` | `name`, `repo`, `batch` and/or `labels`, `exclude_labels`, `scope_rule`, `max_in_flight`, `max_awaiting_review`, `stack`, `design` (a folder of flows and wireframes handed to every worker), `paused` |
| `targets[]` overrides | `ship`, `ship_why`, `worker_model`, `worker_effort`, `plugins`: a project inside a repo can run differently from the rest of it |
| `targets[]` branch mode | `ship: "branch"`, `branch`, `pr_title`, `pr_early`: issues land one at a time as commits on one long-lived branch in one worktree; the tick pushes it and opens one PR. `land_on: "<branch>"` on another target collects that target's work onto the same branch |
| `workers` | `max_concurrent`, `model`, `effort`, `claude_args`, `settings` (the hooks file), `env`, `lease_minutes`, `max_restarts` |
| `triage`, `planner` | on or off, model, batch sizes, `planner.max_package` |
| `babysit` | on or off, `heartbeat_hours` |
| `notify.desktop`, `notify.relay_webhook` | macOS banners (clickable with `terminal-notifier`), and an optional URL that receives `{ "text": ... }` when an issue parks or a PR is green. A Slack incoming webhook works |
| `usage.ticket_alert_percent` | an issue that spent this share of the weekly allowance shows red on the Usage page. Default 3 |
| `issues_doc`, `tick.state_dir`, `tick.lock_stale_minutes`, `tick.sweep_agent_worktrees` | paths, lock staleness, and whether to remove clean subagent worktrees older than 3 days |

`.env` (optional): `KEY=value` lines loaded into the tick's environment, and so into every worker. GitHub access is your `gh` login.

## The principles files

Workers read `principles/common.md` (shared by every repo), then the repo's own `principles/<repo>.md`, then the repo's `CLAUDE.md`. `common.md` says:

1. what workers decide alone and record,
2. the only reasons to stop, and how to stop,
3. scope: what gets fixed in place and what becomes its own issue,
4. what to do when design or review rounds keep finding holes,
5. the metrics the factory reports.

The repo file (`principles/TEMPLATE.md` is the starting point) says how that repo ships, what waits for you, when to park, and the hard rules a worker must not bend. The fastest way to write it: look at the questions your agents asked you last month. Every question you answered the same way twice is a rule.

[`issues.md`](../issues.md) is the issue flow itself: how to write, label, batch, close and defer an issue, and the factory's labels and marker comments. Import it from each repo's `CLAUDE.md` so interactive sessions follow it too.

## Watching it

- The dashboard at http://localhost:7788.
- `claude agents` for the fleet of sessions; `claude attach <id>` to look inside one.
- `state/tick.log`, `state/status.md`, `state/monitor.md`.
- `/factory-ops` in Claude Code for a health check and a conversation about what the factory is doing.

## Things to know

- Resuming a session with new flags makes Claude Code copy the conversation into a new session. The tick then removes the old one, so each worktree has one session.
- `claude agents` can report `state: working` for an idle session. The tick and the monitor trust `status: busy|idle` instead.
- If `claude` is not on launchd's PATH, the tick refuses to dispatch or wake anything and logs it. The installer bakes your PATH into the launchd agents, so rerun it after moving Node or Claude Code.
- GitHub's GraphQL budget (5,000 points an hour) is shared by the tick, the dashboard, the monitor, every worker and your own `gh` use. When it runs out, ticks fail until the reset.
- A PR belongs to a package when its branch starts with the lead's branch name, when it closes one of the package's issues (in any repo), or when the worker lists it in the state comment.
- The Usage page reads the weekly allowance with the Claude Code OAuth token from your macOS keychain, from the same endpoint Claude Code's `/usage` reads. It is an undocumented endpoint and may change.
- The Mac sleeps, and no ticks run then. That is not a fault.

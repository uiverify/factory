# factory

A dark factory that runs on your Mac: Linear tickets in, merged GitHub PRs out, with almost no human in the loop.

Every 10 minutes a small Node script looks at your Linear tickets, your GitHub PRs and your running Claude Code sessions, then starts or wakes a Claude session to move each ticket one step forward. The script itself makes no model calls, and Linear is the only state of record.

```
Backlog ──triage──► Todo ──build──► In Progress ──PR──► In Review ──merge──► Done
                                         │
                                         └── stuck? one question on the ticket, you reply, it resumes
```

## What it uses

| Piece | What it does |
|---|---|
| [Claude Code](https://claude.com/claude-code) | every worker is a background `claude --bg` session in its own git worktree |
| [Linear](https://linear.app) | tickets, status and the factory's state (one machine-owned comment per ticket) |
| GitHub + `gh` | PRs, CI, reviews, merges (`gh stack` for PR stacks) |
| macOS `launchd` | runs the loop every 10 minutes and keeps the dashboard up at http://localhost:7788 |
| [UI Verify](https://uiverify.ai) | the visual check: the agent sees what its UI change did and fixes it before a human looks |

## The skills

All in [`skills/`](skills), linked into `~/.claude/skills/` by `setup.sh`.

**The loop** (the same skills as UI Verify's [`uiverify-workflow`](https://github.com/uiverify/uiverify/tree/main/packages/workflow-skills) plugin):

| Skill | What it does |
|---|---|
| `factory` | one change from ask to merge-ready PR: design if needed, implement, review, verify, open the PR |
| `design` | drafts a design and has two models critique it until it holds up |
| `review-loop`, `review-multi-model` | Claude and Codex review the diff, verified fixes get applied, repeat until clean |
| `e2e-verify` | drives the change through the real app with Playwright |
| `babysit-pr` | watches CI and review comments on a PR and fixes what fails |
| `add-rule` | turns a correction into a CLAUDE.md rule plus a lint guard, so it never happens again |
| `evaluate-run` | grades a finished run against your conventions |

**The factory** (what runs it unattended):

| Skill | What it does |
|---|---|
| `factory-auto` | `factory` with no questions; also the babysit pass that fixes, decides and merges |
| `factory-triage` | reads a Backlog ticket: ready, split, needs a decision, or later |
| `factory-plan` | groups ready tickets into packages, one PR stack each |
| `factory-project` | the one place you spend real time: spec, architecture and the ticket tree, together |
| `factory-run` | start, stop, pause, status, in plain words |
| `factory-monitor` | read-only health check every 30 minutes, tells you when the loop quietly stalls |

For visual testing, add UI Verify's own skills: `npx skills add uiverify/uiverify`.

## Install

```sh
git clone https://github.com/uiverify/factory ~/.claude/factory
cd ~/.claude/factory && sh bin/setup.sh
```

Then put your Linear API key in `.env`, set your repo, Linear team and one target in `factory.json`, and fill in `principles/principles.md`. That last file is the important one: it is the judgment workers use instead of asking you (what to decide alone, when to stop, when a PR may merge). The template has examples.

Try one tick without side effects, then start it:

```sh
node bin/factory-tick.mjs --dry-run --verbose
sh bin/install-launchd.sh 600        # or /factory-run start in Claude Code
```

Start small: one target, one or two tickets in flight, and every merge waiting for a human approval.

## Before you run it

- **This is one person's working setup, published as is.** Not a polished tool. Expect to read the code and adapt it.
- **Workers run with no permission prompts** (`--dangerously-skip-permissions`). A worker can run any command as you, with your credentials. Run it only on a machine and accounts where that is fine.
- **macOS, Claude Code, Linear and GitHub only.**
- **It is only as good as your repo.** Conventions in CLAUDE.md, lint and tests that catch mistakes, a way to see UI changes. The factory runs the loop; your repo supplies the judgment.
- **It uses your Claude subscription.** Several Opus sessions at once is heavy.

How it works in detail, every config key, and the known quirks: [docs/how-it-works.md](docs/how-it-works.md).

MIT licensed.

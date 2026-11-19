# factory

A dark factory that runs on your Mac: GitHub issues in, shipped work out, across several repos, with almost no human in the loop.

Every 10 minutes a small Node script looks at your GitHub issues, your PRs and your running Claude Code sessions, then starts or wakes a Claude session to move each issue one step forward. The script itself makes no model calls, and GitHub is the only state of record: `factory: *` labels plus one machine-owned comment per claimed issue.

```
untriaged ──triage──► factory: ready ──build──► factory: working ──PR──► factory: in review ──you merge──► closed
                                                     │
                                                     └── stuck? one question on the issue, you reply, it resumes
```

A repo can also skip the PR stage and have workers land reviewed commits straight on its base branch, or collect a whole project's issues on one long-lived branch that ends in a single PR.

## What it uses

| Piece | What it does |
|---|---|
| [Claude Code](https://claude.com/claude-code) | every worker is a background `claude --bg` session in its own git worktree |
| GitHub issues + `gh` | the backlog, the factory's state (labels and one state comment per issue), PRs, CI, sub-issues and blocked-by relations |
| macOS `launchd` | runs the loop every 10 minutes, keeps the dashboard up at http://localhost:7788, runs the monitor every 30 minutes |
| [UI Verify](https://uiverify.ai) | optional visual check: the agent sees what its UI change did and fixes it before a human looks |

## The skills

All in [`skills/`](skills), linked into `~/.claude/skills/` by `setup.sh`.

**The loop** (the same skills as UI Verify's [`uiverify-workflow`](https://github.com/uiverify/uiverify/tree/main/packages/workflow-skills) plugin). A repo can carry its own versions in `.claude/skills/`; workers use the repo's when it has them.

| Skill | What it does |
|---|---|
| `factory` | one change from ask to shipped: design if needed, implement, review, verify, then a PR or a push |
| `design` | drafts a design and has two models critique it until it holds up |
| `review-loop`, `review-multi-model` | Claude and Codex review the diff, verified fixes get applied, repeat until clean |
| `e2e-verify` | drives the change through the real app with Playwright |
| `babysit-pr` | watches CI and review comments on a PR and fixes what fails |
| `add-rule` | turns a correction into a CLAUDE.md rule plus a lint guard, so it never happens again |
| `evaluate-run` | grades a finished run against your conventions |

**The factory** (what runs it unattended):

| Skill | What it does |
|---|---|
| `factory-auto` | `factory` with no questions: decides, records each choice under "Decisions taken", parks on the issue only for the stop reasons |
| `factory-triage` | reads a new issue: ready, split into a batch, needs a decision, needs a human, or later |
| `factory-plan` | groups ready issues into work packages, one worker each |
| `factory-project` | the one place you spend real time: spec, low-fidelity flows and wireframes, architecture and the issue batch, together |
| `factory-run` | start, stop, pause, status, add a repo or a target, in plain words |
| `factory-monitor` | read-only health check every 30 minutes, tells you when the loop quietly stalls |
| `factory-ops` | an operator session: loads how the factory works, checks its health, helps you change it |

For visual testing, add UI Verify's own skills: `npx skills add uiverify/uiverify`.

## Install

```sh
git clone https://github.com/uiverify/factory ~/.claude/factory
cd ~/.claude/factory && sh bin/setup.sh
```

Then edit `factory.json`: your name and GitHub login under `owner`, each repo (GitHub slug, local clone, base branch, ship mode) and one target. Rerun `setup.sh` to get a `principles/<repo>.md` per repo and fill it in; `principles/common.md` holds the rules every repo shares. Those files are the important part: they are the judgment workers use instead of asking you (what to decide alone, when to stop, how the repo ships). Finally, add `@~/.claude/factory/issues.md` to each repo's `CLAUDE.md` so every agent there, factory or not, follows the same issue flow.

Try one tick without side effects, then start it:

```sh
node bin/factory-tick.mjs --dry-run --verbose
sh bin/install-launchd.sh 600        # or /factory-run start in Claude Code
```

Start small: one target, one or two issues in flight, and every change going through a PR you merge.

## Before you run it

- **This is one person's working setup, published as is.** Not a polished tool. Expect to read the code and adapt it.
- **Workers run with no permission prompts** (`--dangerously-skip-permissions`, and `bypassPermissions` in each worktree). A worker can run any command as you, with your credentials. Run it only on a machine and accounts where that is fine.
- **macOS, Claude Code and GitHub only.**
- **It is only as good as your repo.** Conventions in CLAUDE.md, lint and tests that catch mistakes, a way to see UI changes. The factory runs the loop; your repo supplies the judgment.
- **It uses your Claude subscription.** Several Opus sessions at once is heavy. The dashboard's Usage page shows the live weekly allowance and what each issue spent; per repo or per target you can run workers on Sonnet instead.

How it works in detail, every config key, and the known quirks: [docs/how-it-works.md](docs/how-it-works.md).

MIT licensed.

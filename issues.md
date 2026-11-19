# GitHub issues: the one flow every repo uses

Read by every agent in every repo the factory runs on (every repo in `factory.json`), whether it runs by hand or under the factory. Each repo's `CLAUDE.md` adds only its own facts: which repo the issues live in, its `stream:` labels, and what stays in files there instead. When this file and a repo's `CLAUDE.md` disagree, this file holds for the flow and the repo holds for its own facts.

## 1. Every piece of open work is an issue

A bug, a feature, a flag to turn on, a launch, a chore, a follow-up you defer, a gap you find, a "still owed" item: open an issue in that repo, never a line in a markdown to-do file (those went stale unread for months). A repo may keep some things in files instead (people and conversations, say); its `CLAUDE.md` names them.

Before opening one, search open and recently closed issues with 3 or 4 title words (`gh issue list -R <repo> --state all --search "<words>"`). A duplicate is a comment on the existing issue, not a new one.

## 2. Writing an issue

- **Title**: the outcome in plain words ("Search finds a name typed with a typo"), not the task ("Fix search").
- **Body**: what is wrong or wanted and why, with the evidence (a link, a log line, a screenshot path); the scope, including what is not in it; and a `## Verify` section of 3 to 8 lines, each a check someone can answer yes or no by running the product or the tests. Name the Job or decision it serves when the repo has them.
- **Three labels, always:**
  - one `stream: *`, the work area. Each repo's `CLAUDE.md` lists its streams. Add a new stream when a new area appears instead of stretching an old one.
  - one kind: `bug`, `feature`, `rollout` (something shipped dark, behind a flag or inert: how to enable, the criteria, what is owed at 100%, the rollback) or `task` (non-code work).
  - one priority: `priority: high` means do it now, and **only the owner sets it**. Then `priority: medium` and `priority: low`. No priority means untriaged.
- **Ordering**: when one issue can't start before another is done, record it as GitHub's "blocked by" relation, not as prose: `gh api repos/<repo>/issues/<n>/dependencies/blocked_by -F issue_id=<blocker id>`, where the id is `gh api repos/<repo>/issues/<blocker> --jq .id`, not the number.

## 3. Batches

Related issues are grouped as a **batch**: a parent issue labelled `batch` with its pieces as GitHub sub-issues: `gh api repos/<repo>/issues/<parent>/sub_issues -F sub_issue_id=<child id>`, with the same id lookup as above. List them with `gh api repos/<repo>/issues/<parent>/sub_issues`. A batch parent is a container: it holds the plan and the links and is never built on its own. Hand the parent to `/factory`, or make it a factory target. How its pieces land (one commit each to `main`, or PRs) follows the repo's ship rule in its `CLAUDE.md`.

## 4. Closing

- Work that lands closes its issue: `Fixes #<n>` in the PR body, or in the commit message when the repo pushes straight to `main`. When no closing keyword reached the default branch, close it by hand with the commit or PR: `gh issue close <n> -c "Shipped in <sha or PR link>."`
- Work we won't do: `gh issue close <n> --reason "not planned" -c "<why>"`. Close only then.
- Work for later stays open: swap its `priority:` for `priority: low`, remove `factory:` state labels and the target's project label so no tick picks it up, add `factory: later`, and comment why it waits and what would bring it back (a demand signal, a missing source, a decision).
- A deferral or follow-up gets its issue **before** the PR opens or the commit lands, and the PR body or commit message links it. Never "will file when this merges".
- Text a customer or the public reads never names your internal issues, numbers or tracker.

## 5. The factory on issues

The factory (`~/.claude/factory/`, run with `/factory-run`) reads these issues and builds them unattended. Its state lives on the issues themselves, so anyone can see it on GitHub.

**Which issues it looks at.** A target in `~/.claude/factory/factory.json` names a repo and selects issues by a batch parent (its open sub-issues), by labels, or both. Nothing outside a target is touched. Batch parents and closed issues are never built.

**Labels the factory owns** (the tick creates them in each repo):

| Label | Means | Set by |
|---|---|---|
| `factory: ready` | Cleared to build. | Triage, or the owner by hand to hand an issue straight to the factory |
| `factory: working` | A worker has claimed it (also assigned to the owner's account). | Tick |
| `factory: in review` | Its PR is open (repos that ship through PRs). | Tick |
| `factory: needs info` | Parked on a question for the owner. | Worker |
| `factory: decide` | A product fork no document settles; the options are in a comment. | Triage |
| `factory: split` | Too big for one worker; triage made it a batch with sub-issues. | Triage |
| `factory: human` | Needs a step only the owner can do (an account, a payment, a post, playing or reading something). | Triage |
| `factory: later` | Outside the target's scope rule, a duplicate, or deferred: worth doing, not now (§4). | Triage, or the owner deferring an issue |

**Marker comments.** Every comment the factory writes starts with an HTML marker, so a comment without one is a human's:

- `<!-- factory-state -->`: one per claimed issue, a JSON block the tick owns. A worker updates only `prs`, `parked_at` and `review` (its review-loop numbers) in it.
- `<!-- factory-triage -->`: the triage verdict and reason.
- `<!-- factory-question -->`: a parked worker's question (below).
- `<!-- factory-note -->`: anything else an agent posts under the factory (decisions taken, a progress line).

**Asking the owner (a worker never uses AskUserQuestion).** One `<!-- factory-question -->` comment on the issue: the scenario in plain words, 2 to 4 options with the recommended one first, and what the user would see under each. Then add `factory: needs info`, set `parked_at` in the state comment, and end the session with the last line `FACTORY: parked on #<n>`. The tick notifies the owner. **The owner answers with a plain comment on the issue**; the next tick removes `factory: needs info` and resumes the worker with their words.

**The owner steering by hand.** Add `factory: ready` to hand an issue over. Remove `factory: working` and close or relabel the issue to stop it. Pick an option on a `factory: decide` issue by commenting, then swap the label for `factory: ready`. Set `priority: high` to put an issue first in the queue.

**A worker's own follow-ups** are issues written by sections 2 and 4, in the same repo, inside the same target when they are in its scope (same batch parent or labels), so the factory picks them up next.

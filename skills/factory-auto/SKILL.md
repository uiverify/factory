---
name: factory-auto
description: The repo's /factory loop without the check-ins. Runs the same phases (triage, design, implement, review-loop, e2e-verify when needed, the gate, then push or open a PR, per the repo's ship rule) but decides open questions itself and records each choice under "Decisions taken". It stops only for the cases in the factory principles, by parking on the GitHub issue. Started by the factory tick for one or more issues; also usable by hand for a plan file or an issue that should run unattended. Triggers on "/factory-auto", "run this unattended", "squash this issue", "don't ask me, just build it".
argument-hint: <owner/repo#n ...>, a plan file, or what to build
---

# /factory-auto: /factory that decides instead of asking

Read the repo's own factory skill (`.claude/skills/factory/SKILL.md` in the repo you are in, else the `factory` skill installed with the factory) and run every phase as written, with the overrides below. The issue or plan you were given is the spec. This overrides any "go back and forth / ask before planning" preference for this run.

The owner (named in the prompt and in `factory.json` `owner.name`) starts many of these at once. Each question parks a worker until they come back to it, so asking costs far more than deciding. They would rather overrule a decision afterwards than answer it up front.

## Read first

1. `~/.claude/factory/principles/common.md`, then the repo's principles file (`$FACTORY_PRINCIPLES`, named in the prompt).
2. `~/.claude/factory/issues.md` (`$FACTORY_ISSUES_DOC`): how issues, labels, follow-ups, closing and parking work.
3. The repo's `CLAUDE.md` and its decision log, when it keeps one.
4. The target's project visuals when the prompt names a folder (`flows.html`, `wireframes.html`, `shots/`): the UI you build matches them in flow and copy, not pixels.
5. Each issue with its comments (`gh issue view <n> -R <repo> --comments`), its batch parent and siblings, and linked PRs or commits. Their decisions win over your judgment; record any conflict as a decision.

## Overrides to /factory

- **Clarifying questions: don't ask.** Settle open questions with the principles and write each one down.
- **Design:** run the repo's `/design` when its triage says so, but its go/no-go is **not** a stop. Run it with `--rounds 5`: it runs until a clean round or its cap. At the cap with only minor findings open and the high-level design settled, build it and list those findings in the design and the PR body; with a blocker or major still open, never build: park with `/design`'s stop report and let the owner decide (`principles/common.md` §4). Ask only if the converged design hits a stop reason in `principles/common.md` §2. Otherwise put the design summary (what, why, the alternatives dropped) at the top of the PR body, or in a `<!-- factory-note -->` comment on the issue in a push repo, and build.
- **Questions the work raises** (review findings, e2e observations): decide them with the principles. Two reviewers independently flagging the same behavior: follow them. Overruling one reviewer: record it as a decision.
- **Design and review rounds:** new holes in the same area every round means the structure is wrong: change the architecture (as often as the holes call for) and say why. Never freeze to stop findings, and never soften the critics' or reviewers' instructions in later rounds (`principles/common.md` §4).
- **Shipping:** the repo's ship rule exactly as its `CLAUDE.md` and principles file say (`$FACTORY_SHIP` is `push`, `pr` or `branch`). A `branch` target's issues land one after another as reviewed commits on one long-lived branch in a shared worktree, and the tick pushes it and opens its one PR; its prompt says how. The tick's prompt repeats the hand-off line to end with.

## Ask Opus when you need to (when you are not Opus)

A factory worker may run on Sonnet to save usage; design and review already run on Opus inside their skills. When you are not running on Opus, get a second opinion from an Opus subagent (Agent tool, `model: opus`) before you:

- make a product call the issue, the spec and the principles don't settle (what a user sees or can do);
- change how parts of the system fit together beyond what the design or issue named (a new module, table, data flow or shared contract);
- park, or decide not to park, on a stop reason;
- drop a reviewer's finding, or overrule one reviewer.

Give it the question, the options you see, your pick and why, and the files that matter; ask for a pick and one line of reasoning. Its answer stands unless the issue or a recorded decision says otherwise. Note each consultation under Decisions taken ("Opus agreed" or "Opus picked B over my A"). Don't ask about routine choices `principles/common.md` §1 tells you to just decide.

## Decisions taken

Every PR body, or every finishing commit message in a push repo, has this section, one line per choice, the ones the owner is most likely to overrule first:

> **Decisions taken**
> - The "Saved" toast stays 5 s after save. Alternative: dismiss on the next click. Why: users look away right after saving.

Mirror them as one `<!-- factory-note -->` comment on the batch parent when the issues have one, else on the first issue.

## Factory mode (unattended, started by the factory tick)

You are in factory mode when the prompt says so or `FACTORY_PRINCIPLES` is set. The tick at `~/.claude/factory/bin/factory-tick.mjs` started you in a fresh worktree (`<repo>/.claude/worktrees/factory-<lead>`, branch `<branch_prefix><lead>`) and will keep coming back; nothing in this session needs to stay alive.

- **Work package**: several issue numbers mean one worker doing them in the given order, as **one change**: one design, one review-loop over the whole diff, one gate, one commit (push repo) or PR (PR repo) whose message carries `Fixes #<n>` for each issue. The planner groups only issues that belong together, so don't review, verify and push issue by issue. Split only where the repo's rules require it. In a PR repo, name extra branches `<branch_prefix><lead>-<slug>` so the tick finds them.
- **Never use AskUserQuestion.** The stop reasons still apply; the way to stop is the protocol in `issues.md` §5: one `<!-- factory-question -->` comment, the `factory: needs info` label, `parked_at` in that issue's state comment, and the last line `FACTORY: parked on #<n>`. The tick notifies the owner and resumes you with their answer.
- **The state comment** (`<!-- factory-state -->` on each issue) is the tick's. You update only `prs`, `parked_at` and `review` in its JSON (`gh api -X PATCH repos/<repo>/issues/comments/<id> -f body=...`), keeping the rest.
- **Fix your own open work in place**: a gap in code this package added (a missing test, a weak assertion, a reviewer's nit) is a commit on the same branch, not a new issue.
- **Follow-ups**: everything else you would list as a follow-up or deferral gets an issue first (`issues.md` §2 and §4), inside the same target when it is in scope (same batch parent or the target's labels), and the PR body or commit message links it. A follow-up that needs this package's unmerged code is "blocked by" this package's issue.
- **Review numbers**: before the hand-off, write `"review": {"rounds": <review-loop rounds run>, "findings": <verified findings fixed or filed>, "opus_consults": <second opinions asked>}` into the **lead** issue's state comment, summed over every review-loop run in the package. The dashboard compares models with them.
- **Hand-off**: end exactly as the tick's prompt says (`FACTORY: in review #…`, `FACTORY: shipped <shas>` or `FACTORY: parked on #…`). Do not loop and do not schedule a wakeup.
- **Resumed sessions**: a prompt that starts with "Continue /factory-auto" or "<owner> answered on" means the tick brought you back. Re-read the state comments, the issue comments and the worktree's `git log` before acting.

## Final report (interactive runs only)

List every commit or PR with its Decisions taken so the owner can overrule them in one pass.

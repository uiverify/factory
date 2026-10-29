---
name: factory-auto
description: /factory without the check-ins. Runs the same loop (triage, design, implement, review-loop, verify, PR, converge) but decides open questions itself from the principles file and records each choice under "Decisions taken" in the PR body. It stops only for the stop cases in the principles file. Also runs the factory's one-shot babysit pass on an open PR or stack ("/factory-auto babysit <PR>"): fix CI and review threads, compute the merge verdict, merge when the rules allow. Use for a Linear ticket that should run unattended to a merged PR, or when started by the factory tick. Triggers on "/factory-auto", "run this unattended", "don't ask me, just build it".
argument-hint: <ticket keys | plan file | what to build> or babysit <PR> [reviewers: <login> ...]
---

# /factory-auto: /factory that decides instead of asking

Two modes, chosen by the first argument:

- **Build** (default): ticket keys, a plan file, or a description. Run the `factory` skill's phases with the
  overrides below.
- **Babysit** (`babysit <PR>`): one pass over an open PR or stack, then end. See [Babysit pass](#babysit-pass).

The owner starts many of these at once. Each question parks a worker until the owner comes back to it, so asking
costs far more than deciding. Owners would rather overrule a decision in review than answer it up front.

## Build: overrides to /factory

Load the `factory` skill (`skills/factory` in this repo) and run every phase as written, with these overrides.
The plan or ticket you were given is the spec.

- **Phase 0 (Confirm the ask): don't ask.** Settle open questions from the principles file and write each one down for
  the PR. Read the ticket, its comments, linked PRs, and the project documents first. Earlier decisions often sit
  there, and they win.
- **Phase 3 (Design):** run `/design` as usual, but its go/no-go is **not** a stop. Ask only if the converged
  design hits one of the stop cases. Otherwise put the design summary (what, why, and the alternatives you dropped)
  at the top of the first PR body and build.
- **Questions the work raises** (review findings, verify observations): decide them from the principles file. If
  two reviewers independently flag the same behavior, follow them. If you overrule one reviewer, record it as a
  decision.
- **Review rounds:** if each round keeps finding new edge cases in the same area, the design is wrong. Step back,
  fix the structure underneath (usually one source of truth instead of state in two places), and say so. Don't
  patch case by case. Once the ticket's needs are met, freeze the design.
- **Phase "open the PR":** open the PRs with `gh pr create` (or `gh stack` when installed and the work is a
  stack), non-draft, one PR per ticket or reviewable piece. Each PR title carries its ticket key and the body has a
  `Fixes <KEY>` line: the tick finds a ticket's PRs that way.

## When to stop and ask (the only cases)

Section 2 of the principles file lists them. In short: irreversible or outside the PR, a contradiction, a wrong
premise, a product fork the documents don't settle, or a tool the session can't reach.

When you do ask, ask once, in plain words. Say what the branch is doing, give a concrete scenario ("a user accepts
the invite, then..."), say what the user would see under each option, and recommend one. Questions that use
internal names, codes or thread ids without context cost a round trip.

## Judgment

Sections 3 to 5 of the principles file are the owner's product, architecture and scope judgment. When a choice is
open, pick the option that wins on those. When they don't settle it and users would not notice the difference,
pick the simpler option and record it.

## PR body: "Decisions taken"

Add this section to every PR, one line per choice:

> **Decisions taken**
> - The banner shows to every member, not only the creator. Alternative: creator only.
>   Why: everyone using the feature should know it stopped.

Put the decisions the owner is most likely to overrule first. In the final report, list every PR with its
decisions so they can be overruled in one pass.

## Factory mode (unattended, started by the factory tick)

You are in factory mode when the prompt says so, when `FACTORY_PRINCIPLES` is set in the environment, or when more
than one ticket key is given. The tick (`$FACTORY_ROOT/bin/factory-tick.mjs`, by default
`~/.claude/factory/bin/factory-tick.mjs`) started you in a fresh worktree and will call the babysit pass for you
when the PR changes; nothing in this session needs to stay alive.

- **Read first**: the principles file (`$FACTORY_PRINCIPLES`, default `~/.claude/factory/principles/principles.md`),
  then the project's Linear documents (`list_documents` for the ticket's project: UX spec, Architecture, Defaults,
  Decision log), then the ticket, its comments, and linked PRs. Their decisions win over your judgment; record any
  conflict as a decision.
- **Work package**: several keys mean one PR stack in the given order, one PR per ticket (or per reviewable piece).
- **Never use AskUserQuestion.** The way to stop is the escalation protocol in the principles file: one Linear
  comment starting with `<!-- factory-question -->`, the `Needs Info` label, `parked_at` in the factory state
  comment, and the final line `FACTORY: parked on <KEY>`. The tick notifies the owner and resumes you with the
  answer.
- **Factory state comment**: each ticket carries a comment starting with `<!-- factory-state -->` holding a JSON
  block the tick owns. You update only `prs` (PR numbers, as you open them) and `parked_at`; keep everything else
  as it is.
- **Follow-ups before the PR opens**: every follow-up or deferral the PR body lists gets a Linear ticket first
  (`save_issue`; search with `list_issues` first, and a gap that belongs to an existing ticket goes into that
  ticket instead). The PR body links each one. A follow-up that touches code from this package's unmerged PRs is
  `blockedBy` this package's ticket, so the factory stacks it on the PR instead of starting it from the base branch.
- **Hand-off**: when the PR or stack is open, run the babysit pass once (`/factory-auto babysit <top PR>` with the
  reviewers you were given), write "Decisions taken" to each PR body and as one line per decision in the project's
  Decision log document (append), then end with the final line `FACTORY: in review <PR numbers>`. Do not loop and
  do not schedule a wakeup.
- **Resumed sessions**: a prompt that starts with "Continue /factory-auto" or "<owner> answered on" means the tick
  brought you back. Re-read the factory state comment and the ticket before acting.

## Babysit pass

`/factory-auto babysit <PR> [reviewers: <login> ...]`. One pass over the PR, or every open PR in its stack
(`gh stack view --json` succeeds) bottom to top, then end. The tick calls it again when the PR's signals change,
so never schedule a wakeup, never loop, never AskUserQuestion. Read the principles file first; its merge rules
(section 7) are the source of truth, so read them on every pass instead of working from memory.

1. **Signals.** `gh pr view <PR> --json state,mergeable,mergeStateStatus,headRefOid,baseRefName,reviewDecision,latestReviews,comments`,
   `gh pr checks <PR>`, and the unresolved review threads (GraphQL `reviewThreads(last: 100)`; `first: 100` hides
   new threads on big PRs). Merged or closed PRs drop out; all of them merged means go to step 6. A command that
   errors (auth, network): say so in the final line and end. Never guess state.
2. **Stack sync and conflicts.** A lower PR merged since last pass: `gh stack sync`. A conflict: rebase onto the
   base, resolving each conflict in the lowest PR that touches the file. GitHub checks a stacked PR against the
   branch the stack lands on, not its own base, so test with `git merge-tree --write-tree origin/<base> <head>`.
   Never call the conflict flag stale. A conflict that needs a product call is a stop case.
3. **Failed CI** (settled checks only). Read the failed log (`gh run view <id> --log-failed`). A flake that is
   clearly not this branch: `gh run rerun <id> --failed`, once per commit. A real failure: reproduce with the
   narrowest command and fix the root cause. The `babysit-pr` skill's failure-handling guidance applies; its
   polling and its "never merge" end state do not.
4. **Review threads and review bodies.** Valid: fix within the agreed design. False positive or already decided:
   decline with the reason. A fix that changes how the feature works (who owns data, stored data or API contracts,
   retry or quota rules) is a stop case, not a routine fix. After the design-freeze limit in the principles file,
   handle only CI, conflicts and human comments.
5. **Verify and push**, only if code changed: the repo's own lint, typecheck and tests for what you touched; push;
   confirm `git rev-parse HEAD` equals `git rev-parse @{u}`. Then close the loop on each thread: fixed as asked,
   resolve it; declined or fixed differently, reply with the reason, then resolve. Re-request review only from
   reviewers who have not approved, and only when the PR's own diff changed.
6. **Merge verdict.** Compute `auto` or `hold` per PR from the principles file, section 7. Post or update **one**
   PR comment starting with `<!-- factory-merge-verdict -->`: `**Merge verdict: auto**` or `**Merge verdict: hold**`,
   the reason on the same line, and the reviewers requested. Then act on it exactly as section 7 says (auto-merge
   for a single PR, `gh stack merge` for the ready bottom of a stack, request reviewers for PRs without a human
   approval: the `reviewers:` you were given first).
7. **After the last PR of the package merges**: file any deferral still without a ticket, append one line per
   decision to the project's Decision log, move the ticket to Done if the GitHub integration did not.

Final line of every pass, so the tick log reads without opening the session: `FACTORY: in review <PRs>`,
`FACTORY: blocked <why>`, `FACTORY: parked on <KEY>`, or `FACTORY: merged <PRs>`.

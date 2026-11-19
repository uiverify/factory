# Factory principles: every repo

Read by every factory worker before it plans, by triage, and by babysit before it fixes or escalates. Then read the repo's own file in this folder (named in the prompt and in `$FACTORY_PRINCIPLES`), then the repo's `CLAUDE.md`. The owner is `owner.name` in `factory.json` (the person parked questions go to). The issue flow, including how to park on a question, is `~/.claude/factory/issues.md`.

Precedence: the issue and its comments win over this file; record the disagreement under **Decisions taken**. The repo's `CLAUDE.md`, its `decisions/` log and its plan win over both. When the best design contradicts one of them, stop (reason 2 below).

## 1. Never ask about these; decide and record

Anything a follow-up commit can undo is decided by the worker and written under **Decisions taken** (in the PR body, or the commit message in a push-to-main repo, and as one `<!-- factory-note -->` comment on the batch parent when there is one, else on the issue). Examples: names of files, functions, columns, enums; which existing helper to reuse; test strategy; where a guard lives; how to split the work into commits or PRs; whether to add a story; copy wording inside an already-decided UX; internal error shapes; retry counts; log fields.

Before asking anything, research: the issue, its comments, its batch parent and siblings, linked PRs and commits, the repo's `decisions/` and docs, and these principles. Most questions are answered there.

Put the decisions the owner is most likely to overrule first. One line each: the choice, the alternative, why.

## 2. The only reasons to stop

1. **Irreversible or outside the repo**: deleting user data or a released feature, rewriting released data, writes to production or live services (flags, dashboards, email lists, payments), anything sent or published to a person.
2. **Contradiction**: the best design contradicts the issue, a recorded decision, or the repo's rules.
3. **Wrong premise**: the bug does not reproduce, is already fixed, or the evidence says the ask would make things worse. Bring the evidence.
4. **A product fork** no document settles and that users would notice.
5. **A step only the owner can do, or a tool you don't have**: an account, a payment, a post, playing or listening to something, reading a page before it ships, a service your session can't reach. Do every part you can first (the code, the exact text written into a comment), then park with a question that names what's left and gives them numbered steps.

How to stop: the escalation protocol in `issues.md` §5. One question comment, the `factory: needs info` label, `parked_at` in the state comment, end the session. Never wait, never use AskUserQuestion, never notify the owner yourself; the tick does.

A question the owner reads is self-contained and in plain words: what the branch is doing, a concrete scenario, what the user sees under each option, the recommended option first. No internal codes, round counts or labels you invented.

## 3. Scope

- A review-found edge case in **new** code: fix it in place if it is a few lines and needs no new field, mechanism or state; otherwise file an issue (`issues.md` §2) and move on.
- A pre-existing bug you find: its own issue and its own commit or PR, never folded in.
- A new or changed rule (a lint guard, a `CLAUDE.md` or skill rule, an `/add-rule` result): the owner decides it, so it never ships with the work. Build it on its own branch, open it as its own PR into the repo's base branch (even in a push repo), link it on the issue and in the hand-off, and don't merge it. The rest of the package ships as usual.
- Every deferral gets an issue before the work lands, linked from the PR body or commit message.
- Unreleased work (flag off, no real users): break freely, no shims, no backfills for data that doesn't exist.
- For the bug you were asked to fix, prefer the proper root-cause fix over a patch.

## 4. When rounds keep finding holes

If design or review rounds keep finding new holes in the same area, the structure is wrong: change it (usually one source of truth instead of state in two places) and say why. Changing the architecture is always allowed, as many times as the holes call for; never freeze a design to stop the findings. Keep the critics' and reviewers' instructions the same every round (no "only raise blockers from now on").

The design loop runs until a clean round or 5 rounds (`/design --rounds 5`), whichever comes first (10-round loops cost more than they caught). At round 5, judge what is still open. If the high-level design is settled and only minor findings remain (an edge case, a detail the code review can settle, wording), build it: list those last findings in the design under "Still open at the round cap" and in the PR body, so they get sorted later. If any blocker or major is still open (the architecture, a correctness or billing hole, a direction the critics disagree on), do not implement: park on the issue (§2's escalation protocol) with the design as it stands, the open problems in plain words, `/design`'s independent judge's read, and a recommendation, and let the owner decide.

Once the issue's `## Verify` lines hold, stop chasing code-review wording nits; handle failed checks, conflicts and human comments only.

## 5. What the factory reports

Human touches per issue (questions, review rounds, nudges), issues closed, reverts within 7 days, follow-up fixes within 30 days, parked rate, restarts, time from claim to closed.

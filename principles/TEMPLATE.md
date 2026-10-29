# Factory principles for <your repo>

<!--
This file is the contract every factory worker reads before it plans, and the babysit pass reads before it fixes,
merges or escalates. `bin/setup.sh` copies it to `principles/principles.md`; edit that copy, not this template.

How to fill it in:
- Keep the section structure. The tick, factory-auto, factory-triage and the monitor refer to these sections by name.
- Replace every <FILL IN: ...> block with your own rules. Delete the examples you don't agree with.
- Write rules as decisions you have already made, in the words you would use with a new teammate.
- The best source is your own history: questions agents asked you that you answered the same way every time.
  Each repeated answer is a rule here, and every rule here is a question you stop getting.
-->

Read by every factory worker before it plans, and by the babysit pass before it fixes, merges, or escalates. The owner is <FILL IN: your name>. When a rule here and a ticket disagree, the ticket wins and the disagreement is recorded as a decision. When a rule here and <FILL IN: where your product docs live, e.g. `docs/product/`> disagree, stop and escalate (contradiction).

## 1. Never ask about these; decide and record

Anything that can be undone in a follow-up PR is decided by the worker, written under **Decisions taken** in the PR body, and mirrored to the ticket. Examples: names of columns, enums, functions and files; which existing helper to reuse; test strategy; where a guard lives; how to split the work into PRs; whether to add a story or test fixture; copy wording inside an already-decided UX; internal error shapes; retry counts; log fields; index choices.

Before asking anything, research first: the ticket, its comments, linked PRs, the project documents (UX spec, Architecture, Defaults, Decision log), <FILL IN: your docs folder>, and this file. Most "questions" are answered there.

<FILL IN: anything else your agents keep asking that you always answer the same way.>

## 2. The only reasons to stop

1. **Irreversible or outside the PR**: deleting user data or a released feature, rewriting released data, writes to production or live services, breaking a released public API.
2. **Contradiction**: the best design contradicts the ticket, a project document, or a recorded decision.
3. **Wrong premise**: the bug does not reproduce, is already fixed, or production shows zero occurrences.
4. **A product fork the documents do not settle** and that users would notice.
5. **A tool you don't have**: the work needs a service the session can't reach or isn't signed in to (a design tool, a production console, a third-party dashboard). Do every part you can first: the code, the PR, and the exact change written out in the ticket. Then park with a question that names what's left and ends with a ready-to-paste prompt for a session that has the tool. Never guess or fake the step.

<FILL IN: services that count as "live" for you, e.g. your feature-flag service, your analytics, your email provider.>

**Escalation protocol**: one Linear comment on the ticket that starts with `<!-- factory-question -->` (the scenario in plain words, 2 to 4 options, the recommended one first, a mention of the owner), add the `Needs Info` label, set `parked_at` in the ticket's factory state comment, then end the session. Do not park and wait. Do not use AskUserQuestion. Do not message anyone yourself; the tick notifies.

## 3. User experience defaults

<FILL IN: the product judgment you apply over and over. Short, opinionated, testable. Examples to adapt or delete:>

- Show users the truth, to everyone affected. Explain numbers in the UI, do not just warn.
- Give a way forward (an action), not only an explanation.
- Do not block creating; check at the action with consequences (enable, send, publish).
- Do what the user would expect right after their action. No surprising background work.
- Filter bad input up front instead of half-running.
- Do not explain internal algorithms in user copy. Plain names, no jargon.
- Every UI surface added or changed gets a story or a visual test.

## 4. Architecture defaults

<FILL IN: the load-bearing invariants of your codebase. Examples to adapt or delete:>

- One shared place every entry point goes through (web, API, background jobs).
- Model the future you already know about; key on stable ids.
- Store the facts the product will need; one record of truth per outcome; derived state over new columns.
- No redundant mechanisms. A simpler solution plus a monitor beats new infrastructure for an edge case.
- Analytics events stay granular and keep their meaning.

## 5. Scope

- A review-found edge case in **new** code: fix in place only if it is a few lines and needs no new field, mechanism, or state. Otherwise file a ticket and move on.
- A pre-existing bug: separate ticket, separate PR, never folded in.
- Every deferral gets a Linear ticket linked from the PR, filed before the PR is reviewed.
- Unreleased feature (flag off, no real users): break freely, no shims, no backfills for data that does not exist.
- Released feature: data migrations run after deploy, backfills after the PR lands, stack order follows deploy order.
- Stacks are the default shape: one reviewable piece per PR. Deliver most of the ticket; the rest is tickets.

<FILL IN: your flag policy, e.g. when a change needs a new feature flag and when it does not.>

## 6. Design freeze

If review rounds keep finding new edge cases in the same area, the design is wrong: fix the structure once (usually one source of truth), say so, then freeze. After <FILL IN: 3> review-bot rounds stop chasing bot findings; handle only failed CI, conflicts, and human comments.

## 7. Merge rules (owned by the babysit pass)

**Floor, never bypassed (GitHub enforces it; the babysit pass only checks it):** base is `<FILL IN: main>`; every required check green; an approval from a human, or from a bot listed in `merge.trusted_bot_reviewers` in `factory.json`; no unresolved threads; `mergeStateStatus` CLEAN; no `hold` label. <FILL IN: any extra floor, e.g. a "main is healthy" workflow.>

With `merge.trusted_bot_reviewers` empty (the default), every PR needs a human approval before it can merge, and the factory never merges on its own judgment alone.

**Verdict `auto` when all true:**
- Invisible to real users today: behind a default-off flag, on a feature with no released users, or purely internal (tests, stories, docs, refactor with unchanged behavior, observability).
- Additive and backward compatible: new nullable column, new endpoint, new enum value handled by consumers, new UI behind a flag. Old paths keep working during the deploy window.
- No deploy-order dependency outside this PR, or the dependency is merged and deployed.

**Verdict `hold` (a named human decides) when any true:**
- A migration that drops, renames, or rewrites data a released feature uses; any backfill.
- A shared contract consumed elsewhere: public API, event payloads, shared types used by another app, the shape of persisted records.
- Paths you mark as high risk: <FILL IN: e.g. auth, billing, secrets, infra>.
- A flag flip toward 100%, a default change on a released feature, a flag removal.
- Production data or live services touched at merge time.
- The ticket or a comment says "do not merge before <date>" (becomes a `hold` label with the date).
- A human requested changes, or a requested reviewer has not answered.
- A trusted review bot flagged the PR as needing human review. No judgment call overrides this.

**How:** verdict `auto` and the floor holds, single PR on the base branch: `gh pr merge --auto --squash`; a condition drops: `gh pr merge --disable-auto`. Stack: never arm a child whose base is a branch (auto-merge would merge it into the parent). Compute verdicts bottom-up, take the longest run of consecutive `auto` + approved + green PRs from the bottom, merge it with `gh stack merge --yes --squash <highest PR in the run>`, then `gh stack sync`; a `hold` stops the run below it. Post the verdict and reason as one PR comment that starts with `<!-- factory-merge-verdict -->` and update it in place, never a new comment per pass.

**A `hold` that only a trusted bot approved** waits on the owner, not a reviewer: request no one; the tick pings the owner, who merges it or comments what to change.

**Reviewers**, for every PR without a human approval: the `reviewers:` named in the babysit prompt (from the target's `reviewers` in `factory.json`). Only when none are named: CODEOWNERS, then the top committer of the touched files in the last 6 months, excluding the owner. Request through GitHub. <FILL IN: anyone who should never be requested by default.>

## 8. Metrics the factory reports

Human touches per PR (question comments, review rounds, nudges), merged PRs, reverts within 7 days, follow-up fixes within 30 days, needs-human rate, restarts, time from open to merge.

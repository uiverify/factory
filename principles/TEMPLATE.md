# Factory principles: <owner/repo>

<!--
One file per repo in factory.json (`repos.<name>.principles`, default `principles/<name>.md`). `bin/setup.sh` copies
this template to `principles/<name>.md` for each repo it finds in your factory.json; edit that copy, not this file.

Every worker reads `common.md` first, then this file, then the repo's CLAUDE.md. Keep this file to what differs in
this repo: how it ships, when to park, and the hard rules a worker must not bend. Point at the repo's own docs rather
than restating them.

The best source is your own history: questions agents asked you that you answered the same way every time. Each
repeated answer is a rule here, and every rule here is a question you stop getting. Delete the examples you don't
agree with.
-->

Read `common.md` in this folder first. This file holds only what differs here. The repo's `CLAUDE.md` and <FILL IN: where your decisions and product docs live, e.g. `docs/` and `decisions/`> are the source of truth; nothing here overrides them.

## Ship mode

<FILL IN: one of these, matching `ship` for this repo in factory.json, and say why in `ship_why`.>

- **`push`**: a worker lands reviewed changes straight on the base branch. Say what the last check before landing is (e.g. `pnpm verify`, or a `scripts/land.sh` that rebases, re-runs the checks and pushes), and that a lost push race is rebased and retried, never forced.
- **`pr`**: a worker opens a PR into the base branch and runs one babysit pass; the tick wakes babysit when the PR changes and tells you when it is green. You merge. Say which checks must be green.
- **`branch`** (set on a target, not a repo): a target's issues land one after another as reviewed commits on one long-lived branch; the tick pushes it and opens one PR when the target is done.

- The commit message or PR body carries `Fixes #<n>` for each issue it finishes, a short summary, and **Decisions taken**.
- One reviewable piece per landing or PR.

## Holds: changes that wait for you

<FILL IN: what never lands without you reading it first. Examples to adapt or delete:>

- A new or changed rule (a lint guard, a `CLAUDE.md` or skill rule, a hook or `.claude/settings.json`): its own branch and PR, linked on the issue; the rest of the package ships without it.
- Infrastructure the CI deploy role can't apply, a migration that drops, renames or rewrites data a released feature uses, any backfill on production.
- A user-facing change that waits on a release.

## Park instead of shipping (stop reason 5)

<FILL IN: the steps only you can do in this repo. Examples:>

- Production data, live feature flags, a customer's repo, an email or a message to a person: park with the draft.
- A key, a DNS record or a dashboard setting production needs: ship behind an "is it configured?" check when you can; otherwise park with numbered steps.
- A visual change you cannot attribute to your own diff: stop and park with the screens named. Never accept it or call it flake.

## Judgment specific to this repo

<FILL IN: the load-bearing product and architecture rules of this codebase, short and testable. Examples:>

- Show users the truth, to everyone affected. Explain numbers in the UI, do not just warn.
- Give a way forward (an action), not only an explanation.
- One shared path every entry point goes through (web, API, background jobs).
- Store the facts the product will need; one record of truth per outcome; derived state over new columns.
- Every UI surface added or changed gets a story or a visual test.
- Your flag policy: when a change needs a new feature flag and when it does not.

---
name: factory-triage
description: Classify one Linear ticket for the factory. Reads the ticket, its comments, the project documents, the scope rule and the principles file, then returns a verdict (ready | split | decide | later) with a priority, and writes a `## Verify` section into the ticket when it is ready. Invoked headless by the factory tick; can also be run by hand as "/factory-triage ABC-123".
argument-hint: <ticket key> (the tick appends the scope rule and principles path)
---

# factory-triage

One ticket in, one verdict out. No code changes, no questions to a human. Output is the JSON object the caller's schema asks for; nothing else in the final message.

## Read

1. The ticket (`get_issue`), its comments, linked PRs, and the project's documents (`list_documents` for the project: UX spec, Architecture, Defaults, Decision log) if they exist.
2. The scope rule and the principles file path given in the prompt (`FACTORY_PRINCIPLES` env holds the same path). Read the principles file.
3. Enough of the codebase to judge size and risk: the two nearest files for the area named in the ticket. Do not plan the implementation.

## Decide

Pick exactly one verdict:

- **ready**: inside the scope rule; one PR stack of at most 3 reviewable PRs; the behavior is clear from the ticket plus documents; no product fork left open; no new table, new external integration, or released-data migration. Set `priority` (1 urgent, 2 high, 3 medium, 4 low): customer-visible bug > data correctness > observability > polish. If the ticket lacks a `## Verify` section with yes/no acceptance lines, write one (3–8 lines, each a check a verifier can answer yes or no by running the product or the tests) and save it into the description with `save_issue`, keeping the rest of the description intact. Set `verify_added: true` when you did.
- **split**: the idea is in scope but larger than one stack of 3 PRs. Create the sub-tickets yourself with `save_issue` (same project and milestone, `blocks`/`blocked by` relations in build order, each with its own `## Verify`), link them from a comment on the parent, and leave the parent in Backlog. Verdict `split`, priority of the parent.
- **decide**: a UX, architecture, or product fork the documents and principles do not settle, and users would notice the difference. Write one comment: the fork in plain words, 2–4 options, a recommended one, and why. Do not @mention anyone; the dashboard lists it under "Needs your call".
- **later**: outside the scope rule (new capability, V2, speculative hardening with zero prod occurrences, or "nice to have" with no user asking). One-line reason.

Duplicates: search first (`list_issues` with 3–4 title keywords, open and recently closed). A duplicate is marked `later` with the reason "duplicate of ABC-123" and a `duplicate` relation added.

## Rules

- Never ask a human. If you cannot decide, the verdict is `decide`.
- Never change status or labels yourself; the tick does that from your JSON.
- Keep the `reason` under 200 characters; it goes on the ticket.
- Prefer `later` over `ready` when unsure about scope. Prefer `ready` over `decide` when the principles file answers the question.

## Output

Final message is only the JSON object: `{"verdict": "...", "priority": 1-4, "reason": "...", "verify_added": true|false}`.

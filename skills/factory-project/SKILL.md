---
name: factory-project
description: Project intake for the factory, done with the owner in one sitting. Turns "I want to build X" into the Linear project documents the workers read (UX spec, Architecture, Defaults, Decision log), a target scope rule, and a ticket tree in stack order, so that workers can run unattended without asking UX or architecture questions. Use for "/factory-project", "kick off this project for the factory", "spec this feature for the factory".
argument-hint: <project or feature intent, or an existing Linear project / milestone>
---

# factory-project

This is the one place the human spends real time. The goal is that no worker later needs to ask what the product should do. Go back and forth with the owner here; this skill is interactive by design. Everything else in the factory is not.

## 0. Frame and place it in Linear

Read the principles file (`FACTORY_PRINCIPLES` env or `~/.claude/factory/principles/principles.md`), the repo's product docs for the area, and the Linear workspace: `list_projects` for related projects, their milestones, and any existing tickets or documents that touch this intent (search 3 to 4 title keywords). Restate the intent in five lines.

Then decide where it lives and say so in one sentence with a recommendation, e.g. "This is a new module inside Billing; I'd add a milestone 'Invoices export' there rather than a new project, because the tickets share that project's labels, docs and release plan." A separate project only when the work has its own lead, its own release plan, or spans several existing projects. The owner says yes or redirects; then **create it** (`save_milestone` or `save_project`) and move any existing related tickets into it. The owner never creates Linear containers by hand.

Agree the **target** (that project or milestone) and a one-sentence **scope rule** ("what this target does not do"). Agree the rollout: flag name, who sees it, when it flips.

## 1. UX spec (deep where rework is expensive, shallow where it is cheap)

Produce the Linear document **"UX spec"** on the project with:

- **Flows**: every user flow as numbered steps, entry points and exits, naming the existing equivalent flow where one exists ("same as X, except...").
- **State-by-surface table**: rows are states (empty, loading, partial, error, limit reached, disconnected, paused...), columns are surfaces (list row, detail page, settings, notifications, public API...). Each cell says what the user sees and can do. This table alone removes a large share of the questions workers would otherwise ask.
- **Glossary**: every metric, label, status word and count with its exact meaning and where it shows.
- **Limits and errors table**: every provider limit and error class, what the user sees, what the system does (pause, retry, end cleanly).
- **Copy principles** for the area, and only the copy that carries product meaning. Pixel-level layout is left to the worker and your visual tests.
- **Out of scope** list, explicit.

Ask the owner only about forks that change what a user sees; recommend a default for each. Do not ask about internals.

## 1b. Low-fidelity visuals (optional, when a design tool is connected)

A text spec is not enough to see a flow. If the session has a design tool (for example the Figma MCP server), produce a flows board (one diagram per scenario, under ~25 nodes each, ending in the outcomes the user sees) and grayscale wireframes (one frame per screen in the state-by-surface table, plus one per state that changes the screen's shape, with real copy from the spec). Low fidelity only. Link them from the top of the UX spec, and add them to the target's `links` in `factory.json` so the dashboard shows them and workers find them. Walk the owner through them and fold corrections back into the UX spec first.

## 2. Architecture

Before any architecture, write the **end-state story** at the top of the Architecture document and get the owner's yes on it: in ten plain lines, how the feature works in production when it is finished, what gets written where, what the user sees on each screen, and how it migrates into whatever replaces it. Every provider limit or numeric default that shapes the product (check interval, page size, caps, retention) goes in a **Defaults and limits** table with the trade-off and the alternative, never silently in the body. Defaults inherited from a prototype without being surfaced are the ones the owner later finds by reading the document.

Then produce the Linear document **"Architecture"**: data model (tables, columns, the stable ids), the one shared path every surface goes through, events and queues, flags, migration and backfill order, external dependencies, what is explicitly reused, and the invariants (tenancy scoping, idempotency, ordering). Run `/design` on it if it introduces a new subsystem, table, or data flow; the critique panel is cheap compared with ten workers building on a wrong shape. **If the owner changes the shape materially after the critique, run one more critique round on the revised design before writing tickets**; a design that was critiqued and then rewritten is uncritiqued. Record alternatives dropped.

Questions to the owner use product words only. Never name internal parts you invented in a question; say what the user or the system does. When a question depends on how a provider behaves, state that behavior in one sentence first.

## 3. Defaults

Produce the Linear document **"Defaults"**: a when-in-doubt table for this target (naming, placement, test strategy, flag use, error handling, telemetry), plus the "Decisions already made" list that workers must not reopen.

## 4. Decision log

Create the Linear document **"Decision log"** with the header and the first entries (the decisions taken in steps 1 to 3). Workers append one line per decision (`date · ticket · PR · decision · alternative · why`).

## 5. Ticket tree

Create or update tickets with `save_issue`: thin vertical slices, one PR stack of at most 3 PRs each, each with `## Verify` yes/no lines, `blocks`/`blocked by` relations in build order, priority set, in the agreed project and milestone, status **Backlog** (the factory's triage moves them to Todo). Name the base slice first ("barebone end to end behind the flag"), then the slices that make it real, then polish. Never create a ticket for work the scope rule excludes; list those under "Later" in the UX spec instead.

## 6. Hand over and start

Add or update the target in `~/.claude/factory/factory.json` (`name`, `project`, `milestone`, `scope_rule`, `max_in_flight`, default 3 for a new module, `reviewers`, `links`). Summarize to the owner: the documents, the ticket count by slice, the scope rule, and the open forks they still owe an answer on (there should be none). Then ask one question: "Start the factory on this target now?" On yes, run the `factory-run` skill with `start` (it installs the tick and dashboard if needed and runs the first pass) and show the dashboard link and the first tick's result.

---
name: factory-project
description: Project intake for the factory, done with the owner in one sitting, in any repo the factory knows. Turns "I want to build X" into a spec the workers read, a batch of GitHub issues in build order in the right repo, a scope rule and a factory target, so workers can run unattended without asking UX or architecture questions. Use for "/factory-project", "kick off this project for the factory", "spec this feature for the factory", "put this on the factory".
argument-hint: <project or feature intent, or an existing batch issue>
---

# factory-project

This is the one place the human spends real time. The goal is that no worker later needs to ask what the product should do. Go back and forth with the owner here; this skill is interactive by design. Everything else in the factory is not.

## 0. Frame it and pick the repo

Read `~/.claude/factory/factory.json` (the repos and their targets), `~/.claude/factory/issues.md`, `principles/common.md` and the repo's principles file. Decide which repo the work lives in from the intent and say so in one line; a repo not in `repos` is added with `/factory-run add repo` first.

In that repo, read `CLAUDE.md`, its decision log and the plan or product docs for the area (whatever the repo keeps), and the open issues that touch the intent (`gh issue list -R <repo> --state all --search "<3-4 words>"`, and existing `batch` parents). Restate the intent in five lines, naming the user job or decision it serves.

Then decide where it lives and say so with a recommendation: a new batch parent issue, or new sub-issues under an existing batch. The owner says yes or redirects; then create it and move related existing issues under it as sub-issues. The owner never creates issues or labels by hand.

Agree the **target** (the batch parent, plus labels when needed) and a one-sentence **scope rule** ("what this target does not do"). Agree the rollout: flag, who sees it, when it flips.

## 1. Spec (deep where rework is expensive, shallow where it is cheap)

Write the spec into the batch parent's body (or a committed doc it links when the repo keeps specs in files; follow the repo's convention):

- **Flows**: every user flow as numbered steps, entry points and exits.
- **State-by-surface table**: rows are states (empty, loading, partial, error, permission denied, offline…), columns are surfaces (each page or component, email, API). Each cell says what the user sees and can do.
- **Glossary**: every label, status word and number with its exact meaning and where it shows.
- **Limits and errors**: every limit and error class, what the user sees, what the system does.
- **Copy principles** for the area, and only the copy that carries product meaning. Pixel layout is left to the worker and the visual check.
- **Out of scope**, explicit.

Ask the owner only about forks that change what a user sees; recommend a default for each. Do not ask about internals.

## 1b. Low-fidelity visuals in HTML (always, right after the spec)

A text spec is not enough to see a flow. Make two files in `~/.claude/factory/projects/<target name>/`, the folder every worker of the target reads. Low fidelity only: grayscale boxes and labels, system font, no design-system components, no pixel work; the workers and the repo's visual check handle the real UI later. Each file is self-contained (inline CSS and SVG, no external scripts, fonts or images) so it opens by double-click from `file://`.

1. **`flows.html`**: one diagram per scenario, each under ~25 boxes, drawn as inline SVG or CSS boxes with arrows: (a) create and manage, from every entry point through each action; (b) what the system does on each run or event, as a decision tree ending in the outcomes the user sees; (c) one more per distinct flow in the spec that doesn't fit the first two. Green for the happy outcome, gray for skipped or hidden, amber for decisions, red for errors.
2. **`wireframes.html`**: one grayscale frame per screen in the state-by-surface table, plus one per state that changes the screen's shape (empty, loading, error, offline, permission denied). Real copy from the spec (labels, buttons, empty-state text, banners), at the widths the repo cares about, with numbered notes between frames for the flow order. Also a frame for any existing screen the feature touches.
3. Open both in a browser (Playwright), screenshot each to `~/.claude/factory/projects/<target>/shots/`, and fix only what is unreadable. If your client only shows images from inside the current workspace, copy the screenshots there and embed those copies.
4. **Link them**: a "Visuals" section at the top of the batch parent's body with the two paths (they live on the owner's machine, like the issue flow), and `"design": "~/.claude/factory/projects/<target>"` on the target in `factory.json` so the tick hands the folder to every worker.
5. Walk the owner through them in one message with the screenshots inline: what each flow shows, what you had to invent, which frames to look at. Fold their corrections into the spec first, then the HTML.

## 2. Architecture

First an **end-state story** at the top: in ten plain lines, how it works in production, what gets written where, what the user sees. Every limit or numeric default that shapes the product goes in a **Defaults and limits** table with the trade-off and the alternative, never silently in the body.

Then the architecture: data model, the one shared path every surface goes through, events, flags, migration order, what is reused, the invariants the repo's `CLAUDE.md` names. Run the repo's `/design` on it if it introduces a new subsystem, table or data flow. If the owner changes the shape materially after the critique, critique the revised design once more before writing issues.

Questions to the owner use product words only, never names of internal parts you invented.

## 3. Defaults and decisions

Add a **Defaults** section: a when-in-doubt table for this target (naming, placement, test strategy, flag use, error handling, telemetry) and the decisions workers must not reopen. Decisions the owner explicitly made in this sitting go into the repo's decision log when it keeps one (record as their choice only what they chose; name your proposals as proposals). Workers record their own choices as `<!-- factory-note -->` comments on the batch parent.

## 4. Issues

Create the sub-issues per `issues.md` §2 and §3: thin vertical slices, each one worker's job (one PR, or a few commits in a push repo), kept on the small side: when a piece is big (a whole component with many states), split it into several slices along its seams rather than one long session. Smaller PRs and shorter agent sessions are almost always better. Each slice gets `## Verify` lines and the three labels, "blocked by" relations in build order, and is attached to the batch parent. The base slice first ("barebone end to end behind the flag"), then the slices that make it real, then polish. Never create an issue for work the scope rule excludes; list those under "Later" in the spec. Leave them without `factory:` labels so triage looks at each, or add `factory: ready` to the ones you and the owner already agreed are clear.

## 5. Hand over and start

Add the target to `~/.claude/factory/factory.json` (`name`, `repo`, `batch`, `labels` if any, `scope_rule`, `design`, `max_in_flight`, default 2; PR repos also `max_awaiting_review`), paused. Summarize to the owner: the spec, the issue count by slice, the scope rule, and any open fork they still owe an answer on (there should be none). Then ask one question: "Start the factory on this target now?" On yes, unpause it and run `factory-run start` (it installs the tick and dashboard if needed and runs the first pass), and show the dashboard link and the first tick's result.

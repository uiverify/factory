---
name: factory-plan
description: Group ready GitHub issues into work packages for factory workers. Each package is built by one worker in one worktree, in the given order. Invoked headless by the factory tick with the issue list in the prompt; returns JSON only.
argument-hint: (the tick supplies the repo, ship mode and issue list)
---

# factory-plan

Input: a repo, its ship mode, and a list of ready issues (number, labels, batch parent, title, first lines). Output: packages.

A package is **one change**: the worker designs, reviews, verifies and ships it as one commit (or one PR) that fixes all its issues. Group issues a reviewer would want to read as one diff; anything else is its own package, and runs in parallel with a fresh worker.

## Group when

- Two issues touch the same module or the same files (judge from titles and descriptions; open the two nearest files only if genuinely unsure).
- Siblings in one batch whose pieces build on each other.
- One issue's change is a precondition for another's (schema before code, helper before callers).
- Issues are the same kind of fix across one area (three copy fixes on one page; two guards in one service).

## Keep apart when

- Different areas of the codebase with no shared files.
- Different risk: a migration, a shared-contract change or anything likely to park for the owner does not share a package with safe polish, because one park holds the whole package.
- A package would exceed the maximum size given in the prompt.

## Ship mode "branch"

One worker builds a long-lived branch one package at a time, so a single doesn't run in parallel: it pays its own design and review loop while everything else waits. Group more readily there. Issues in one area or one subsystem (the same read layer, the same merge rule, the same writer) share a package even when their files differ, up to the maximum size. Keep a single only for the risk cases above or an issue that shares nothing with the rest.

## Order inside a package

Preconditions first: schema, then logic, then UI, then docs and stories. Highest priority first when nothing else decides it.

## Rules

- Every input issue appears in exactly one package. Singles are fine and common.
- No questions, no code, no GitHub writes. Final message is only the JSON: `{"packages": [{"issues": [12, 15], "reason": "..."}]}` with `reason` under 120 characters.

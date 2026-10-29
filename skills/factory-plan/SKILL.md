---
name: factory-plan
description: Group ready Linear tickets into work packages for factory workers. Each package is one PR stack built by one worker, ordered bottom to top. Invoked headless by the factory tick with the ticket list in the prompt; returns JSON only.
argument-hint: (the tick supplies the ticket list)
---

# factory-plan

Input: a list of ready tickets (key, priority, title, first lines). Output: packages.

## Group when

- Two tickets touch the same module or the same files (judge from titles and descriptions; open the two nearest files only if genuinely unsure).
- One ticket's change is a precondition for another's (schema before code, helper before callers).
- Tickets are the same kind of fix across one area (three copy fixes on one screen; two guards in one service).

## Keep apart when

- Different areas of the codebase with no shared files.
- Different risk bands: a migration or a shared-contract change does not share a package with UI polish, because the package merges bottom-up and the risky PR would block the safe ones.
- A package would exceed the maximum size given in the prompt, or more than one PR in it would need a human reviewer.

## Order inside a package

Bottom of the stack first: schema, then service logic, then UI, then docs and stories. Dependencies before dependents. Highest priority ticket first when nothing else decides it.

## Rules

- Every input ticket appears in exactly one package. Singles are fine and common.
- No questions, no code, no Linear writes. Final message is only the JSON: `{"packages": [{"tickets": ["ABC-1", "ABC-2"], "reason": "..."}]}` with `reason` under 120 characters.

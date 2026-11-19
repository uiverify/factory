---
name: factory-triage
description: Classify one GitHub issue for the factory. Reads the issue, its comments, its batch parent, the scope rule, the principles and the shared issue flow, then returns a verdict (ready | split | decide | human | later) with a priority, and writes a `## Verify` section into the issue when it is ready. Invoked headless by the factory tick; can also be run by hand as "/factory-triage acme/app#123".
argument-hint: <owner/repo#number> (the tick appends the scope rule, principles path, issue flow and ship mode)
---

# factory-triage

One issue in, one verdict out. No code changes, no questions to a human. Output is the JSON object the caller's schema asks for; nothing else in the final message.

## Read

1. The issue with its comments: `gh issue view <n> -R <repo> --comments`. Its batch parent and siblings if it has one (`gh api repos/<repo>/issues/<n> --jq .parent_issue_url`, then the parent's body and `sub_issues`). Linked PRs and commits.
2. The scope rule, the principles file (`principles/common.md` beside it, then the repo's file) and the issue flow (`~/.claude/factory/issues.md`), all named in the prompt.
3. The repo's `CLAUDE.md` and enough of the codebase to judge size and risk: the two nearest files for the area. Do not plan the implementation.

## Decide

Pick exactly one verdict:

- **ready**: inside the scope rule; one worker can finish it (one PR, or a few commits in a push repo); the behavior is clear from the issue plus documents; no product fork left open; nothing only the owner can do. If the issue lacks a `## Verify` section of yes/no lines, write one (3 to 8 lines, each answerable by running the product or the tests) and save it into the body with `gh issue edit <n> -R <repo> --body-file <file>`, keeping the rest intact. Set `verify_added: true` when you did.
- **split**: in scope but too big for one worker. Make the issue a batch (`issues.md` §3): create the sub-issues per `issues.md` §2 (same labels as the parent, each with its own `## Verify`, blocked-by relations in build order, each still matching the target's labels), attach them, add `batch` to the parent. Verdict `split`.
- **decide**: a UX, architecture or product fork the documents and principles do not settle, and users would notice. Post one comment starting with `<!-- factory-note -->`: the fork in plain words, 2 to 4 options, the recommended one and why.
- **human**: the work needs a step only the owner can do (an account, a payment, a post, outreach, playing or reading something, a privileged deploy) and there is no code part a worker could do first. When there is a code part, it's `ready` and the worker parks at the human step.
- **later**: outside the scope rule (new capability, speculative hardening with no occurrence, nice-to-have no one asked for), or a duplicate. Search first (`gh issue list -R <repo> --state all --search "<3-4 title words>"`); a duplicate's reason is "duplicate of #N".

Also return:
- `priority`: `medium` or `low`, used only when the issue has no priority label (customer-visible bug > data correctness > observability > polish). Never `high`: only the owner sets it.
- `stream`: the `stream:` label the issue should carry (the part after `stream: `, one the repo already has), `""` when unsure. `kind`: `bug`, `feature`, `rollout` or `task`, `""` when unsure. The tick adds these only when missing.

## Rules

- Never ask a human. If you cannot decide, the verdict is `decide`.
- Never change labels yourself (except `batch` on a split); the tick applies them from your JSON.
- Keep `reason` under 200 characters; it goes on the issue.
- Prefer `later` over `ready` when unsure about scope. Prefer `ready` over `decide` when the principles answer the question.

## Output

Final message is only the JSON object: `{"verdict": "...", "priority": "medium|low", "stream": "...", "kind": "...", "reason": "...", "verify_added": true|false}`.

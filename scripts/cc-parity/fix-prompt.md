# Claude Code parity — Fix-an-existing-PR prompt

> The orchestrator (`orchestrate.ts`, `fixPr()`) substitutes the
> `{{...}}` placeholders before handing this prompt to
> `@anthropic-ai/claude-agent-sdk`'s `query()`. Keep placeholders in
> sync with `renderFixPrompt()` in `orchestrate.ts`.

You are fixing an **existing cc-parity pull request** on the
**Claudius** codebase. The orchestrator has already checked out the
PR's head branch `{{BRANCH}}` for you — the working tree is on that
branch with all of the PR's commits present. `node_modules/` is
installed.

- **PR:** #{{PR_NUMBER}} — {{PR_TITLE}}
- **URL:** {{PR_URL}}

The PR was opened by the cc-parity pipeline (sibling to the SDK
updater) and proposes that Claudius reimplement features Claude Code
shipped in a recent release. The PR body lists the bucketing (A / B /
C) the bot chose and the bucket-B items it shipped. The PR may be a
draft because a gate failed (lint / test / build / e2e) or because a
reviewer asked for changes.

---

## What you're asked to do

{{INSTRUCTION_BLOCK}}

Whatever the instruction above says, your concrete objective is an
**all-green branch**: every gate (`lint`, `test`, `build`, `test:e2e`)
passing, with the PR's intent preserved. Don't undo a shipped bucket-B
item to make the suite pass — fix the actual problem the gate caught.

If the review feedback says the bot's classification (A/B/C) was
wrong on a specific entry, take the reviewer's call: drop the
implementation if the entry was actually bucket A (covered by the SDK
updater) or bucket C (CLI-only), or extend it if a `[skip — ambiguous]`
turned out to be a real bucket-B item.

---

## Current CI checks

This is the latest `gh pr checks` output for the PR. Failing or
pending rows are where to start:

```
{{CI_CHECKS}}
```

## Review feedback

Reviewer verdicts and comments on the PR. Address every actionable
one (or, if you disagree, leave the code as-is and note why in a
commit message so the reviewer can see your reasoning):

{{REVIEW_COMMENTS}}

---

## How to work

1. **Reproduce the failure locally first.** Run the gate command for
   whichever check is red (`bun run lint`, `bun run test`,
   `bun run build`, `bun run test:e2e`) and read the actual error.
2. **Fix the root cause, not the symptom.** If a test is failing
   because the behaviour genuinely changed, update the test to match
   the correct behaviour — never delete or `.skip` a test, disable a
   lint rule, or `--no-verify` a commit to force green.
3. **Keep changes scoped to this PR's purpose** plus whatever is
   needed to make it green. Don't fold in unrelated refactors.
4. **If the reviewer asked for a UX change**, redesign the affected
   bucket-B item to match. Update the run-notes file
   (`.claudius/cc-parity/run-notes/<version>.md`) to reflect the new
   shape and the rejected alternative.
5. **Commit as you go** with informative messages on `{{BRANCH}}`.
   The orchestrator pushes the branch for you after you finish — you
   do not need to push, open, or edit the PR yourself.

## Definition of done

You are **not done** until all of the following are true. The
orchestrator re-runs the gate after you exit and reports the result
to the community channel; if it's still red the PR stays flagged for
a human.

1. `bun run lint` — zero errors across the whole repo.
2. `bun run test` (vitest) — every spec passes.
3. `bun run build` — production build succeeds.
4. `bun run test:e2e` (Playwright, chromium project) — every spec
   passes. If the browser isn't installed, run `make test` once.
5. The working tree is clean — everything you changed is committed
   on `{{BRANCH}}`.

## Hard constraints

- **Never** edit files under `node_modules/`.
- **Never** disable a test, hook, or lint rule to make the suite
  green.
- **Never** `--no-verify` on commits or `--force` on pushes.
- **Never** rewrite history on `main` or on any branch other than
  `{{BRANCH}}`.
- If you get genuinely stuck (a failing check you can't fix,
  ambiguous feedback), commit what you have with a message explaining
  the blocker, and **stop** — the orchestrator will report the
  remaining red gate to the channel for a human to pick up.

Now start. The branch is checked out and dependencies are installed.
Begin by reproducing the first failing check.

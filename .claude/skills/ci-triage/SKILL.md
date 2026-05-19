---
name: ci-triage
description: Find the latest GitHub Actions run on the current branch, read the failure if any, and decide whether the bug is in the test or in the production code — then propose a fix the user can OK. Use whenever the user says "check the build", "check latest github build status", "what broke CI", "why is CI red", or asks you to look at GitHub Actions output for this branch.
allowed-tools:
  - Bash
  - Read
  - Edit
  - Grep
  - Glob
---

# Triage the latest GitHub Actions run

Goal: in one pass, answer three questions for the user:

1. Did the latest run pass, fail, or get cancelled?
2. If it failed: *what specifically broke* (job, step, test name, assertion)?
3. Is the failure a **test bug** (assertion is stale relative to intended new behavior) or a **code bug** (production regression)? Propose a concrete fix either way, but **do not edit anything until the user OKs the proposed diff**.

This skill assumes the repo has GitHub Actions and the `gh` CLI is authenticated. The CI workflow in this repo is `.github/workflows/ci.yml` (jobs: `lint`, `unit`, `setup-script`, `e2e`).

## Steps

### 1. Find the run

```bash
BRANCH=$(git rev-parse --abbrev-ref HEAD)
gh run list --branch "$BRANCH" --limit 5 \
  --json databaseId,workflowName,status,conclusion,headSha,createdAt
```

Pick the most recent `ci` workflow run for `$BRANCH`. If there are multiple in-flight, pick the newest — older ones may already be cancelled by `concurrency.cancel-in-progress`.

Report the run state up-front in one line:
- `queued` / `in_progress` → tell the user, offer to either wait (use a `Monitor` poll-loop on `gh run view <id> --json status,jobs`) or bail.
- `success` → done, say so, stop.
- `cancelled` → check if a newer commit superseded it. Run `git fetch && git log --oneline origin/$BRANCH -3`. If `origin/$BRANCH` moved past the run's `headSha`, the cancellation is expected — point at the newer run and re-triage that.
- `failure` → continue to step 2.

### 2. Identify the failing job and step

```bash
gh run view <RUN_ID> --json jobs \
  --jq '.jobs[] | select(.conclusion=="failure") | {name, databaseId,
        failedStep: (.steps | map(select(.conclusion=="failure")) | .[0].name)}'
```

For each failing job, pull only the failed step's logs:

```bash
gh run view --job <JOB_ID> --log-failed
```

The output can be tens of KB. Use `Read` on the persisted file rather than re-`gh`-ing.

### 3. Extract the failing assertion

Map the failure to a concrete file:lineno + assertion. Patterns:

- **Playwright**: grep for `✘` and the spec path. The error block under `1) [chromium] ...` has the locator / `expect(...)` call and a `> NNN |` source pointer.
- **Vitest**: grep for `FAIL ` and `AssertionError`. The stack trace points at `tests/unit/...:LINE`.
- **ESLint**: lines like `/path/file.ts:LINE:COL  error  message  rule-id`. Note the `rule-id` — it tells you whether the fix is mechanical (e.g. `prefer-const`) or substantive.
- **Setup-script**: bash assertion failure — grep for `FAIL` or the trap line; usually a permissions / install-order regression.

### 4. Test bug or code bug?

Read **both** sides before deciding:

- The failing assertion (test file, exact line).
- The production code path the assertion exercises. Use `Grep` for the selector / route / function name to find the source.

Heuristic, in order:

1. **Did the production code intentionally change behavior in the last few commits?** `git log --oneline -10 -- <prod-file>`. If yes and the test asserts the *old* behavior, it's a **test bug** — update the test to assert the new contract.
2. **Was the production code untouched but the test newly added or recently modified?** Likely a **test bug** — the new test caught a real issue the author didn't realize, OR the test's setup is wrong. Read the test setup carefully.
3. **Both the production code and the test were untouched recently?** Likely a **flake** (timing, parallelism, port conflict) — name the most likely cause and propose a retry / `test.fixme` / wait-for-condition fix. Don't silently swallow it; surface the suspicion.
4. **Production code was changed, the test is unchanged, and the test's assertion describes a contract that should still hold?** **Code bug** — the change broke a real invariant. Point at the line in the production change that violated the contract.

When in doubt, surface the conflict rather than pick a side: *"the test asserts X; the new production code returns Y; either the test's expectation is stale (we changed the public response shape intentionally) or the code regressed. Which is it?"*

### 5. Propose the fix — do not edit yet

Hand the user back:

- One-sentence diagnosis ("test bug — selector matches the pre-refactor href").
- The specific file:line(s) that need to change.
- The exact diff hunk (use a fenced block, not the Edit tool).
- One sentence on what the user should verify before approving (usually "re-run the spec locally" or "check that the new assertion matches the intended contract").

**Wait for the user to say go.** Only then apply the edit + re-run the failing test/lint locally. Local repro:

- Playwright spec: `bunx playwright test <path> --project=chromium --reporter=line`
- Vitest test: `bunx vitest run <path>`
- Lint: `bun run lint <path>`

### 6. After applying — verify, don't push

After the edit + local re-run pass, summarize what changed and stop. Do **not** `git commit` or `git push` unless the user explicitly says so — they may want to batch the fix with other work, or write the commit message themselves.

## What NOT to do

- **Don't fetch and dump 50 KB of CI log into the chat.** Pull failed-step-only logs (`--log-failed`), then `Read` from the persisted file.
- **Don't trust the test as gospel.** A red test can mean the test is wrong. Read the production code before deciding.
- **Don't apply a `test.fixme` or `--retry` band-aid without naming the suspected root cause.** Flakes deserve a hypothesis, not silencing.
- **Don't auto-commit.** This skill triages and proposes — the user holds the commit pen.
- **Don't reach for `gh run rerun` to "see if it was a flake"** unless you've already read the failure and the evidence genuinely points at non-determinism. Re-runs cost minutes and burn carbon.

## Quick reference

| What | Command |
| --- | --- |
| Latest runs on branch | `gh run list --branch "$(git rev-parse --abbrev-ref HEAD)" --limit 5 --json databaseId,workflowName,status,conclusion,headSha` |
| Job summary | `gh run view <RUN_ID> --json jobs --jq '.jobs[] \| {name, conclusion, databaseId}'` |
| Failed-step logs only | `gh run view --job <JOB_ID> --log-failed` |
| Download artifacts | `gh run download <RUN_ID> -n playwright-report -D /tmp/pw-report` |
| Re-run a spec locally | `bunx playwright test tests/e2e/<spec>.ts --project=chromium --reporter=line` |

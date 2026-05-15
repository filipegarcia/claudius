# SDK Update — Claude Run Prompt

> The orchestrator (`orchestrate.ts`) substitutes the `{{...}}` placeholders
> before handing this prompt to `@anthropic-ai/claude-agent-sdk`'s `query()`.
> Keep placeholders in sync with `buildPrompt()` in `orchestrate.ts`.

You are upgrading the **Claudius** codebase from
`@anthropic-ai/claude-agent-sdk@{{PREVIOUS_VERSION}}` to
`@anthropic-ai/claude-agent-sdk@{{NEW_VERSION}}`.

The orchestrator has already:

1. Checked out a fresh branch `sdk-update/{{NEW_VERSION}}` from `origin/main`.
2. Bumped `dependencies."@anthropic-ai/claude-agent-sdk"` in `package.json`
   to `^{{NEW_VERSION}}` and run `bun install` so `node_modules/` is on
   the new version.
3. Cleared any previous run notes from
   `.claudius/sdk-updater/run-notes/{{NEW_VERSION}}.md`. **You will
   write a fresh copy of this file** as you go (see "Run notes" below).

The full changelog between the two versions is below in
`{{CHANGELOG_BLOCK}}`. **Read it first.**

---

## Definition of done

You are **not done** until **all** of the following are true. There is no
"good enough" exit — the orchestrator will check these before opening
the PR.

1. `bun run lint` — zero errors across the whole repo.
2. `bun run test` (vitest) — every spec passes.
3. `bun run build` — production build succeeds.
4. `bun run test:e2e` (Playwright, chromium project) — every spec passes.
   - The Playwright browser is already installed on the runner. If it
     isn't, run `make test` once which installs it.
5. Every **user-facing capability** added or changed in
   `{{CHANGELOG_BLOCK}}` has a corresponding UI surface in `app/` or
   `components/`. See "Web component coverage" below for what counts.
6. Every **already-implemented feature** that uses a renamed/removed/
   reshaped SDK export is updated. Grep `lib/` and `app/` for the old
   names before declaring this branch done.
7. You have written `.claudius/sdk-updater/run-notes/{{NEW_VERSION}}.md`
   summarising what changed in our code, what changelog items you
   shipped, and what you deliberately did not ship (with reasons).
   The orchestrator reads this file to fill in the PR body.
8. The working tree is clean — every file you touched is committed on
   `sdk-update/{{NEW_VERSION}}` with informative messages.

If a budget exhaustion forces the orchestrator to stop before all of
the above are green, the PR will be opened as **draft** with the label
`needs-human`. Aim to finish; don't aim for "draft is fine".

---

## How to work

### Step 1 — Read the changelog and the SDK source

- Read `{{CHANGELOG_BLOCK}}` fully. Note **breaking changes**, **new
  features**, **deprecations**, and **behaviour-changed** items
  separately — you'll triage them differently.
- Open `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` and skim
  the exports you don't recognise from the changelog. The `.d.ts` is
  the source of truth for shapes; the changelog is the source of
  truth for intent.

### Step 2 — Audit existing usage

Run `rg -n "@anthropic-ai/claude-agent-sdk"` to find every importer.
Treat `lib/server/session.ts` as the centre of gravity — most SDK
contact happens there, with the rest in `lib/client/`, `lib/shared/`,
and a handful of `lib/server/` helpers.

For every breaking change in the changelog: confirm whether the old
shape is in use, and migrate.

### Step 3 — Implement new features

For each new capability in the changelog, decide:

- **Wire it through end-to-end** if it maps onto something a Claudius
  user would do in the browser (new tool, new permission mode, new
  event type, new session option, new MCP transport, etc.).
- **Wire just the type layer** if it's a developer-facing addition
  with no user-visible behaviour (e.g. a new internal callback signature).
- **Skip with a note in `run-notes`** if it is genuinely irrelevant to
  Claudius (e.g. a CLI-only feature, a Bedrock-specific option when
  Claudius targets the first-party API).

When you skip something, justify it in the run-notes file. The next
human who reviews this PR shouldn't have to guess.

### Step 4 — Web component coverage

For every **user-facing capability** you wired in step 3, ensure
there is a UI surface that exposes it. "User-facing capability"
means: a thing a developer using Claudius can now do, see, or
configure that they couldn't before.

- Prefer extending an existing component over creating a sibling.
- New pages go under `app/<route>/page.tsx` following the App Router
  conventions in `AGENTS.md` and `CLAUDE.md` (read those first if
  you haven't).
- Server-only modules stay under `lib/server/`. Browser-safe
  helpers go under `lib/client/`. Shared types under `lib/shared/`.
- Tailwind v4 — no `tailwind.config.*`. Theme lives in
  `app/globals.css` under `@theme`.

**Do not create a junk component for every newly-exported TypeScript
type.** Components exist to surface user-facing behaviour, not to
mirror the type tree.

### Step 5 — Tests

For every new component, hook, server module, or behaviour change:

- **Pure logic & SQLite round-trips** → vitest, alongside the code.
  Look at `lib/server/sessions-store.ts` neighbours for the existing
  style.
- **End-to-end user flow** → Playwright spec under `tests/e2e/`. Use
  the existing helpers — see `tests/e2e/` neighbours for the
  fixture conventions. Prefer `data-testid` over CSS selectors.
- If a changelog change can only be exercised against the real
  agent, use the `chromium-live` project (only when you really need it).

After adding tests, run the full suites listed in "Definition of
done" until they all pass. If a pre-existing failure surfaces that is
unrelated to the SDK bump, **fix it** — the orchestrator's exit gate
doesn't distinguish "yours" from "theirs".

### Step 6 — Screenshots

For each new screen or materially-changed screen, capture a PNG
using the existing screenshot harness:

```bash
bun run site:screenshots
```

Commit the new PNGs under `docs/sdk-updates/{{NEW_VERSION}}/`. The
PR template references them via `raw.githubusercontent.com` so they
render in the GitHub UI. Filename convention:
`docs/sdk-updates/{{NEW_VERSION}}/<short-slug>.png`.

If the changelog adds **no** user-visible UI surface, you don't need
screenshots — say so in the run-notes file.

### Step 7 — Commit cadence

Make focused commits as you go, not one monolithic commit. Suggested
breakdown:

- `chore(deps): bump claude-agent-sdk to {{NEW_VERSION}}` — package.json + lockfile only.
- One commit per migrated subsystem (e.g. `refactor(session): adopt new permissionMode signature`).
- One commit per new feature/component.
- `test(sdk-update): cover new <thing>` commits.
- `docs(sdk-update): notes for {{NEW_VERSION}}` — the run-notes file.

Follow the existing commit style — look at `git log --oneline -20`
before your first commit.

### Step 8 — Final sweep

Before declaring done:

1. Run all four checks in "Definition of done" one more time **in one
   sweep** — failures sometimes only show up when run cold.
2. Run `bun run lint` scoped to every file you touched. Don't dismiss
   errors as "pre-existing"; if you touched the file, you own it now.
3. Confirm `git status` is clean and `git log --oneline origin/main..HEAD`
   reflects the commit cadence above.

---

## Run notes file

Write `.claudius/sdk-updater/run-notes/{{NEW_VERSION}}.md` with this
shape (the orchestrator parses it into the PR body):

```markdown
## Summary

One paragraph: what changed in the SDK, what we changed in Claudius,
and the headline risk.

## SDK changelog highlights

- Bulleted list lifted from the upstream changelog, only items
  relevant to Claudius. Mark each with [shipped] / [type-only] /
  [skipped — reason].

## Code changes

- Bulleted list of every meaningful file or subsystem touched, with
  one-line justifications.

## New UI surfaces

- One bullet per new/changed screen, with the screenshot path under
  `docs/sdk-updates/{{NEW_VERSION}}/`.

## Tests

- vitest: <count> new specs, <count> updated
- playwright: <count> new specs, <count> updated
- Anything explicitly not covered, with reason.

## Risks / follow-ups

- Anything the next human should look at.
```

---

## Hard constraints

- **Never** edit files under `node_modules/`.
- **Never** disable a test, hook, or lint rule to make the suite green.
  If a test is genuinely wrong because the SDK semantics changed,
  rewrite it; don't skip it.
- **Never** `--no-verify` on commits or `--force` on pushes.
- **Never** rewrite history on `main` or on any branch other than
  `sdk-update/{{NEW_VERSION}}`.
- If you get stuck (failing test you can't fix, ambiguous changelog
  item), write the situation into the run-notes file under "Risks /
  follow-ups", commit what you have, and **stop** — the orchestrator
  will open a draft PR and ping a human.

Now start. The branch is checked out, deps are installed, the
changelog is below. Get to green.

---

## Changelog block

{{CHANGELOG_BLOCK}}

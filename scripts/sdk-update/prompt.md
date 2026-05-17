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
3. **Pre-created a fillable run-notes file at
   `.claudius/sdk-updater/run-notes/{{NEW_VERSION}}.md`** with six
   `## ` section headings and `_(TODO …)_` placeholders. **Your job
   is to replace every placeholder with real content.** Don't create
   a new file — edit the one that's already there.

The full changelog between the two versions is in the
"## Changelog block" section at the bottom of this prompt.

---

## Your primary deliverable: the run-notes file

**Read this section twice.** The single most important thing you do
is replace the `_(TODO …)_` placeholders in:

    .claudius/sdk-updater/run-notes/{{NEW_VERSION}}.md

The file is ALREADY ON DISK with the right headings — go open it
right now with the Read tool so you see the shape. Your job is to
Edit each section's body. **Don't write code before you've at least
filled in "## SDK changelog highlights" — that section forces you to
take a position on every changelog item, and you can't write good
code without that position.**

The orchestrator parses each `## ` section into the PR body. If you
leave any placeholder in place, the validator fails the gate and the
PR opens as draft + needs-human. **An empty or skeletal run-notes
file is the worst possible outcome** — it makes the bot look broken
and wastes the reviewer's time. Even if you conclude that **no code
changes are needed**, you must still fill in every section
explaining what changed in the SDK and why none of it affects our
code.

### Required shape

```markdown
## Summary

One paragraph: what changed in the SDK between {{PREVIOUS_VERSION}}
and {{NEW_VERSION}}, what we changed in Claudius (or why nothing
needed to change), and the headline risk to flag for review.

## SDK changelog highlights

Bulleted list lifted from the upstream changelog, scoped to items
relevant to Claudius. For each item mark one of:

- `[shipped]` — wired through end-to-end in this PR
- `[type-only]` — type signature absorbed, no behaviour change
- `[skipped — <reason>]` — deliberately not pursued, with a one-line
  justification (e.g. "Bedrock-only", "CLI flag, no SDK API",
  "deprecated path we don't use")

Cover EVERY item in the upstream changelog that touches a public
SDK export. Do not pick favourites.

## Code changes

Bulleted list of every meaningful file or subsystem touched, with
one-line justifications. If no code changes were needed, write
exactly one bullet: `- No code changes required. <reason>` and
expand the reason in two-three sentences below.

## New UI surfaces

One bullet per new/changed screen with the screenshot path under
`docs/sdk-updates/{{NEW_VERSION}}/`. If the SDK update adds no
user-visible UI surface, write exactly: `- No new UI surfaces this
release. <reason>`.

## Tests

- vitest: <count> new specs, <count> updated
- playwright: <count> new specs, <count> updated
- Anything explicitly not covered, with reason.

If no tests were added: `- No new tests required. <reason>`.

## Risks / follow-ups

What the next human should look at. Examples: "the new
`onElicitation` callback in session.ts is wired but no e2e
exercises it yet", "I bumped past a deprecation but the deprecated
field still appears in lib/server/X — schedule removal for the next
upgrade cycle".

If there are genuinely no risks, write: `- None identified.`
```

The orchestrator looks for those six `## ` headings by exact name.
Don't rename them. Don't merge them. Don't skip any.

---

## How to work

### Step 1 — Read the changelog and the SDK source

- Read the "## Changelog block" section at the bottom of this prompt
  fully. Note **breaking changes**, **new features**, **deprecations**,
  and **behaviour-changed** items separately — you'll triage them
  differently.
- Open `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` and
  skim any exports you don't recognise from the changelog. The
  `.d.ts` is the source of truth for shapes; the changelog is the
  source of truth for intent.

### Step 2 — Audit existing usage

Run `rg -n "@anthropic-ai/claude-agent-sdk"` to find every importer.
Treat `lib/server/session.ts` as the centre of gravity — most SDK
contact happens there, with the rest in `lib/client/`,
`lib/shared/`, and a handful of `lib/server/` helpers.

For every breaking change in the changelog, confirm whether the old
shape is in use. For every deprecation, note whether we touch the
deprecated path. For every new feature, decide whether Claudius
should expose it.

### Step 3 — Edit the run-notes file (FIRST PASS)

Open `.claudius/sdk-updater/run-notes/{{NEW_VERSION}}.md` with the
Read tool — it's already on disk with placeholder TODOs. Edit it
with:

- The full "## SDK changelog highlights" section, marked
  `[shipped]` / `[type-only]` / `[skipped — reason]` for every item.
- A first-pass "## Code changes" listing what you intend to do.
- A first-pass "## New UI surfaces" listing what you intend to add.

You will revise these sections as you actually do the work, but
writing the analysis first forces you to commit to a plan, and it
guarantees that if something interrupts the run, the next human at
least has the analysis to act on.

Commit the draft: `docs(sdk-update): plan for {{NEW_VERSION}}`.

### Step 4 — Implement

For each `[shipped]` item in your run-notes:

- Wire it through end-to-end. For SDK additions that map onto
  something a Claudius user does in the browser (new tool, new
  permission mode, new event type, new session option, new MCP
  transport, etc.), build the full stack: server-side handling →
  SSE event → client hook → React component.
- Server-only modules stay under `lib/server/`. Browser-safe
  helpers go under `lib/client/`. Shared types under `lib/shared/`.
- Tailwind v4 — no `tailwind.config.*`. Theme lives in
  `app/globals.css` under `@theme`.

For each `[type-only]` item: update the type imports / signatures
but don't fabricate behaviour around them.

Prefer extending an existing component over creating a sibling.
**Do not create a junk component for every newly-exported
TypeScript type.** Components exist to surface user-facing
behaviour, not to mirror the type tree.

If during implementation you discover an item you originally marked
`[shipped]` actually doesn't apply (e.g. the feature is gated on
something Claudius doesn't have), downgrade it to
`[skipped — reason]` in the run-notes and move on.

### Step 5 — Tests

For every new component, hook, server module, or behaviour change:

- **Pure logic & SQLite round-trips** → vitest, alongside the code.
  Look at `lib/server/sessions-store.ts` neighbours for the style.
- **End-to-end user flow** → Playwright spec under `tests/e2e/`.
  Use the existing helpers — see `tests/e2e/` neighbours for
  fixture conventions. Prefer `data-testid` over CSS selectors.
- If a changelog change can only be exercised against the real
  agent, use the `chromium-live` project (only when you really
  need it).

After adding tests, run the full suites listed in "Definition of
done" below. If a pre-existing failure surfaces that's unrelated
to the SDK bump, **fix it** — the orchestrator's exit gate doesn't
distinguish "yours" from "theirs".

### Step 6 — Screenshots

For each new or materially-changed screen, capture a PNG using the
existing screenshot harness:

```bash
bun run site:screenshots
```

Commit the new PNGs under `docs/sdk-updates/{{NEW_VERSION}}/`. The
PR template references them via `raw.githubusercontent.com` so
they render in the GitHub UI. Filename convention:
`docs/sdk-updates/{{NEW_VERSION}}/<short-slug>.png`.

If the changelog adds no user-visible UI surface, skip this step
and note it in the run-notes "## New UI surfaces" section.

### Step 7 — Finalize the run-notes file

Revise the run-notes draft to reflect what **actually** shipped, not
what you planned. Specifically:

- Update "## Code changes" with the real list of files/subsystems
  touched.
- Update "## New UI surfaces" with the real screenshot paths.
- Fill in "## Tests" with concrete counts.
- Write the "## Summary" paragraph last, after you know the full
  story.
- Write "## Risks / follow-ups" honestly — anything the reviewer
  should look at, anything you skipped you're not 100% sure about.

Commit: `docs(sdk-update): notes for {{NEW_VERSION}}`.

### Step 8 — Definition of done

You are **not done** until **all** of the following are true. The
orchestrator checks them before opening the PR; failing any of
them forces the PR to open as **draft** with the `needs-human`
label.

1. `bun run lint` — zero errors across the whole repo.
2. `bun run test` (vitest) — every spec passes.
3. `bun run build` — production build succeeds.
4. `bun run test:e2e` (Playwright, chromium project) — every spec
   passes. The Playwright browser is already installed; if it
   isn't, run `make test` once which installs it.
5. `.claudius/sdk-updater/run-notes/{{NEW_VERSION}}.md` exists and
   contains all six `## ` headings listed above, each with
   non-trivial content (no placeholder text like "TODO" or
   "(none)").
6. Every `[shipped]` item in your run-notes is actually shipped —
   grep the diff to confirm.
7. The working tree is clean — every file you touched is committed
   on `sdk-update/{{NEW_VERSION}}` with informative messages.

If you can't get to all-green, write what's blocking you under
"## Risks / follow-ups" in the run-notes file, commit what you
have, and **stop**. The orchestrator will open a draft PR and ping
a human. Aim to finish; don't aim for "draft is fine".

---

## Hard constraints

- **Never** edit files under `node_modules/`.
- **Never** disable a test, hook, or lint rule to make the suite
  green. If a test is genuinely wrong because the SDK semantics
  changed, rewrite it; don't skip it.
- **Never** `--no-verify` on commits or `--force` on pushes.
- **Never** rewrite history on `main` or on any branch other than
  `sdk-update/{{NEW_VERSION}}`.
- If you get stuck (failing test you can't fix, ambiguous changelog
  item), write the situation into the run-notes file under
  "## Risks / follow-ups", commit what you have, and **stop** —
  the orchestrator will open a draft PR and ping a human.

Now start. The branch is checked out, deps are installed, the
changelog is below.

**Your first action should be to read the "## Changelog block"
section at the bottom of this prompt. Your second should be to Read
`.claudius/sdk-updater/run-notes/{{NEW_VERSION}}.md` and Edit it to
fill in the placeholders. Code changes come third.**

---

## Changelog block

{{CHANGELOG_BLOCK}}

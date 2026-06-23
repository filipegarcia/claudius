# Claude Code parity — Claude Run Prompt

> The orchestrator (`orchestrate.ts`) substitutes the `{{...}}` placeholders
> before handing this prompt to `@anthropic-ai/claude-agent-sdk`'s `query()`.
> Keep placeholders in sync with `renderPrompt()` in `orchestrate.ts`.

{{COMBINED_PREAMBLE}}

You are reviewing a new Claude Code release for features Claudius
should adopt. Source: `@anthropic-ai/claude-code@{{NEW_VERSION}}`
(previous: `{{PREVIOUS_VERSION}}`).

Claudius is a browser-based Claude Code clone built on
`@anthropic-ai/claude-agent-sdk`. Many Claude Code features flow
through that SDK and arrive in Claudius via the SDK updater (see
`scripts/sdk-update/`). Your job is the items that DON'T.

The orchestrator has already:

1. Checked out a fresh branch `cc-parity/{{NEW_VERSION}}` from
   `origin/main`. No dependency was bumped — Claudius does not depend
   on `@anthropic-ai/claude-code`. The upstream changelog is sourced
   over the network for analysis, not because we install the package.
2. **Pre-created a fillable run-notes file at
   `.claudius/cc-parity/run-notes/{{NEW_VERSION}}.md`** with six
   `## ` section headings and `_(TODO …)_` placeholders. **Your job
   is to replace every placeholder with real content.** Don't create
   a new file — edit the one that's already there.

The full changelog between the two versions is in the
"## Changelog block" section at the bottom of this prompt.

---

## The A/B/C bucketing model — this is the whole point

Every substantive entry in the changelog belongs in one of three
buckets. Classify each one before you write a single line of code.

### Bucket A — engine features exposed via the SDK

The feature lands in Claudius automatically when the SDK updater bumps
`@anthropic-ai/claude-agent-sdk` to the version that exposes it. Examples:

- new permission modes (`acceptEdits`, `bypassPermissions`, …)
- new `query()` options (session resume, MCP transports, hooks)
- new event types streamed from the agent
- new tool surfaces baked into the SDK

**Action:** mark `[skip — already via SDK updater]` in the
classification section. **Do not implement.** Doing the work here too
would duplicate effort with the sibling pipeline and risk merge
conflicts when the SDK PR lands.

### Bucket B — product-surface features Claudius reimplements

The feature exists outside the SDK and is something a Claudius user
should be able to do in the browser. Examples:

- new settings (`autoCompact`, `disableAutoUpdater`, etc.) → Claudius
  reads them from its own settings store, not from the CLI's config
  file. Add a UI surface and persist it.
- new slash commands the CLI ships (`/agents`, `/memory`, `/usage`,
  `/cost`) → Claudius reimplements these in `lib/shared/slash-commands.ts`
  + the relevant UI hook.
- new UI affordances (status indicators, panes, keyboard shortcuts) →
  build the React component that delivers the same affordance in the
  browser surface.
- changed defaults (default model, default permission mode, default
  thinking budget) → update Claudius's defaults in `lib/server/` /
  `lib/client/` to match, with a settings escape hatch if the user
  wants the old behaviour.

**Action:** ship it — the *real* product surface, not a behind-the-scenes
stub. Wire it through end-to-end — server-side handling, SSE events if
needed, client hook, React component, settings persistence, e2e spec,
screenshot.

**Decide the shape first: extend an existing screen, or build a new one.**
Every bucket-B feature is delivered one of two ways, and you must make
the call explicitly and record it (see the run-notes "Implemented
(bucket B)" shape):

- **`[extend: <screen>]` — DEFAULT.** Add the affordance to a screen/route
  Claudius already has. A new setting joins the existing Settings panel; a
  new per-session indicator joins the session chrome; a new slash command
  joins the existing command surface. Prefer this whenever the feature is a
  variation on something Claudius already shows.
- **`[new screen: <route>]` — only for a genuinely new domain.** Build a new
  route/page when the feature is a first-class surface with no existing home
  — e.g. a dedicated `/usage` dashboard, an agents browser, a workflow
  inspector — and cramming it into an existing screen would distort that
  screen's purpose. A new screen is more work and more review surface, so
  reach for it only when extending would be the wrong shape, and say why
  under the rejected alternative.

Do **not** downgrade a real UI feature to a hidden settings flag just to
play it safe — if Claude Code ships it as a visible affordance, Claudius
should too. The guard against over-building is the adversarial UX-fit
verification below, not refusing to build. If the changelog
entry is thin ("Added X setting"), fetch context yourself:

- `gh api repos/anthropics/claude-code/commits?path=...&sha=v{{NEW_VERSION}}`
  for the diff that introduced the feature.
- `WebFetch` against `https://docs.anthropic.com/en/docs/claude-code/`
  for the user-facing docs.

### Bucket C — terminal/CLI-only

The feature only makes sense in a terminal context. Examples:

- statusline rendering (`/statusline`, `--statusline-buffer-size`)
- key chords (`Ctrl+R` for history, `Ctrl+T` for transcript)
- shell integration (zsh/bash completion, prompt injection)
- terminal output styles (`--style`, color overrides)
- streaming JSON output formats

**Action:** mark `[skip — CLI/terminal only]` in the classification
section. **Do not implement.** Claudius is a browser app; there is no
terminal to integrate with.

### When the bucket is unclear

Choose the most conservative interpretation, document the assumption,
and move on. Record the alternative you rejected under "## Risks /
follow-ups". **Never invent features** — if the changelog entry is
ambiguous and you can't get clarity from a `gh api` commit lookup or
`WebFetch` on the docs, mark it as `[skip — ambiguous, see Risks]`
rather than build the wrong thing.

---

## Feature-generation failure mode (read twice)

This pipeline produces **design proposals**, not finished work. The
gates downstream of you (lint / test / build / e2e) prove that
**nothing broke**, NOT that the implementation matches Claudius's
intended UX. A green run with a wrong-shape bucket-B implementation
is still a wrong implementation — the gate has no way to know.

What this means for you:

- **Build the real surface, but pick the right shape.** Ship the actual
  user-facing affordance (extend an existing screen by default; a new
  screen only for a genuinely new domain — see Bucket B). Don't hide a
  visible feature behind a settings-only flag to play it safe. The lever
  that keeps this honest is the adversarial UX-fit check below, not
  under-building. The conservatism you DO owe is on *interpretation*: when
  a changelog entry's intent is ambiguous, pick the reading that fits
  Claudius's conventions and record the rejected reading under "## Risks /
  follow-ups" — don't invent scope the changelog doesn't support.
- **Match Claudius's existing UX patterns.** Look at how the codebase
  already surfaces analogous features. Don't import Claude Code's
  CLI-flavoured affordances unchanged — translate them to the
  browser-app idiom that fits the rest of Claudius's chrome.
- **Document alternatives under "## Risks / follow-ups".** Every
  bucket-B item you ship should name at least one alternative shape
  you considered and the reason you didn't pick it. This is what the
  human reviewer uses to confirm or correct your call.

---

## Your written deliverable: the run-notes file

Alongside the code, you must produce a run-notes file that classifies
the release and documents the bucket-B work. Write the classification
**first — before you code** — because the analysis it forces is what
makes the bucketing correct, not because the document is the part that
matters most. Replace the `_(TODO …)_` placeholders in:

    .claudius/cc-parity/run-notes/{{NEW_VERSION}}.md

The file is ALREADY ON DISK with the right headings — go open it
right now with the Read tool so you see the shape. Your job is to
Edit each section's body.

The orchestrator parses each `## ` section into the PR body, and the
gate fails (draft + needs-human) if any placeholder is left in place.

### Required shape

```markdown
## Summary

One paragraph: which features Claude Code added between
{{PREVIOUS_VERSION}} and {{NEW_VERSION}}, which ones Claudius
reimplements (bucket B) this release, and the headline risk to
flag for review (most often: "is this the right UX shape").

## Changelog classification

Bulleted list. Every non-bug-fix entry from the upstream changelog,
classified A / B / C with a one-line justification:

- `[A — already via SDK updater] <entry>` — <why this is engine-side>
- `[B — reimplement in Claudius] <entry>` — <why this is product-side
  and what we built>
- `[C — CLI/terminal only] <entry>` — <why this doesn't translate>
- `[skip — ambiguous, see Risks] <entry>` — only when even a `gh api`
  + `WebFetch` couldn't disambiguate.

Cover EVERY substantive entry. Pure bug-fix entries can be elided.

## Implemented (bucket B)

One bullet per bucket-B item that was actually shipped. Each bullet MUST
tag its delivery shape and name the rejected alternative:

- `[extend: <screen>] <feature>` — added to an existing screen/route.
  Files touched. Rejected alternative: <e.g. "a new screen — overkill,
  it's a variation on the existing X panel">.
- `[new screen: <route>] <feature>` — new route/page. Files touched.
  Rejected alternative: <e.g. "extending the sessions list — would
  distort it; this is a distinct domain">.

If no bucket-B items applied this release, write exactly one bullet
`- No bucket-B items in this release. <reason>` and expand the reason in
two-three sentences below.

## New UI surfaces

One bullet per new/changed UI element. Each bullet MUST include:

- the screenshot path under `docs/cc-parity/{{NEW_VERSION}}/`
  (relative to the repo root),
- the path to the Playwright spec that captured it (under
  `tests/e2e/`), and
- a one-line note on the context the shot was taken in.

The screenshot must show the element **in context** — surrounding
chrome included. A bare element on a blank canvas is not acceptable.

If the release adds no user-visible UI surface, write exactly:
`- No new UI surfaces this release. <reason>`.

## Tests

- vitest: <count> new specs, <count> updated
- playwright: <count> new specs, <count> updated
- Anything explicitly not covered, with reason.

If no tests were added: `- No new tests required. <reason>`.

## Risks / follow-ups

What the next human should look at. At minimum:

- For each bucket-B item you shipped, name one alternative shape you
  considered and the reason you didn't pick it. The reviewer uses this
  to validate your design call on the PR.
- Any item you marked `[skip — ambiguous, see Risks]` from the
  classification, with a pointer to the upstream commit / docs page
  you tried to disambiguate from.
- Anything you implemented under "the most conservative interpretation"
  rule — name the conservative shape AND the maximal shape.

If you're certain there are no risks worth noting: `- None identified.`
```

The orchestrator looks for those six `## ` headings by exact name.
Don't rename them. Don't merge them. Don't skip any.

---

## How to work

### Step 0 — Orchestrate this review with a dynamic workflow

You have the **Workflow** tool (dynamic `agent()` / `parallel()` /
`pipeline()` orchestration), and this run is fully headless and
autonomous. **Use it.** A release this size has many independent
sub-tasks; fanning them across sub-agents is faster and more thorough
than one linear pass, and it lets you verify your own work
adversarially before you trust it. The numbered steps below are the
*phases* — drive them with workflows, don't plod through them solo.

This pipeline is **feature-generation**, not migration. The decomposition
below reflects that emphasis: most of the model's time goes into the
audit (per-candidate applicability + design) and the adversarial
verification ("does this match Claudius's UX?"), not the implementation
itself.

Default decomposition (adapt per release):

1. **Audit — parallel, read-only.** One `agent()` per
   **bucket-B candidate** identified from your first pass through the
   classification. Each agent reads the relevant Claudius modules
   (`lib/server/`, `lib/client/`, `lib/shared/`, `app/`,
   `components/`), looks at how Claudius already handles analogous
   features, and returns structured findings: "this is bucket B, the
   minimal Claudius shape is X, the alternatives are Y/Z, the user-
   facing affordance lives in components/<file>".
   Read-only, so parallel is safe — merge findings yourself into the
   classification section.
2. **Implement.** Ship the bucket-B items. **File edits are the one
   place workflows bite:** parallel agents editing the same working
   tree clobber each other. Serialize the edits unless two items
   touch genuinely disjoint files (then `isolation: 'worktree'`).
   When in doubt, serialize.
3. **Adversarially verify — parallel, read-only.** After implementing,
   spawn one skeptic per bucket-B change, each prompted to **refute**
   that the implementation matches Claudius's UX conventions. The
   prompt is NOT "does the shape compile" — it is "does this fit the
   way Claudius already does analogous things, or does it look like a
   pasted-in CLI affordance?". Anything a majority flags, redesign.
   This is the step that catches a plausible-but-wrong shape.
4. **Gate-fix loop.** Run the gates (Step 7). For each failure, spawn
   a focused agent to diagnose and propose the fix, apply it, re-gate,
   and repeat until green or genuinely blocked.

Guardrails, because the run is unsupervised and budget-capped (turn,
wall-clock, and idle ceilings):

- **Cap fan-out** — a handful of agents per phase, not dozens. They
  share the same budget that has to land the whole review.
- **Read-heavy phases are free wins; write-heavy phases are where you
  serialize.** Never run two file-mutating agents against the same tree
  without worktree isolation.
- **Let every workflow complete before moving on** — a workflow you
  launch and ignore can leave the run wedged.

### Step 1 — Read the changelog and disambiguate

- Read the "## Changelog block" section at the bottom of this prompt
  fully.
- For every entry that's not a pure bug-fix:
  - If the intent is obvious, classify it A/B/C immediately.
  - If the entry is thin ("Added `--foo`" / "Now respects `BAR`"),
    run a quick `gh api repos/anthropics/claude-code/commits?path=...&sha=v{{NEW_VERSION}}`
    to find the introducing commit, or `WebFetch` against
    `https://docs.anthropic.com/en/docs/claude-code/` for the user-
    facing docs. Note where you got the context for the run-notes.

### Step 2 — Edit the run-notes file (FIRST PASS)

Open `.claudius/cc-parity/run-notes/{{NEW_VERSION}}.md` with the
Read tool — it's already on disk with placeholder TODOs. Edit it
with:

- The full "## Changelog classification" section, with every
  substantive entry bucketed A/B/C (or `[skip — ambiguous]`).
- A first-pass "## Implemented (bucket B)" listing what you intend
  to ship.
- A first-pass "## New UI surfaces" listing what you intend to add.

You will revise these sections as you actually do the work, but
writing the analysis first forces you to commit to a plan, and it
guarantees that if something interrupts the run, the next human at
least has the analysis to act on.

Commit the draft: `docs(cc-parity): plan for {{NEW_VERSION}}`.

### Step 3 — Implement the bucket-B items

For each `[B — reimplement in Claudius]` item:

- Read the analogous existing surfaces in Claudius first. Match their
  shape, naming, settings-store key style, and UI affordance idiom.
- Wire the feature through end-to-end. For settings: persist in the
  appropriate store under `lib/server/`, expose via SSE if it's a
  live-update kind of setting, surface in the right Settings panel
  under `app/` / `components/`. For slash commands: extend
  `lib/shared/slash-commands.ts` + the relevant client hook + a
  Playwright spec exercising the command.
- Server-only modules stay under `lib/server/`. Browser-safe helpers
  go under `lib/client/`. Shared types under `lib/shared/`.
- Tailwind v4 — no `tailwind.config.*`. Theme lives in
  `app/globals.css` under `@theme`.

**Shape-decision principle.** For every bucket-B item, decide
`[extend: <screen>]` vs `[new screen: <route>]` (Bucket B rubric) and
build that surface for real. Default to extending an existing screen;
build a new screen only when the feature is a genuinely new domain that
would distort an existing screen. Don't park a visible feature behind a
settings-only flag — record the rejected shape under "## Risks /
follow-ups" instead, so the reviewer can see the alternative you weighed.

### Step 4 — Tests

For every new component, hook, server module, or behaviour change:

- **Pure logic & SQLite round-trips** → vitest, alongside the code.
- **End-to-end user flow** → Playwright spec under `tests/e2e/`.
  Use the existing helpers; prefer `data-testid` over CSS selectors.

### Step 5 — Build an e2e test that captures the screenshot

For every new or materially-changed UI element this release adds,
ship a Playwright spec that **drives the app into the state the
element is visible in and screenshots it in context**.

- The spec lives under `tests/e2e/cc-parity-{{NEW_VERSION}}-<short-slug>.spec.ts`.
- The spec writes the PNG to `docs/cc-parity/{{NEW_VERSION}}/<short-slug>.png`.
- Capture in context — surrounding chrome (tab strip, side nav, route).
- The spec must do more than screenshot: it should `expect(...)` the
  visible behaviour (text content, count, enabled state) too.

Commit the new spec **and** the PNG it produces together. The PR
template inlines every PNG it finds under `docs/cc-parity/{{NEW_VERSION}}/`
via raw.githubusercontent.com URLs.

If the release adds no user-visible UI surface, skip this step.

### Step 6 — Finalize the run-notes file

Revise the run-notes draft to reflect what **actually** shipped.
Specifically:

- Update "## Implemented (bucket B)" with the real list.
- Update "## New UI surfaces" with the real screenshot paths.
- Fill in "## Tests" with concrete counts.
- Write the "## Summary" paragraph last.
- Fill in "## Risks / follow-ups" — every bucket-B item should name at
  least one alternative shape you rejected.

Commit: `docs(cc-parity): notes for {{NEW_VERSION}}`.

### Step 7 — Definition of done

You are **not done** until **all** of the following are true. The
orchestrator re-runs the gate commands below after you return; if any
is red, the run ends as a process-issue with **no PR opened**.

1. `bun run lint` — zero errors across the whole repo.
2. `bun run test` (vitest) — every spec passes.
3. `bun run build` — production build succeeds.
4. `bun run test:e2e` (Playwright, chromium project) — every spec
   passes. The Playwright browser is already installed; if it isn't,
   run `make test` once which installs it. **This is the one most
   often skipped — do not skip it.**
5. `.claudius/cc-parity/run-notes/{{NEW_VERSION}}.md` exists and
   contains all six `## ` headings listed above, each with
   non-trivial content.
6. Every `[B — reimplement in Claudius]` item in your classification
   section is actually shipped — grep the diff to confirm.
7. Every new or materially-changed UI element has a Playwright spec
   under `tests/e2e/cc-parity-{{NEW_VERSION}}-*.spec.ts` that captures
   a screenshot of it in context to
   `docs/cc-parity/{{NEW_VERSION}}/`, and the matching bullet in
   "## New UI surfaces" lists both paths.
8. The working tree is clean — every file you touched is committed
   on `cc-parity/{{NEW_VERSION}}` with informative messages.

---

## Hard constraints

- **Never** edit files under `node_modules/`.
- **Never** edit files under `scripts/sdk-update/` or `scripts/cc-parity/`.
  That directory is the pipeline running you right now — the orchestrator,
  this prompt, the check/state logic — NOT part of the Claudius app you're
  working on. A gate failure that points into that harness (a TypeScript
  error in `scripts/cc-parity/orchestrate.ts`, a failing `scripts/`-related
  unit test) is almost always a pre-existing bug on `main` that has nothing
  to do with Claude Code parity. Do **not** fix it — note it under
  "## Risks / follow-ups" with the exact error and continue. Editing the
  harness mid-run buries an unrelated fix in a parity PR where it doesn't
  belong (this has happened on the SDK pipeline). When unsure, report
  rather than edit.
- **Never** disable a test, hook, or lint rule to make the suite green.
- **Never** `--no-verify` on commits or `--force` on pushes.
- **Never** rewrite history on `main` or on any branch other than
  `cc-parity/{{NEW_VERSION}}`.

### Work autonomously — there is no human to ask

This is a fully autonomous, headless run. **There is no human on the
other end and no interactive prompt** — you cannot ask a question,
request confirmation, or wait for a decision. Decide, act, document.

- **Ambiguity is yours to resolve.** When a changelog entry's intent
  is unclear, do **not** stop. Choose the most conservative option
  that fits Claudius's existing conventions, implement it, and record
  the assumption + the rejected alternative under "## Risks /
  follow-ups". The reviewer can correct your call on the PR.
- **Stopping is only for a genuine block, after real effort.** For a
  red gate, spawn at least one focused diagnose-and-fix agent, apply
  its fix, re-gate, and only stop if a gate is still red after twice
  through the loop.
- This autonomy does **not** relax the constraints above. Never
  disable a test or lint rule, never `--no-verify`, never hack a gate
  to green just to avoid stopping.

Now start. The branch is checked out, the changelog is below.

**Your first action should be to read the "## Changelog block"
section at the bottom of this prompt. Your second should be to Read
`.claudius/cc-parity/run-notes/{{NEW_VERSION}}.md` and Edit it to
fill in the classification — that is the analysis pass. Then implement
the bucket-B items that classification calls for: shipping that
working code is the actual goal.**

---

## Changelog block

{{CHANGELOG_BLOCK}}

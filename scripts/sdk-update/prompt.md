# SDK Update — Claude Run Prompt

> The orchestrator (`orchestrate.ts`) substitutes the `{{...}}` placeholders
> before handing this prompt to `@anthropic-ai/claude-agent-sdk`'s `query()`.
> Keep placeholders in sync with `buildPrompt()` in `orchestrate.ts`.

You are upgrading the **Claudius** codebase to support the new SDK,
from `@anthropic-ai/claude-agent-sdk@{{PREVIOUS_VERSION}}` to
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

## The goal

Your deliverable is **all four gates green on the migrated tree** —
`bun run lint`, `bun run test`, `bun run build`, and `bun run test:e2e`
each emitting zero failures, with every SDK change that affects
Claudius wired through to working code. The migration is the *means*;
the green gate is *the thing*. A migration that ends with a red gate
counts as a failed run, not a successful one with a follow-up. Drive
every decision (ship vs type-only vs skip) toward landing all four
green.

The run-notes file (next section) documents that work — it is a
required deliverable, but it is **not** the objective. A polished
run-notes file describing zero code changes, when the SDK actually
required changes, is a failed run, not a clean one.

---

## The single most common failure mode

The pattern we see most often: Claude finishes the implementation,
runs `bun run lint` and `bun run test`, sees them green, and reports
done — **without running `bun run test:e2e` to completion**. The
orchestrator runs the full gate suite after Claude returns, finds e2e
red, and ends the run as a process-issue with no PR. See e.g.
issues #16 and #31 ("Claude reported done but gate failed: e2e").

Do not be that case. Before your final "done" message:

1. Run **every** command in the Definition of Done (Step 8) in this
   session, in order.
2. Read the tail of each command's output. A green "X passed
   (Y skipped)" — or the equivalent for `lint` / `build` — is the
   only acceptable signal. Silence is **not** success; a command you
   didn't run is **not** green.
3. If any command is red, fix it (spawn a focused diagnose-and-fix
   agent if useful) and re-run **all** of them from the top. Re-runs
   are cheap; a draft PR that needed a human to finish the e2e suite
   is expensive.

---

## The second failure mode: dismissing model changes as "SDK-internal"

When the changelog touches **model identity** — a renamed or
suffixed model name (e.g. Fable's `[1m]` suffix), a new/renamed
alias, a changed default model, a new context-window default, a new
effort/thinking capability tier, or a pricing-tier change — the
tempting (and wrong) move is to mark it
`[skipped — SDK-internal model-name normalisation, no Claudius
call-site]` and ship zero code. That reasoning is almost always
false: **Claudius hard-codes model identity, names, descriptions,
capability flags, context-window and pricing assumptions in app
code.** The SDK normalising a name in its binary does *not* update
our copies — if anything, it makes them stale.

So **model-identity changelog items are not skippable on a generic
"no call-site" justification.** Before you may mark any of them
`[skipped]`, you must audit — and the run-notes `[skipped]` line must
name which of these surfaces you checked and why each is genuinely
unaffected:

- `app/api/models/route.ts` — the `STATIC_FALLBACK` list: every
  `value` / `displayName` / `description` / `supportsEffort` /
  `supportedEffortLevels` / `supportsAdaptiveThinking` entry
  (esp. the `fable` row).
- `app/api/models/probe/route.ts` — the pinned-model probe list and
  its descriptions.
- `app/api/sessions/[id]/model/route.ts` — the session-scoped picker
  rows and alias→displayName mapping.
- `lib/client/types.ts` — the `ModelInfo` shape and any
  hard-coded model-id strings.
- `lib/server/session.ts` — model-conditional logic such as the
  `fable`-advisor-incompatibility clearing and the `enable1mContext`
  / `context-1m` beta-header gating (a "1M context is now default"
  changelog item is exactly the kind of thing that flips this).
- `lib/server/litellm-pricing.ts` + `lib/server/litellm-prices.json`
  — the long-context (>200k) pricing tier, which a new default
  context window can change.
- `components/chat/` model UI (`ModelPicker.tsx`,
  `FableLaunchTipBanner`) — copy and capability chips that mirror the
  SDK's framing.

If, after auditing all of the above, the item genuinely needs no
change, that is a legitimate `[skipped]` — but the justification must
be the *audit result* ("checked the four model routes, the picker
copy, and the context-1m gate; none reference an explicit `[1m]`
suffix and the 1M window is already the default we assume"), not a
hand-wave about the SDK binary. A bare "SDK-internal, no call-site"
on a model-identity item is treated as an un-audited skip — i.e. a
failed run.

---

## Your written deliverable: the run-notes file

Alongside the code, you must produce a run-notes file that documents
the migration. Write it **first — before you code** — because the
analysis it forces is what makes the code correct, not because the
document is the part that matters most. Replace the `_(TODO …)_`
placeholders in:

    .claudius/sdk-updater/run-notes/{{NEW_VERSION}}.md

The file is ALREADY ON DISK with the right headings — go open it
right now with the Read tool so you see the shape. Your job is to
Edit each section's body. **Don't write code before you've at least
filled in "## SDK changelog highlights" — that section forces you to
take a position on every changelog item, and you can't write good
code without that position.**

The orchestrator parses each `## ` section into the PR body, and the
gate fails (draft + needs-human) if any placeholder is left in place.
So the run-notes are mandatory — but completeness of the *document* is
not the same as success of the *migration*. The genuinely worst
outcome is shipping no code when the SDK required code changes, with
run-notes that rationalise it. If you honestly conclude that **no code
changes are needed**, that is a valid result — but you must still fill
in every section explaining what changed in the SDK and why none of it
affects our code, so a reviewer can check your reasoning.

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

**Model-identity items have a higher bar to skip.** Any item about a
model name/suffix (e.g. Fable `[1m]`), alias, default model,
context-window default, capability tier, or pricing tier may NOT be
skipped with a generic "SDK-internal / no call-site" reason — Claudius
hard-codes this information. To skip one, the justification must cite
the model surfaces you audited (see "The second failure mode" above).

## Code changes

Bulleted list of every meaningful file or subsystem touched, with
one-line justifications. If no code changes were needed, write
exactly one bullet: `- No code changes required. <reason>` and
expand the reason in two-three sentences below.

## New UI surfaces

One bullet per new/changed UI element. Each bullet MUST include:

- the screenshot path under `docs/sdk-updates/{{NEW_VERSION}}/`
  (relative to the repo root),
- the path to the Playwright spec that captured it (under
  `tests/e2e/`), and
- a one-line note on the context the shot was taken in (which
  route, which workspace state, what was on screen around it).

The screenshot is what the reviewer uses to validate the change
visually, so it must show the element **in context** — the
surrounding chrome (tab strip, side nav, page) is part of the
evidence, not noise to crop out. A bare element on a blank canvas
is not acceptable.

If the SDK update adds no user-visible UI surface, write exactly:
`- No new UI surfaces this release. <reason>`.

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

### Step 0 — Orchestrate this migration with a dynamic workflow

You have the **Workflow** tool (dynamic `agent()` / `parallel()` /
`pipeline()` orchestration), and this run is fully headless and
autonomous. **Use it.** A release this size has many independent
sub-tasks; fanning them across sub-agents is faster and more thorough
than one linear pass, and it lets you verify your own work
adversarially before you trust it. The numbered steps below are the
*phases* — drive them with workflows, don't plod through them solo.

Default decomposition (adapt per release):

1. **Audit — parallel, read-only.** One `agent()` per subsystem
   (`lib/server/session.ts`, `lib/client/`, `lib/shared/`, the
   `lib/server/` helpers), each auditing our usage against the changelog
   and `sdk.d.ts` and returning structured findings (exports we touch,
   breaking changes that hit us, new features worth exposing). These
   agents only read, so they never collide — `parallel()` them and merge
   the findings yourself into the run-notes plan (Step 3).
2. **Implement.** Ship the `[shipped]` items. **File edits are the one
   place workflows bite:** parallel agents editing the same working tree
   clobber each other. So either make the edits yourself, sequentially,
   or — only when two items touch genuinely disjoint files — fan them
   out with `isolation: 'worktree'` and reconcile the results back into
   the main tree before gating. When in doubt, serialize the edits.
3. **Adversarially verify — parallel, read-only.** After implementing,
   spawn a skeptic per change / per changelog item, each prompted to
   *refute* that the item is correctly handled (wrong shape, missed call
   site, behaviour drift). Anything a majority flags, go fix. This is
   the step that catches a plausible-but-wrong migration.
4. **Gate-fix loop.** Run the gates (Step 8). For each failure, spawn a
   focused agent to diagnose and propose the fix, apply it, re-gate, and
   repeat until green or genuinely blocked. Do **not** stop at the first
   red gate — closing this loop autonomously is the whole point.

Guardrails, because the run is unsupervised and budget-capped (turn,
wall-clock, and idle ceilings):

- **Cap fan-out** — a handful of agents per phase, not dozens. They
  share the same budget that has to land the whole migration.
- **Read-heavy phases are free wins; write-heavy phases are where you
  serialize.** Never run two file-mutating agents against the same tree
  without worktree isolation.
- **Let every workflow complete before moving on** — a workflow you
  launch and ignore can leave the run wedged.

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
distinguish "yours" from "theirs". **One exception, below.**

#### The updater's own harness is OFF the migration surface

**Never edit files under `scripts/sdk-update/` or `scripts/cc-parity/`.**
That directory is the pipeline that is running you right now — the
orchestrator, its prompt (this file), the check/state logic, the PR
templates. It is NOT part of the Claudius app you're migrating.

If a gate failure points INTO that harness (a TypeScript error in
`scripts/sdk-update/orchestrate.ts`, a failing `scripts/`-related unit
test, etc.) it is almost always a bug on `main` that has nothing to do
with the SDK bump — do **not** try to fix it. Editing the harness
mid-run is how you get a half-fixed harness committed onto an SDK PR
where it doesn't belong (this has happened). Instead:

- Note it under "## Risks / follow-ups" in the run-notes with the exact
  error, and
- Continue with the migration. A harness build error you didn't cause
  is the operator's to fix on `main`, not yours to bury in this PR.

The ONE case where touching `scripts/sdk-update/` is legitimate: the
SDK changelog itself changed the `query()` signature / option shape
that the orchestrator passes in `runClaude`, so the harness genuinely
won't run against the new SDK. If — and only if — you hit that, make
the minimal call-site fix and document it prominently in
"## Risks / follow-ups" as a harness change. When unsure, treat the
harness as off-limits and report rather than edit.

### Step 6 — Build an e2e test that captures the screenshot

For every new or materially-changed UI element this release adds,
ship a Playwright spec that **drives the app into the state the
element is visible in and screenshots it in context**. The
screenshot is what gets embedded in the PR body via the
`{{SCREENSHOTS_BLOCK}}` block, and the human reviewer uses it to
validate the change. So:

- The spec lives under `tests/e2e/sdk-update-{{NEW_VERSION}}-<short-slug>.spec.ts`
  and follows the conventions of its `tests/e2e/` neighbours
  (helpers from `tests/e2e/helpers/`, `data-testid` over CSS
  selectors, `activateClaudiusWorkspace` when the chrome matters).
- The spec writes the PNG to `docs/sdk-updates/{{NEW_VERSION}}/<short-slug>.png`
  via `await page.screenshot({ path: ..., fullPage: false })`.
  Use `mkdirSync(..., { recursive: true })` once at the top so the
  spec works on a fresh checkout. `site-screenshots.spec.ts` is a
  good shape to copy.
- **Capture in context.** The shot must include the surrounding
  chrome (tab strip, side nav, the route the element lives on) so
  a reviewer can see *where* it shows up, not just *what* it looks
  like. A bare element on a blank canvas is not acceptable —
  navigate the page to the real route, get the app into the real
  state, and snap the viewport. Use `page.locator(...).scrollIntoViewIfNeeded()`
  + a small `page.waitForTimeout(...)` for layout settle if the
  element animates in.
- The spec must do more than screenshot: it should also
  `expect(...)` the visible behaviour (text content, count,
  enabled state) so the same file doubles as a regression test
  the gate will catch on future changes.
- Don't reuse the marketing harness (`tests/e2e/site-screenshots.spec.ts`)
  for this — those PNGs go to `site/screenshots/` and feed the
  marketing site, not the SDK-update PR. The two are separate.

Commit the new spec **and** the PNG it produces together. The PR
template inlines every PNG it finds under `docs/sdk-updates/{{NEW_VERSION}}/`
via `raw.githubusercontent.com` URLs, so just dropping the file in
the right folder is enough to land it in the ticket — the reviewer
will see the screenshot rendered in the PR body.

If the changelog adds no user-visible UI surface, skip this step
and write `- No new UI surfaces this release. <reason>` in the
run-notes "## New UI surfaces" section. **Otherwise it is not
optional** — a `[shipped]` item that touches the browser without a
spec + PNG is an incomplete migration.

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
orchestrator re-runs the gate commands below after you return; if
any is red, the run ends as a process-issue with **no PR opened**
(see "The single most common failure mode" near the top). Items
1–4 are gate commands: run each in this session, read the tail of
its output, and paste the last 5–10 lines (showing the green count
/ "PASS" / "Compiled successfully") into your final message. That
paste is the contract that you actually ran the gate — not that you
believe it would pass. Silence is not success.

1. `bun run lint` — zero errors across the whole repo.
2. `bun run test` (vitest) — every spec passes.
3. `bun run build` — production build succeeds.
4. `bun run test:e2e` (Playwright, chromium project) — every spec
   passes. The Playwright browser is already installed; if it
   isn't, run `make test` once which installs it. **This is the
   one most often skipped — do not skip it.**
5. `.claudius/sdk-updater/run-notes/{{NEW_VERSION}}.md` exists and
   contains all six `## ` headings listed above, each with
   non-trivial content (no placeholder text like "TODO" or
   "(none)").
6. Every `[shipped]` item in your run-notes is actually shipped —
   grep the diff to confirm.
7. Every new or materially-changed UI element has a Playwright
   spec under `tests/e2e/sdk-update-{{NEW_VERSION}}-*.spec.ts`
   that captures a screenshot of it in context to
   `docs/sdk-updates/{{NEW_VERSION}}/`, and the matching bullet in
   "## New UI surfaces" lists both paths. (If the release adds no
   UI, the section says `- No new UI surfaces this release.
   <reason>` and `docs/sdk-updates/{{NEW_VERSION}}/` may be empty.)
8. The working tree is clean — every file you touched is committed
   on `sdk-update/{{NEW_VERSION}}` with informative messages.

If you can't get to all-green — a **genuine** gate failure you've
honestly tried to fix, not mere uncertainty about a design choice —
write what's blocking you under "## Risks / follow-ups" in the
run-notes file, commit what you have, and **stop**. The orchestrator
will open a draft PR and ping a human. Aim to finish; don't aim for
"draft is fine", and never stop merely because something was
ambiguous — resolve that yourself (see "Work autonomously" below).

---

## Hard constraints

- **Never** edit files under `node_modules/`.
- **Never** disable a test, hook, or lint rule to make the suite
  green. If a test is genuinely wrong because the SDK semantics
  changed, rewrite it; don't skip it.
- **Never** `--no-verify` on commits or `--force` on pushes.
- **Never** rewrite history on `main` or on any branch other than
  `sdk-update/{{NEW_VERSION}}`.

### Work autonomously — there is no human to ask

This is a fully autonomous, headless run. **There is no human on the
other end and no interactive prompt** — you cannot ask a question,
request confirmation, or wait for a decision. Anything that reads like
"should I…?" or "I'll pause here until someone confirms…" is a dead
end: nobody will answer, and the run just burns turns until it times
out. Decide, act, and document.

- **Ambiguity is yours to resolve, not to escalate.** When a changelog
  item's intent is unclear, or a design choice has no obviously-correct
  answer, do **not** stop. Choose the most conservative option that
  fits the codebase's existing conventions and the changelog's intent,
  implement it, and record the assumption + the alternative you
  rejected under "## Risks / follow-ups" in the run-notes. That section
  becomes the PR body, so the reviewer can confirm or correct your call
  **on the PR** — that is the channel for anything that genuinely needs
  a human, *after* you've shipped your best-effort answer, never instead
  of it. A documented best-effort decision always beats a halted run.
- **Stopping is only for a genuine block, after real effort.** For a
  red gate, "real effort" has a concrete shape: you spawned at least
  one focused diagnose-and-fix agent against the failure, applied its
  proposed fix, re-ran **all** gates from the top, and the same gate
  (or a new one surfaced by the fix) is still red — twice. Stopping
  after the first red is not real effort; it is reporting done at the
  wrong moment. Only once you've cleared that bar may you write what's
  blocking you into "## Risks / follow-ups", commit what you have, and
  stop; the orchestrator opens a draft PR and pings a human. "Stuck
  after trying twice" is a valid stop. "Unsure, so I'll ask" is not —
  resolve it yourself and document it.
- This autonomy does **not** relax the constraints above. Never disable
  a test or lint rule, never `--no-verify`, never hack a gate to green
  just to avoid stopping. The escape hatch for uncertainty is a
  documented decision, not a weakened gate.

Now start. The branch is checked out, deps are installed, the
changelog is below.

**Your first action should be to read the "## Changelog block"
section at the bottom of this prompt. Your second should be to Read
`.claudius/sdk-updater/run-notes/{{NEW_VERSION}}.md` and Edit it to
fill in the placeholders — that is the analysis pass. Then implement
the code changes that analysis calls for: shipping that working code
is the actual goal.**

---

## Changelog block

{{CHANGELOG_BLOCK}}

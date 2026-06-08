# Claude Code parity pipeline

Hourly pipeline that watches npm for new `@anthropic-ai/claude-code`
releases (the CLI npm package), reviews the changelog for features
Claudius should reimplement in the browser, and opens a PR. Sibling
to the SDK updater under `scripts/sdk-update/`. Designed to be
installed as a cron line on a Linux server you control — not your
laptop.

The two pipelines share `.claudius/run.lock` so they block each other
on purpose: their cron lines fire at offset minutes (`0 * * * *` for
SDK, `15 * * * *` for cc-parity) and on a normal hour each finishes
well before the other starts.

---

## The A/B/C bucketing model — read this first

The cc-parity pipeline classifies every substantive Claude Code
changelog entry into one of three buckets and ships only one of them.
Understanding the buckets is the entire point of reviewing one of
these PRs:

### Bucket A — engine features exposed via the SDK

The feature lands in Claudius automatically when the SDK updater bumps
`@anthropic-ai/claude-agent-sdk` to the version that exposes it.
Examples: new permission modes (`acceptEdits`, `bypassPermissions`),
new `query()` options (session resume, MCP transports, hooks), new
event types streamed from the agent, new tool surfaces baked into the
SDK.

**The cc-parity pipeline marks these `[skip — already via SDK updater]`
and does NOT implement them.** Doing the work here too would duplicate
effort with the SDK updater and risk merge conflicts when its PR lands.

### Bucket B — product-surface features Claudius reimplements

The feature exists outside the SDK and is something a Claudius user
should be able to do in the browser. Examples:

- new settings (`autoCompact`, `disableAutoUpdater`, …) — Claudius
  reads them from its own settings store, not from the CLI's config
  file.
- new slash commands the CLI ships (`/agents`, `/memory`, `/usage`,
  `/cost`).
- new UI affordances (status indicators, panes, keyboard shortcuts).
- changed defaults (default model, default permission mode, default
  thinking budget).

**This is what the pipeline ships.** Every bucket-B item is wired
through end-to-end: server-side handling, SSE events if needed, client
hook, React component, settings persistence, e2e spec, screenshot.

### Bucket C — terminal/CLI-only

The feature only makes sense in a terminal context. Examples:
statusline rendering (`/statusline`), key chords (`Ctrl+R` for
history), shell integration (zsh/bash completion), terminal output
styles (`--style`), streaming JSON output formats.

**The pipeline marks these `[skip — CLI/terminal only]` and does NOT
implement them.** Claudius is a browser app; there is no terminal to
integrate with.

---

## The "feature-generation" caveat — read this twice

The cc-parity pipeline produces **design proposals**, not finished
work. Gates downstream of Claude (lint / test / build / e2e) prove
that **nothing broke**, NOT that the implementation matches Claudius's
intended UX. A green run with a wrong-shape bucket-B implementation
is still a wrong implementation — the gate has no way to know.

**Every PR this pipeline opens must be reviewed as a design proposal.**
The single highest-leverage review action is the **Changelog
classification** section in the PR body: confirm or correct the bot's
A/B/C bucketing for each substantive entry. A misclassified entry
(bucket B treated as bucket A, or vice versa) is the most common way
this pipeline ships the wrong thing.

The PR body banner repeats this warning at the top of every cc-parity
PR. The "Risks / follow-ups" section in the run-notes is where the bot
documents alternative shapes it considered and rejected — read it to
see what trade-offs the bot made.

---

## PR volume — be ready for the firehose

Claude Code releases roughly **daily**. After filtering pure bug-fix
releases, expect **2–5 substantive cc-parity PRs per week** under
default settings. Most will land bucket-B implementations (settings,
slash commands, small UI surfaces); some will be all-bucket-A (every
entry already covered by the SDK updater) and the PR body will be
mostly skip markers + a "no code changes required" note.

If the volume is too high for your review bandwidth, throttle the
cron with `CC_PARITY_MIN_HOURS_BETWEEN_RUNS=<n>` (default 0 — every
firing is allowed). At 24 the pipeline runs at most once per day.

---

## Layout

```
scripts/cc-parity/
├── README.md          # this file
├── check.ts           # npm probe + state file + decision logic
├── orchestrate.ts     # the pipeline (branch → Claude → gate → PR → announce → CI → announce); also `fixPr()`
├── prompt.md          # the review prompt Claude runs with
├── fix-prompt.md      # the fix-an-existing-PR prompt
├── pr-template.md     # PR body template
└── run.sh             # cron entrypoint with flock guard (shared lock)
```

State lives alongside other Claudius local state:

```
.claudius/
├── run.lock                # SHARED flock — same file the sdk-update pipeline uses
└── cc-parity/
    ├── env                     # optional secrets; falls back to .claudius/sdk-updater/env
    ├── state.json              # lastCheckedAt, lastSeenVersion, lastCompletedVersion, inFlight, skipped
    ├── logs/cron.log           # stdout/stderr from every cron firing
    └── run-notes/<v>.md        # Claude writes one per review — orchestrator parses into PR body
```

Everything under `.claudius/` is already gitignored.

---

## How a firing flows

1. **Cron** invokes `scripts/cc-parity/run.sh` at 15 past every hour.
2. **`run.sh`** takes the SHARED `flock` (no overlap with sdk-update),
   sources `.claudius/cc-parity/env` (or falls back to
   `.claudius/sdk-updater/env`), then runs `check.ts`.
3. **`check.ts`** GETs
   `registry.npmjs.org/@anthropic-ai/claude-code/latest`,
   compares against `state.lastCompletedVersion ?? state.lastSeenVersion`,
   and emits one JSON line:
   - `noop` — baseline already at-or-newer than latest, or no baseline
     yet (first ever run records `lastSeenVersion = latest` and noops),
     or the upstream CHANGELOG slice contains only bug-fix entries.
   - `in-flight` — `state.json.inFlight` is non-null.
   - `skip` — jump exceeds `CC_PARITY_MAX_MINOR_JUMP`; recorded.
   - `run` — start the review.
4. If `run`, **`orchestrate.ts`** takes over:
   1. Pre-flight: auth, `gh`, working tree.
   2. `git fetch origin` and create `cc-parity/<version>` fresh off
      `origin/main`.
   3. **Announce** "🆔 New claude-code release: PREV → NEW. Starting
      parity review on branch …" — the 🆔 emoji differs from the SDK
      updater's 🆕 so the channel can tell the two pipelines apart.
   4. **Do NOT bump any package.json dependency.** Claudius doesn't
      depend on `@anthropic-ai/claude-code`. The upstream changelog
      is sourced over the network for analysis only.
   5. Extract the changelog (`gh api` at the new tag → `curl` on
      `main` → `gh api compare` commit list — three layers of
      fallback).
   6. **Announce** the changelog body (clipped to 1700 chars).
   7. Pre-create the run-notes stub at
      `.claudius/cc-parity/run-notes/<v>.md` with the cc-parity
      section list (Summary / Changelog classification / Implemented
      (bucket B) / New UI surfaces / Tests / Risks / follow-ups).
   8. Render `prompt.md` and call `runClaude` (reused from
      `scripts/sdk-update/orchestrate.ts`). Auto-approve every tool
      call via `canUseTool`. Permission mode "default". Workflows
      enabled.
   9. **Announce** the Summary section Claude wrote.
   10. **Announce** "🧪 running local gates".
   11. Gate: `bun run lint`, `bun run test`, `bun run build`,
       `bun run test:e2e`.
   12. **Announce** the gate verdict.
   13. If green: bump Claudius's own **patch** version (the SDK
       updater owns the minor channel; cc-parity bumps patch each
       time it ships, so the displayed version stays monotonic and
       the two pipelines never fight over `package.json:version`).
       Commit the bump.
   14. Push, open the draft PR via `openPr()`, retitle to
       `feat(cc-parity): claude-code <prev> → <new>`, announce.
   15. Watch CI. On green, mark ready, drop `needs-human`, post the
       pinned "shipped" announce. Update `state.json`:
       `lastCompletedVersion = newVersion`, clear `inFlight`.

The progress announces are suppressed under `--dry-run` so local
prompt iteration doesn't spam the channel.

### Fixing a PR after the fact

When a run lands a draft (or a reviewer asks for changes), re-run
Claude against the existing PR by number:

```bash
make cc-parity-fix-pr PR=123
make cc-parity-fix-pr PR=123 MSG="address the review note on the slash command"
make cc-parity-fix-pr PR=123 SKIP=e2e
```

Same flow as the SDK updater's `fix-pr` mode but with cc-parity
wording on the start + result messages. Runs under the SHARED `flock`,
so it won't overlap an in-flight SDK update either.

---

## Setup on a Linux server

If you already have the SDK updater installed, most of the setup is
done. No extra Anthropic credentials, gh tokens, or chat-server tokens
needed — the cc-parity pipeline reads from
`.claudius/sdk-updater/env` if `.claudius/cc-parity/env` is missing.

### 1. Required commands

`bun`, `git`, `gh` (≥ 2.30), `flock` (in `util-linux`), `curl`.

### 2. Optional cc-parity env file

```bash
mkdir -p .claudius/cc-parity/logs
cat > .claudius/cc-parity/env <<'EOF'
# Same room as sdk-update — emojis disambiguate.
CC_PARITY_ROOM_SLUG=sdk-update
# Tunables (defaults shown):
# CC_PARITY_MODEL=sonnet
# CC_PARITY_MAX_TURNS=200
# CC_PARITY_MAX_WALL_MIN=360
# CC_PARITY_MAX_MINOR_JUMP=1
# CC_PARITY_MIN_HOURS_BETWEEN_RUNS=0     # throttle for noisy weeks
EOF
chmod 600 .claudius/cc-parity/env
```

If you skip this file the SDK updater's env gets used and the
defaults take effect — no further setup needed.

> Note: most of the `CC_PARITY_*` tunables aren't actually
> separately honoured today (the orchestrator reuses
> `runClaude` from the SDK updater, which reads `SDK_UPDATE_*` env
> vars for model/turns/wall/idle budgets). If you want separate
> per-pipeline ceilings, add `CC_PARITY_*` reads to `runClaude` —
> the env-var prefix is reserved here for that future split.

### 3. Install the cron line

```bash
make cc-parity-install-cron
```

This appends a `15 * * * *` entry to the current user's crontab and is
idempotent. Inspect with `crontab -l`; remove with
`make cc-parity-uninstall-cron`. The 15-minute offset from the
sdk-update line (`0 * * * *`) means a normal-length sdk-update finishes
before this one fires, and a long-running one cleanly blocks it via
the shared lock.

### 4. Smoke-test

```bash
make cc-parity-check    # dry-run: prints decision JSON
make cc-parity-status   # shows state.json + shared lock state
make cc-parity-logs     # tails .claudius/cc-parity/logs/cron.log
```

The first time `cc-parity-check` runs it noops with "no baseline yet"
and records `lastSeenVersion = latest`. The second firing (next cron
tick) starts comparing against that baseline — no giant catch-up
review on day one.

---

## Day-to-day operation

| Make target | What it does |
| --- | --- |
| `make cc-parity-check` | Version probe + CHANGELOG slice. Prints decision JSON, updates `state.lastCheckedAt` / `state.lastSeenVersion`. Doesn't touch git. |
| `make cc-parity-run` | One-shot manual firing — same code path as the cron line. **Will** create a branch, push, and open a PR if a substantive release is out. |
| `make cc-parity-fix-pr PR=<n>` | Re-run Claude against an existing PR by number. **Will** push to the PR's branch. Optional `MSG="…"` instruction and `SKIP=lint,e2e`. |
| `make cc-parity-dry-run` | Same as `cc-parity-run` through the gate, then stops before push/PR/CI/announce. Pass `SKIP=e2e` for fast iteration. |
| `make cc-parity-status` | Prints `state.json` and tells you if the SHARED `run.lock` is currently held. |
| `make cc-parity-logs` | Tails the cron log. `FOLLOW=1` for `tail -f`. |
| `make cc-parity-install-cron` | Adds the `15 * * * *` entry to the current user's crontab. Idempotent. |
| `make cc-parity-uninstall-cron` | Removes the entry. |

---

## Failure modes

The cc-parity pipeline shares most of its failure modes with the SDK
updater. The ones unique to cc-parity:

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| `cc-parity-check` keeps emitting `noop` even though there's a new release | Bug-fix-only filter triggered, or your baseline already covers it | Inspect the slice: `bun run scripts/cc-parity/check.ts 2>&1 \| tail` shows the decision reason. The filter only fires when EVERY meaningful line in the slice looks like a bug fix; an empty slice falls through to "run". |
| First firing returns `noop` with "no baseline yet" | This is normal — there's no `lastSeenVersion` in state | The probe records `lastSeenVersion = latest`. The next firing starts comparing. No action needed. |
| PR opens with classification all `[A]` and no shipped items | This release was pure engine — bucket A is correct | Confirm the bucketing in the PR body and merge if you agree. The SDK updater will absorb the engine changes when its corresponding PR lands. |
| PR opens with the wrong bucketing | The bot misclassified an entry | Comment on the PR, then `make cc-parity-fix-pr PR=<n> MSG="treat entry X as bucket B, ship it as a setting"`. |
| Two PRs touch the same `package.json:version` field | Both pipelines bumped on overlapping merges | The cc-parity pipeline bumps **patch**; sdk-update bumps to match the SDK (also patch within a minor line, but minor when SDK minors). Conflicts are 1-line and trivial to resolve in either PR. |

For shared failure modes (lock held, gh not authed, etc.), see
`scripts/sdk-update/README.md#failure-modes`.

---

## Security model

Same as the SDK updater — the chokepoints (auto-approve `canUseTool`,
push only to `cc-parity/<version>`, PR opens against `main` for human
review, CI runs before any announcement) are reused unchanged.
Strongly recommended: run the cron as a dedicated non-root user.

The env file `.claudius/cc-parity/env` should be `chmod 600` if you
create it. The pipeline never writes secrets to logs.

---

## Editing the prompt

`prompt.md` is the contract with Claude. The placeholders
(`{{PREVIOUS_VERSION}}`, `{{NEW_VERSION}}`, `{{CHANGELOG_BLOCK}}`) are
substituted by `renderPrompt()` in `orchestrate.ts`.

Things you might reasonably want to tune:

- **Bucket definitions.** If you find the bot consistently miscategorising
  a particular kind of entry, sharpen the bucket text with a worked
  example.
- **Conservative defaults principle.** Currently set to "settings
  first, UI under follow-ups". Loosen if you want richer first-pass
  PRs.
- **Workflow fan-out cap.** The prompt warns "a handful of agents per
  phase, not dozens"; raise if budgets allow.

After editing the prompt, the next cron firing picks up the new file.

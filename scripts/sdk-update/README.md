# SDK updater

Hourly pipeline that watches npm for new `@anthropic-ai/claude-agent-sdk`
releases, lets Claude do the upgrade end-to-end, opens a PR against
`main`, monitors CI, and announces the result on the community
channel. Designed to be installed as a cron on a Linux server you
control — not your laptop.

The repo's TypeScript is deliberately thin. Everything that needs
judgment (which changelog items to ship, how to migrate call sites,
how to wire the UI, how to debug a red test) is delegated to one
`query()` call against the Agent SDK. The scripts handle the
deterministic plumbing: version arithmetic, git, `gh pr create`,
`gh pr checks --watch`, and the HTTP POST to chat-server.

---

## Layout

```
scripts/sdk-update/
├── README.md          # this file
├── check.ts           # npm probe + state file + decision logic
├── orchestrate.ts     # the pipeline (branch → bump → Claude → gate → PR → CI → announce)
├── prompt.md          # the prompt Claude runs with (placeholders substituted)
├── pr-template.md     # PR body template
└── run.sh             # cron entrypoint with flock guard
```

State lives outside the scripts dir, alongside other Claudius local state:

```
.claudius/sdk-updater/
├── env                # secrets (chmod 600). Optional; falls back to inherited env.
├── state.json         # lastCheckedAt, lastSeenVersion, lastCompletedVersion, inFlight, skipped
├── run.lock           # flock target — held while a run is in flight
├── logs/cron.log      # stdout/stderr from every cron firing
└── run-notes/<v>.md   # Claude writes one per upgrade — orchestrator parses into PR body
```

Everything under `.claudius/` is already gitignored.

---

## How a firing flows

1. **Cron** invokes `scripts/sdk-update/run.sh` at the top of every hour.
2. **`run.sh`** takes a `flock` (no overlapping firings), sources
   `.claudius/sdk-updater/env`, then runs `check.ts`.
3. **`check.ts`** GETs `registry.npmjs.org/@anthropic-ai/claude-agent-sdk/latest`,
   compares against `package.json`, and emits one JSON line:
   - `noop` — installed is at-or-newer than latest.
   - `in-flight` — `state.json.inFlight` is non-null (another run is going).
   - `skip` — jump exceeds `SDK_UPDATE_MAX_MINOR_JUMP`; recorded in
     `state.skipped` so we don't re-flag it every hour.
   - `run` — do the upgrade.
4. If `run`, **`orchestrate.ts`** takes over:
   1. Pre-flight: `ANTHROPIC_API_KEY` set, `gh` authed, working tree
      clean. Refuses to start otherwise.
   2. `git fetch origin` and create `sdk-update/<version>` fresh off
      `origin/main` (stale local branch with the same name is deleted).
   3. Rewrite the SDK line in `package.json`, run `bun install`,
      commit `chore(deps): bump claude-agent-sdk to <version>`.
   4. Extract the changelog (local CHANGELOG.md → `gh api compare` →
      stub URL fallback).
   5. Render `prompt.md` with `{{PREVIOUS_VERSION}}`,
      `{{NEW_VERSION}}`, `{{CHANGELOG_BLOCK}}`.
   6. Call `query()` from `@anthropic-ai/claude-agent-sdk` with
      `permissionMode: 'bypassPermissions'`,
      `allowDangerouslySkipPermissions: true`,
      `maxTurns` and a wall-clock guard. Streams agent messages and
      logs one line per turn. Aborts on budget exhaustion.
   7. Gate: `bun run lint`, `bun run test`, `bun run build`,
      `bun run test:e2e`.
   8. `git push -u --force-with-lease origin sdk-update/<version>`.
   9. `gh pr create --base main` with a body rendered from
      `pr-template.md` + the run-notes file Claude wrote. If a PR
      already exists for this branch (re-run case), edits the
      existing body in place instead of failing.
   10. `gh pr checks <url> --watch --fail-fast`.
   11. If CI is green, POST `{roomSlug, body, pin: true}` to
       `<CHAT_SERVER_URL>/admin/announce` with the admin token.

If anything between step 6 and step 10 leaves the suite red, OR the
budget runs out, the PR is opened as **draft** with the
`needs-human` label and a warning banner in the body. No
announcement is posted in that case.

---

## Setup on a Linux server

You need a long-lived host (not your laptop) with internet access to
npm, GitHub, your chat-server, and the Anthropic API.

### 1. Required commands

`bun`, `git`, `gh` (≥ 2.30, for `pr checks --watch --fail-fast`),
`flock` (in `util-linux` — present on every mainstream distro).

### 2. Clone + install

```bash
cd /srv
git clone https://github.com/<owner>/claudius.git
cd claudius
bun install
```

### 3. Authenticate `gh`

Either:

```bash
gh auth login        # interactive — one-time
```

or put a `GH_TOKEN` in the env file below. The token needs `repo`
scope (push, open PRs, read checks) and `read:org` if the repo is
under an org.

### 4. Authenticate Claude

You only need ONE of these — the Agent SDK accepts any of them:

- **Recommended on a host where you've already got Claude Code:** just
  run `claude /login` once as the cron user. The SDK reads
  `~/.claude/.credentials.json` automatically. Nothing else to do.
- **Or:** put `ANTHROPIC_API_KEY=sk-ant-…` in the env file below.
- **Or:** put `CLAUDE_CODE_OAUTH_TOKEN=…` in the env file below.

### 5. Drop the env file

```bash
mkdir -p .claudius/sdk-updater/logs
cat > .claudius/sdk-updater/env <<'EOF'
# Claude auth — uncomment ONE if not using `claude /login`:
# ANTHROPIC_API_KEY=sk-ant-...
# CLAUDE_CODE_OAUTH_TOKEN=...

GH_TOKEN=ghp_...                          # optional if gh auth login was used
CHAT_SERVER_URL=https://chat.your-host.tld
CHAT_SERVER_ADMIN_TOKEN=...               # matches your chat-server's admin token
SDK_UPDATE_ROOM_SLUG=sdk-update
# Tunables (defaults shown):
# SDK_UPDATE_MODEL=sonnet
# SDK_UPDATE_MAX_TURNS=200
# SDK_UPDATE_MAX_WALL_MIN=360
# SDK_UPDATE_MAX_MINOR_JUMP=1
EOF
chmod 600 .claudius/sdk-updater/env
```

### 6. Create the announcement room (one-time)

The orchestrator assumes the room already exists on your chat-server.
Create it once:

```bash
curl -X POST "$CHAT_SERVER_URL/admin/rooms" \
  -H "X-Admin-Token: $CHAT_SERVER_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"slug":"sdk-update","name":"SDK updates","description":"Auto-posted by the SDK updater."}'
```

### 7. Install the cron line

```bash
make sdk-update-install-cron
```

This appends one hourly entry to the current user's crontab and is
idempotent. Inspect it with `crontab -l`. Remove with
`make sdk-update-uninstall-cron`.

### 8. Smoke-test

```bash
make sdk-update-check    # dry-run: prints decision JSON
make sdk-update-status   # shows state.json + lock state
make sdk-update-logs     # tails .claudius/sdk-updater/logs/cron.log
```

If `check` says `skip` because the minor jump is too large, either
pre-bump the SDK in `package.json` toward the latest version
manually, or temporarily set `SDK_UPDATE_MAX_MINOR_JUMP` higher.

---

## Day-to-day operation

| Make target | What it does |
| --- | --- |
| `make sdk-update-check` | Version probe only. Prints decision JSON, updates `state.lastCheckedAt`. Doesn't touch git. |
| `make sdk-update-run` | One-shot manual firing — same code path as the cron line. **Will** create a branch, push, and open a PR if a new version is out. |
| `make sdk-update-dry-run` | Same as `sdk-update-run` through the gate, then stops **before** push/PR/CI/announce. Branch + Claude's commits stay on disk for inspection. Pass `SKIP=e2e` (or any comma-separated subset of `lint,unit,build,e2e`) to skip slow gate steps — the typical fast-feedback combo is `SKIP=e2e make sdk-update-dry-run`. |
| `make sdk-update-status` | Prints `state.json` and tells you if `run.lock` is currently held. |
| `make sdk-update-logs` | Tails the cron log. `make sdk-update-logs FOLLOW=1` for `tail -f`. |
| `make sdk-update-install-cron` | Adds the hourly entry to the current user's crontab. Idempotent. |
| `make sdk-update-uninstall-cron` | Removes the entry. |

---

## Configuration

All env vars are optional unless flagged otherwise.

### Required

| Var | What it does |
| --- | --- |
| Claude auth — pick one | `ANTHROPIC_API_KEY` env, *or* `CLAUDE_CODE_OAUTH_TOKEN` env, *or* a logged-in `claude /login` on the host (the Agent SDK reads `~/.claude/.credentials.json` automatically). The orchestrator's pre-flight accepts any of these. |
| `CHAT_SERVER_URL` | Base URL of the chat-server, e.g. `https://chat.your-host.tld`. |
| `CHAT_SERVER_ADMIN_TOKEN` | Matches the admin token configured on the chat-server. |
| `GH_TOKEN` *or* an interactive `gh auth login` | Either is sufficient; the orchestrator just shells out to `gh`. |

### Tunables

| Var | Default | What it does |
| --- | --- | --- |
| `SDK_UPDATE_MODEL` | `sonnet` | Claude model alias for the upgrade run. |
| `SDK_UPDATE_MAX_TURNS` | `200` | Maximum agentic round-trips before the SDK stops the run. |
| `SDK_UPDATE_MAX_WALL_MIN` | `360` | Wall-clock budget in minutes. Orchestrator-side guard layered on top of the SDK's own ceiling. |
| `SDK_UPDATE_MAX_MINOR_JUMP` | `1` | Refuse to upgrade if `latest - installed` is more minors than this. Stops the first cron firing from trying to absorb a year of changes in one PR. |
| `SDK_UPDATE_STALE_INFLIGHT_HOURS` | `24` | Self-heal threshold. If `state.inFlight` is older than this, the next firing reclaims it instead of returning `in-flight` forever. Stops a SIGKILL/OOM/host-reboot from bricking the cron. |
| `SDK_UPDATE_ROOM_SLUG` | `sdk-update` | Which chat-server room to post into when CI goes green. |

---

## Failure modes

The orchestrator has one bite at the gate. After Claude exits, if any
of `bun run lint`, `bun run test`, `bun run build`, `bun run test:e2e`
fails, OR if the wall-clock/turn budget runs out, the PR opens as
**draft** with the label `needs-human` and a warning banner. There is
no automatic Claude re-invocation after a red gate — Claude already
had the full budget upfront and the prompt instructs it to iterate
until green.

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| PR opens but is `draft` with `needs-human` | Budget exhausted or gate red | Open the PR, read the warning banner + run-notes section, fix the remaining issues by hand or with `claude` locally on that branch, then mark ready. |
| `check.ts` keeps emitting `skip` for the same version | Jump exceeds `SDK_UPDATE_MAX_MINOR_JUMP` | Pre-bump manually toward latest, or raise the limit. Skipped versions live in `state.skipped` — the entry is removed automatically the moment `decide()` makes a `run` choice. |
| `run.lock` is held but no orchestrator is running | Previous firing was killed mid-run | `rm .claudius/sdk-updater/run.lock`. `state.inFlight` self-heals on its own after `SDK_UPDATE_STALE_INFLIGHT_HOURS` (default 24h); set the var lower or `rm state.json` to short-circuit. |
| `check.ts` keeps returning `in-flight` after a previous crash | `state.inFlight` was never cleared (SIGKILL / OOM / host reboot) | Wait for the 24h self-heal, OR `rm .claudius/sdk-updater/state.json` for immediate recovery (it's rebuilt with defaults on next run). |
| Two PRs appear (one from this updater, one from Dependabot) | Both bots have npm-ecosystem updates enabled | Exclude `@anthropic-ai/claude-agent-sdk` from `.github/dependabot.yml`, or accept the duplication and close one. |
| `gh pr checks --watch` exits but no announcement | CI failed | The orchestrator deliberately skips the announcement when CI is red. Look at the PR's checks tab. |
| Cron silently does nothing | flock held, env file missing, or `check.ts` exited non-zero | `make sdk-update-status` + `make sdk-update-logs`. |

---

## Security model

- The env file contains four secrets. `chmod 600` it; do not commit it.
  `.claudius/` is already gitignored.
- The Anthropic API key is exposed only to the orchestrator process,
  which runs as the same user as cron. Cron itself runs detached;
  there's no shell session for an unrelated user to attach to.
- `permissionMode: 'bypassPermissions'` + `allowDangerouslySkipPermissions: true`
  means Claude can run any tool inside the repo without prompting. That
  includes `Bash`, `Edit`, `Write`. The trade is: this is a headless
  upgrade rig on a server you own; there's no human at a terminal to
  approve each tool call. The hard-coded guardrails compensate —
  Claude can only push to `sdk-update/<version>` (force-with-lease
  refuses to clobber `main`), the PR opens against `main` for human
  review, and CI runs before any announcement is fired.
- The chat-server admin endpoint is gated by the admin token in
  `X-Admin-Token`. Treat that token like a deploy key.

---

## Editing the prompt

`prompt.md` is the contract with Claude. Tune it freely — the
placeholders (`{{PREVIOUS_VERSION}}`, `{{NEW_VERSION}}`,
`{{CHANGELOG_BLOCK}}`) are substituted by `renderPrompt()` in
`orchestrate.ts`, so keep them present and keep their spelling.

Things you might reasonably want to change:

- **Scope of "user-facing capability."** Currently scoped to "things
  a Claudius user can now do, see, or configure". Tighten or loosen
  it if Claude generates too many or too few components.
- **Test scope.** The "Definition of done" lists the four gates. If
  you add new test suites (e.g. a separate API contract suite),
  list them so Claude includes them in its own iteration loop.
- **Commit cadence.** The suggested breakdown is informational, not
  enforced. If you want squashed commits, say so.

After editing the prompt, you don't need to redeploy anything — the
next cron firing picks up the new file.

---

## Editing the PR template

`pr-template.md` placeholders match what `renderPrBody()` in
`orchestrate.ts` substitutes:

| Placeholder | Source |
| --- | --- |
| `{{NEW_VERSION}}` / `{{PREVIOUS_VERSION}}` | npm registry + `package.json` |
| `{{CHANGELOG_URL}}` | `https://github.com/anthropics/claude-agent-sdk-typescript/compare/v…` |
| `{{CHANGELOG_BODY}}` | Same source the prompt got |
| `{{NOTES_SUMMARY}}` / `{{NOTES_SDK}}` / `{{NOTES_CODE}}` / `{{NOTES_UI}}` / `{{NOTES_TESTS}}` / `{{NOTES_RISKS}}` | The matching `## Section` block in `.claudius/sdk-updater/run-notes/<version>.md` (which Claude writes) |
| `{{SCREENSHOTS_BLOCK}}` | One `![…](raw.githubusercontent.com/…)` line per file under `docs/sdk-updates/<version>/` |
| `{{BUDGET_STATUS}}` | Empty on clean runs; warning banner on draft/needs-human runs |

The screenshot URLs reference the PR's head branch — they render in
GitHub immediately, no separate upload step.

---

## Local development

You can iterate on the orchestrator without a cron. Run a probe:

```bash
make sdk-update-check
```

Or kick off a manual upgrade on a throwaway branch:

```bash
ANTHROPIC_API_KEY=sk-ant-... \
CHAT_SERVER_URL=http://localhost:8787 \
CHAT_SERVER_ADMIN_TOKEN=... \
SDK_UPDATE_MAX_WALL_MIN=30 \
make sdk-update-run
```

Use a `chat-server` instance you control. The `--force-with-lease`
push will refuse to clobber a branch that diverged on the remote, so
you can't accidentally trash an existing `sdk-update/<version>` PR.

If you want to test the orchestrator's logic without spending tokens
on a real upgrade, point `SDK_UPDATE_MODEL` at a small model (still
`sonnet` is the cheapest sensible option here — `haiku` won't finish
this task well) and set `SDK_UPDATE_MAX_TURNS=3` to make it bail
into the draft-PR path quickly.

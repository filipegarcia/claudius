# Claudius update pipelines — deployment & operation

This is the entry-point guide for running Claudius's two automated update
pipelines from **one** cron on a host you control (a Linux server **or** a
Mac). It covers the combined entrypoint, setup, the macOS gotchas, and
day-to-day operations.

For the internals of each pipeline, see the detailed sub-guides:

- [`sdk-update/README.md`](./sdk-update/README.md) — bumps
  `@anthropic-ai/claude-agent-sdk`, lets Claude do the upgrade, opens a PR.
- [`cc-parity/README.md`](./cc-parity/README.md) — watches
  `@anthropic-ai/claude-code`, classifies the changelog, reimplements the
  browser-relevant features.

---

## What runs

A single script — [`update-pipeline.sh`](./update-pipeline.sh) — runs both
pipelines back-to-back every hour:

```
cron (0 * * * *)
  └─ scripts/update-pipeline.sh
       ├─ 1. scripts/sdk-update/run.sh   # SDK bump (+ combined CC parity)
       └─ 2. scripts/cc-parity/run.sh    # standalone CC parity, if any
```

**Order matters.** The SDK half runs first. When *both* the SDK and Claude
Code have a new release, the SDK half does them together in one combined PR
and advances the cc-parity state — so the CC half then noops. When only
Claude Code moved, the SDK half noops and the CC half does the work. Either
half running long makes the next hour's firing back off cleanly (shared
single-instance lock at `.claudius/run.lock.d`).

Both halves are safe to run unattended: no interactive prompts, no stdin,
all output to stdout/stderr (captured to the cron log).

---

## Prerequisites

| Need | Notes |
|------|-------|
| `bun`, `git`, `gh` (≥ 2.30), `curl` | On the host's PATH. No `flock` needed — locking is portable (works on macOS). |
| A long-lived host | Internet access to npm, GitHub, your chat-server, and the Anthropic API. |
| `gh` authenticated | `gh auth login` once, or a `GH_TOKEN` in the env file (scopes: `repo`, plus `read:org` for org repos). |
| Claude auth | One of: `claude /login` once (SDK reads `~/.claude/.credentials.json`), `ANTHROPIC_API_KEY`, or `CLAUDE_CODE_OAUTH_TOKEN`. |
| Chat-server (optional) | For announcements: `CHAT_SERVER_URL` + `CHAT_SERVER_ADMIN_TOKEN`. Omit to skip posting. |

---

## Quick start

```bash
# 1. Clone + install on the host
git clone https://github.com/<owner>/claudius.git
cd claudius
bun install

# 2. Authenticate (pick what fits your host)
gh auth login            # or set GH_TOKEN in the env file below
claude /login            # or set ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN below

# 3. Drop the env file (shared by both pipelines)
mkdir -p .claudius/sdk-updater/logs .claudius/logs
cat > .claudius/sdk-updater/env <<'EOF'
# Claude auth — uncomment ONE if you didn't run `claude /login`:
# ANTHROPIC_API_KEY=sk-ant-...
# CLAUDE_CODE_OAUTH_TOKEN=...

# GitHub — optional if you ran `gh auth login`:
# GH_TOKEN=ghp_...

# Chat-server announcements — optional:
# CHAT_SERVER_URL=https://chat.your-host.tld
# CHAT_SERVER_ADMIN_TOKEN=...
# SDK_UPDATE_ROOM_SLUG=sdk-update

# Tunables (defaults shown):
# SDK_UPDATE_MODEL=sonnet
# SDK_UPDATE_MAX_TURNS=200
# SDK_UPDATE_MAX_WALL_MIN=360
# SDK_UPDATE_MAX_MINOR_JUMP=1
# CC_PARITY_MAX_MINOR_JUMP=1
EOF
chmod 600 .claudius/sdk-updater/env

# 4. Smoke-test before scheduling (read-only — no PRs)
make sdk-update-check
make cc-parity-check

# 5. Install the single cron line
make update-install-cron
```

> The cc-parity half reads `.claudius/cc-parity/env` if present, otherwise
> falls back to `.claudius/sdk-updater/env` above — so one env file covers
> both. See [`cc-parity/README.md`](./cc-parity/README.md) for the
> `CC_PARITY_*` overrides.

`make update-install-cron` adds one idempotent crontab entry:

```
0 * * * * /path/to/claudius/scripts/update-pipeline.sh >> /path/to/claudius/.claudius/logs/update-pipeline.log 2>&1
```

Inspect with `crontab -l`; remove with `make update-uninstall-cron`.

---

## macOS setup (read this — two silent-no-op traps)

The pipeline runs fine on macOS, but macOS cron has two defaults that will
make it fire hourly and **quietly do nothing** unless you handle them:

1. **PATH — handled for you.** cron/launchd run with a minimal `PATH`
   (`/usr/bin:/bin`) that won't find `bun` (`~/.bun/bin`) or Homebrew's
   `gh` (`/opt/homebrew/bin` on Apple Silicon, `/usr/local/bin` on Intel).
   `update-pipeline.sh` prepends those before running anything, so the
   **combined** cron just works. If your tools live elsewhere, edit the
   `export PATH=…` line at the top of `update-pipeline.sh`.

2. **Full Disk Access — you must grant this once.** Since macOS Catalina,
   `/usr/sbin/cron` has no Full Disk Access, so a cron job's reads of
   protected paths fail silently — including `~/.claude/.credentials.json`,
   the SDK's default auth file. Grant it:

   **System Settings → Privacy & Security → Full Disk Access → `+` →**
   press **⌘⇧G**, type `/usr/sbin/cron`, add it, and toggle it on.

   Alternatively, put `ANTHROPIC_API_KEY=…` in the env file so the run
   never reads a protected path — then you can skip the grant.

> Prefer launchd over cron? You can wrap `update-pipeline.sh` in a
> `launchd` `.plist` with a `StartCalendarInterval`; the script is
> agent-manager-agnostic. Not provided here — cron is the supported path.

---

## Operating it

All targets run from the repo root.

| Command | What it does |
|---------|--------------|
| `make update-run` | Fire **both** pipelines now (same code path as cron). **Will** push and open PRs if there's a new release. |
| `make update-dry-run` | Both pipelines through the gates, then stop before push/PR/announce. Add `SKIP=e2e` to skip slow gate steps. |
| `make update-logs` | Tail `.claudius/logs/update-pipeline.log`. `FOLLOW=1` to stream. |
| `make update-install-cron` | Install the single hourly cron line. Idempotent. |
| `make update-uninstall-cron` | Remove it. |
| `make sdk-update-status` / `make cc-parity-status` | Print each pipeline's `state.json` and whether the shared lock is held. |
| `make sdk-update-check` / `make cc-parity-check` | Probe — prints the decision JSON without touching git (updates `state.json` only). |
| `make sdk-update-fix-pr PR=<n>` / `make cc-parity-fix-pr PR=<n>` | Re-run Claude against an existing PR (failing CI + review comments as context), re-gate, mark ready if green. |

State and logs live under `.claudius/` (gitignored):

```
.claudius/
├── run.lock.d                      # shared single-instance lock (both pipelines)
├── logs/update-pipeline.log        # combined cron log
├── sdk-updater/{env,state.json,logs/,run-notes/}
└── cc-parity/{env,state.json,logs/,run-notes/}
```

---

## Daily heartbeat

A separate once-a-day job posts a liveness + activity summary to the same
community channel, so you know the automation is alive even on quiet days.
It runs [`scripts/heartbeat/run.sh`](./heartbeat/run.sh) and posts one
message:

- **Quiet day:** `💓 … alive. All quiet — no SDK or Claude Code update PRs …`
- **Active day:** `💓 … alive. N update(s) …` listing each pipeline PR with
  its outcome — ✅ merged, ⚠️ needs attention, 🔧 in progress, 👀 awaiting
  review, ❌ closed — plus any `… error` issues the pipelines filed (so a
  run that errored shows up too, "merged with error or not").

Source of truth is **GitHub** (the PR/issue records), not the state files —
only GitHub has the URLs and captures errored runs. The window is anchored
to the **last heartbeat run** (`.claudius/heartbeat/state.json`), so a
daily cron that drifts or gets skipped (machine asleep/off) never leaves a
gap — the next run catches up. A `gh` failure is reported as "couldn't
check GitHub", never as a false "all quiet".

It's read-only and quick, takes **no lock**, and runs fine alongside the
hourly update cron. Unlike the pipelines it reads `GH_TOKEN` /
`CHAT_SERVER_*` from the env file and does **not** read
`~/.claude/.credentials.json` — so the macOS Full Disk Access requirement
does **not** apply to it.

```bash
make heartbeat-dry-run        # build + print the message, don't post (safe, repeatable)
make heartbeat-run            # post now
make heartbeat-install-cron   # daily at 09:00 local
make heartbeat-uninstall-cron
make heartbeat-logs           # tail; FOLLOW=1 to stream
```

Overrides (env file or inline): `HEARTBEAT_ROOM_SLUG` (defaults to
`SDK_UPDATE_ROOM_SLUG`), `HEARTBEAT_WINDOW_HOURS` (first-run / fallback
look-back, default 24).

## How the lock & scheduling work

- **One firing at a time.** Each half takes a shared portable lock
  (`.claudius/run.lock.d`, an atomic `mkdir`) before doing work. A long run
  (upgrades can take hours) makes the next hour's firing log
  "another run is already in progress — skipping" and exit cleanly.
- **No `flock`.** The lock is a directory + holder PID
  ([`lib/run-lock.sh`](./lib/run-lock.sh)); a crashed run is reclaimed on
  the next firing when its PID is found dead. To force-clear a stuck lock:
  `rm -rf .claudius/run.lock.d`.
- **Stale in-flight markers** in `state.json` self-heal after 24h
  (`SDK_UPDATE_STALE_INFLIGHT_HOURS`), or `rm` the state file to reset.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Cron fires but nothing happens | **(macOS)** `bun`/`gh` not on cron's PATH, or `/usr/sbin/cron` lacks Full Disk Access | Use `make update-install-cron` (sets PATH); grant Full Disk Access (see macOS section). Check `make update-logs`. |
| "another run is already in progress — skipping" every hour | A previous firing was killed and the lock dir is stale | The next firing auto-reclaims a dead holder; to force it, `rm -rf .claudius/run.lock.d`. |
| No PRs despite new releases | `gh` not authenticated, or `GH_TOKEN` missing/insufficient scope | `gh auth status`; ensure `repo` (+ `read:org`) scope. |
| Auth errors from the agent | No Claude credential reachable | `claude /login` as the cron user, or set `ANTHROPIC_API_KEY` in the env file. |
| Nothing announced to chat | `CHAT_SERVER_URL` / token unset | Optional feature — set both env vars, or ignore. |
| Want to see what it *would* do | — | `make sdk-update-check` + `make cc-parity-check` (no git changes), or `make update-dry-run`. |

---

## Migrating from the old two-cron setup

Earlier the two pipelines were installed as **separate** cron lines
(`0 * * * *` for sdk-update, `15 * * * *` for cc-parity) using `flock`.
The combined line supersedes both. To switch:

```bash
make sdk-update-uninstall-cron cc-parity-uninstall-cron   # drop the old split lines
make update-install-cron                                  # add the single combined line
```

`make update-install-cron` warns if the old split lines are still present.

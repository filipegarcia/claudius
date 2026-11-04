# Claudius → Rust: master TODO

Every step from today's state (the session engine and core session routes are
ported and live-verified) to a pure-Rust Claudius. Strategy and rules live in
[PORT_PLAN.md](PORT_PLAN.md); this file is the work queue.

Inventory this was built from (2026-10-25):
- **API:** 182 `app/api/**/route.ts` files. 27 were served by Rust, 9 proxied, the rest on Next.
  - **2026-11-04:** 149 served by Rust, 0 proxied, 34 Next-only. Nothing under `/api/sessions` reaches Next. The live count is in [ROUTES.md](ROUTES.md).
- **Server logic:** `lib/server` is 32.7k lines, 9.5k of it `session.ts`.
- **UI:** about 100k lines in total.
  - `components`: 45k lines, 159 files
  - `app` pages: 23k
  - `lib/client`: 22k, including `use-session.ts` at 7.1k
  - `lib/shared`: 11k
- **Electron shell:** 5k lines.

---

## How to work this file (loop protocol)

**Status markers**
- `[ ]` todo
- `[~]` in progress
- `[x]` done
- `[!]` blocked (reason inline)
- `[?]` needs a user decision
- `[-]` won't do (reason inline)

1. **Pick** the first `[ ]` task in file order whose `deps:` are all `[x]`. Sections are ordered by dependency and value. Skip `[!]` and `[-]`. **When you reach a `[?]`, stop and ask the user.** Don't decide it yourself.
2. **Size check.** If a task is clearly more than one sitting, split it in place into lettered subtasks (`S07` → `S07a`, `S07b`, …) with the same deps. Then do the first one.
3. **Mark `[~]`**, then read the TS sources named in the task. Line numbers drift; method and file names are the stable reference. Port with the parity rules in PORT_PLAN.md:
   - same status codes, error strings and JSON shapes
   - `js_num` for numbers, UTF-16 lengths
   - no Rust-side schema
   - path containment at the sink
   - no user-input regex
4. **Test.** Every task adds or extends Rust tests:
   - unit tests
   - `crates/claudius-core/tests/session_fake.rs` (fake CLI)
   - `crates/claudius-server/tests/http.rs` or a new `tests/*.rs`

   Extend the fake CLI (`claudius-fake-claude`) when a feature needs new CLI messages or control requests. Then all of these must pass:
   ```sh
   cd rust && cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
   ```
   Once I03 exists, also run the related Playwright specs against Rust (`bun run test:e2e:rust -- <spec>`). Record the results in `rust/parity/e2e-status.md`.
5. **Mark `[x]`** and append `— done YYYY-MM-DD: <tests added / note>`. Update PORT_PLAN.md:
   - its *Status* route list
   - its *Known gaps*, removing what you closed
   - its 501 list, if you ported a route

   Run `rust/scripts/route-coverage.sh` once I01 exists. If the work revealed new required steps, add them as new `[ ]` tasks in the right section.
6. **Blocked?** On a verified dead end (not just hard), mark `[!]` with the evidence. Move on to the next task that doesn't depend on it, and report it. If the blocker stalls everything, stop the loop and ask the user.
7. **Never commit or push** unless the user asks. Never touch the user's unrelated working-tree changes (anything outside `rust/` that this file doesn't name).
8. **Parallel mode** (2026-10-26, at the user's request; up to 3 tasks a pass):
   - Run the step-1 task in the main tree. Also hand the next eligible tasks whose files don't overlap it (and each other) to background agents.
   - Each agent works in an APFS clone: `cp -c -R rust /tmp/claudius-par/<task>/rust`, plus a `lib` symlink to the repo's `lib/` (build.rs reads the migrations from there). Each clone has its own `target/`.
   - Agents don't edit TODO.md or PORT_PLAN.md; they return their notes. The main loop applies each clone's diff to the real tree (`diff -ruN` against the clone's base snapshot), re-runs the step-4 gate there, then writes the TODO and PORT_PLAN notes.
   - Iterate on scoped tests (`-p <crate> --test <file>`); run the full gate once per merge.
   - Mutation runs use clones too (a `par.py` per task under `/tmp/<task>mut/`), never the real tree.
9. **Live checks need the real CLI and login.** Use `rust/scripts/live-smoke.sh` (I05) at phase ends, not every task. It must clean up test sessions in `~/.claude/projects` afterwards.

---

## 0. Done (for reference)

- [x] **P0** Cargo workspace (`claudius-agent`, `claudius-core`, `claudius-server`); migrations embedded from `lib/server/db-migrations` via `build.rs`.
- [x] **P1** Agent SDK host:
  - spawn, stream-json, control protocol, `can_use_tool`, hooks, SDK MCP servers, elicitation, cancel
  - `Options::to_env` parity with SDK 0.3.299
  - fake CLI
- [x] **P2** Stores:
  - paths (two roots, UTF-16 project encoding), db, settings (atomic write), workspaces, trusted cwd
  - sessions_db (sessions/usage/goal/state/drafts/tagged messages), queue_db, sessions_store (list/info/find/rename), transcript replay
- [x] **P3** `Session` core:
  - start/resume, consume, replay buffer + subscribe order, `send_input` (reminders, ultrathink, images, slash, inline pastes)
  - queue, permission/ask/plan/elicitation, tool budgets, mode/model, goal + `claudius_goal` MCP, holder, usage folding, interrupt, `resync_from_disk`, advisor
- [x] **P4** `SessionManager`: resume dedupe, idle reaper, `get_or_resume`, last recorded permission mode.
- [x] **P5** axum front door: reverse proxy (incl. WebSocket), 501 guard, 25 `/api/sessions/:id/*` routes + `GET/POST /api/sessions` + `rename`.
- [x] **P6** Live verification with the real CLI and the unchanged React UI (prompt, reload replay, permission card).

---

## 1. Infrastructure (do first — everything after uses it)

- [x] **I01** Route coverage report. Add `rust/scripts/route-coverage.sh` (python3 is fine):
  - enumerate `app/api/**/route.ts` and their exported methods
  - parse the Rust routers (`.route("…", get(..).post(..))`) and the proxy/501 lists
  - write `rust/ROUTES.md`, one row per TS route: `rust` / `proxied` / `501` / `next-only`, with methods and a count summary
  - exit non-zero if a TS route has no classification

  Accept: script runs; ROUTES.md matches the 27 ported + 9 proxied today. — done 2026-10-25: `rust/scripts/route-coverage.sh` (+ `--check`, `ROUTE_COVERAGE_REPO` override) writes `rust/ROUTES.md` (rust 27 · proxied 9 · 501 21 · next-only 125). The "no classification" exit was replaced by stronger checks: `--check` fails on a stale ROUTES.md, on PARTIAL routes (a Rust route missing TS methods → axum 405 instead of falling through to Next) and on orphan Rust routes. Tests: `claudius-server/tests/route_coverage.rs` (`routes_md_is_current`, `classifier_handles_partial_orphan_catchall_and_501`).
- [x] **I02** CI job. Add a `rust` job to `.github/workflows/ci.yml` running `cargo fmt --check`, `cargo clippy -D warnings` and `cargo test --workspace` on macos-latest and ubuntu-latest.
  - Cache `~/.cargo` and `rust/target`.
  - `build.rs` needs `lib/server/db-migrations`, so check out the whole repo.

  Accept: YAML parses (`python3 -c 'import yaml…'`), and the job's commands pass locally. — done 2026-10-25: added `.github/workflows/rust.yml` instead of a job in `ci.yml`, so TS-only changes skip the Rust build. It has a `paths` filter on `rust/**`, `lib/server/db-migrations/**` (embedded by build.rs), `app/api/**` (checked by `route_coverage`) and itself, an ubuntu+macos matrix with `fail-fast: false`, `dtolnay/rust-toolchain@stable` (rustfmt, clippy) and `Swatinem/rust-cache@v2` (`rust -> target`). The YAML structure was checked with `Bun.YAML.parse`, and fmt/clippy/test (49) pass locally on macOS. Linux has not been run locally (no Docker here); the code is `cfg(unix)`-portable and SQLite is bundled, so the first CI run is the Linux confirmation.
- [x] **I03** Playwright parity config. Add `playwright.rust.config.ts` and a `test:e2e:rust` script in package.json.
  - `webServer` is an array:
    - Next on :3178 with `NEXT_DIST_DIR=.next-e2e`, `HOME=E2E_HOME`
    - `cargo run -p claudius-server -- --port 3179 --next http://127.0.0.1:3178`, with `HOME=E2E_HOME` and `CLAUDIUS_UPDATER_DISABLED=1`
  - `baseURL` is :3179; reuse `globalSetup`.

  deps: — · Accept: `tests/e2e/app-functionality.spec.ts` passes against Rust. — done 2026-10-25: `playwright.rust.config.ts` imports the base config (shared `CLAUDIUS_E2E_HOME`, globalSetup/teardown) and swaps in two web servers: Next on :3178 (`.next-e2e`, `CLAUDIUS_UPDATER_DISABLED=1`) and the prebuilt `rust/target/debug/claudius` on :3179 (health URL `/api/rust/health`, same HOME). `baseURL` is :3179, only the `chromium` project runs, and it is headless by default. `bun run test:e2e:rust [-- <spec>]` builds the binary first. Ports can be overridden with `CLAUDIUS_E2E_{RUST,NEXT}_PORT`, the binary with `CLAUDIUS_RS_BIN`. `app-functionality.spec.ts`: 5/5 pass against Rust. ESLint is clean on the config.
- [x] **I04** Baseline parity run. Run the full `chromium` e2e project against Rust and write `rust/parity/e2e-status.md`: pass/fail per spec, plus a failure category (`501:<route>` / `proxied-degraded` / `behavior` / `flaky`). Turn every `behavior` failure into a task here. Re-run at the end of each section.

  deps: I03 — done 2026-10-25: full chromium run against Rust: **362 passed, 12 failed, 7 skipped** (13.6 min). The TS backend passes all 22 tests in the 8 failing spec files, so all 12 are port gaps:
  - 9 × `501 /api/sessions/:id/dev-broadcast` and 2 × `501 /:id/dev-reap`. This is test plumbing, not product behavior, and S25 (moved up next to I10) closes it.
  - 1 × `behavior`: `cc-parity-2.1.284-rate-limit-options`. It is a client race that the faster backend exposes, now tracked as I11.

  `rust/scripts/parity-report.py` reads the Playwright JSON (plus an optional `--baseline` TS JSON). It categorizes each failure from the trace's network log and writes `parity/e2e-status.md`, `parity/e2e-status.json` and `parity/failing-specs.txt`. A later Playwright run wipes `test-results/`, so the report falls back to the cached per-test `/api` errors in `e2e-status.json`, and the TS baseline should run with `--output /tmp/...`. The recipe is in PORT_PLAN (*Parity e2e*).
- [x] **I05** Live smoke script. Promote the throwaway scripts into the repo:
  - `rust/scripts/live-smoke.sh`, plus `rust/scripts/live/{pong,permission}.mjs`
  - temp workspace + `CLAUDIUS_STATE_HOME`
  - the env-unset list (`CLAUDE_CONFIG_DIR`, account and nested-session vars, packaged `__NEXT_PRIVATE_*`, `NODE_ENV`, `CLAUDIUS_PACKAGED`)
  - `CLAUDIUS_UPDATER_DISABLED=1`, `NEXT_DIST_DIR=.next-e2e`
  - cleanup of `~/.claude/projects/<encoded tmp proj>`

  Accept: runs green (needs login; skip in CI). — done 2026-10-25: `rust/scripts/live-smoke.sh [--api-only] [--keep]` + `live/{api,pong,permission,ui-common}.mjs`. API mode: create → SSE → PONG → permission round trip with a proof file. UI mode: the same through the React UI, failing on any `/api` response ≥ 500. Both pass against the real CLI (haiku), with zero leftovers. The work also surfaced and fixed real shutdown bugs:
  - **SIGTERM** killed `claudius` without ending sessions, which orphaned the CLIs. Their late JSONL writes even re-created deleted session dirs.
  - **Graceful shutdown hung forever** on open SSE streams.

  Fixes:
  - `main.rs` handles SIGINT and SIGTERM: it ends all sessions concurrently, then stops HTTP with a 3 s cap.
  - `Session::end()` now awaits the CLI's exit (bounded).
  - Script lesson: start servers as a direct `env … cmd &`, never a backgrounded shell function, so `$!` is the real pid.

  Tests: `claudius-server/tests/shutdown.rs` (real binary + fake CLI + open SSE stream → exit 0, CLI reaped, < 10 s), and `session_fake::end_drains_pending_prompts` now asserts the CLI pid is gone. The fake CLI gained `$FAKE_CLAUDE_PID`.
- [x] **I06** Scriptable fake CLI. Add `FAKE_CLAUDE_SCRIPT=<json>` (or a `script:` prompt) to `claudius-fake-claude`:
  - emit arbitrary message sequences per turn: `system/*`, `stream_event`, task lifecycle, `compact_boundary`, tool uses and results
  - canned responses for control requests: `get_settings`, `background_tasks`, `seed_read_state`, `mcp_set_servers`, `reload_plugins`, `update_settings`, `submit_feedback`, `get_usage`, `supported_agents`, …
  - record all received control requests to a file

  Accept: `crates/claudius-agent/tests/fake_cli.rs` covers it. — done 2026-10-25: both forms exist. `$FAKE_CLAUDE_SCRIPT` takes inline JSON or a file path and supports `turns[]` with `match` / `repeat` / `steps` / `result`, plus `init` / `initialize` overrides, `on_init`, and per-subtype `control` overrides (`$error`, or `$response` + `$emit` + `$delay_ms`). An inline `script:<json>` prompt works too. Steps are messages or `$text` / `$control` / `$delay_ms` / `$stderr` / `$exit`, with placeholders `$SESSION_ID` `$MODEL` `$PROMPT` `$UUID` `$N` `$LAST[:/ptr]`. Without a script, control requests still get stateful canned responses:
  - `get_settings` reflects `apply_flag_settings` and `set_model`
  - `mcp_set_servers` returns added/removed diffs
  - `reload_plugins`, `background_tasks`, `get_usage` and `rewind_files` return their typed shapes (taken from SDK `sdk.d.ts`)
  - `supported_agents` reads from the initialize response
  - everything else is acked

  `$FAKE_CLAUDE_CONTROL_LOG` records host→CLI control requests and cancels. A bad script exits 2 with a stderr reason. All prompt-driven behaviours are unchanged. Tests: 6 new in `fake_cli.rs` (sequences + placeholders + consumption/fallback, inline `script:`, canned responses + control log, overrides/errors/emit-after-interrupt with an open turn, file script + init overrides + `on_init` + a `$control` permission round trip, bad script). `session_fake::scripted_turn_through_send_input_and_scripted_interrupt` proves the same through `Session` (`send_input` → `script:`, scripted interrupt settles the turn). Workspace: 57 tests.
- [x] **I07** Golden wire fixtures from the real TS SDK.
  - Add a bun script that runs `@anthropic-ai/claude-agent-sdk` `query()` against the fake CLI with representative Options. Record argv, env (filtered) and every stdin line into `rust/crates/claudius-agent/tests/fixtures/*.json`.
  - Add a Rust test that builds the same Options and diffs argv, env and the `initialize` body.

  Accept: diff is empty, or every difference is an explicit allowlisted gap tied to a TODO id. — done 2026-10-25.
  - **Recorder.** `rust/scripts/golden-wire.mjs` (bun; ESLint clean) runs SDK 0.3.299 `query()` against `claudius-fake-claude`. The fake gained `$FAKE_CLAUDE_ENV`. Each run writes `tests/fixtures/golden/{minimal,claudius_session,resume_and_limits,sandbox_bypass}.json` with the case `spec`, a fixed `baseEnv` (including `NODE_OPTIONS`/`DEBUG`/question vars that the SDK must strip or keep), and the argv, env, `initialize` body and every stdin line, with request ids normalized. Re-recording is deterministic.
  - **Cases.** `claudius_session` mirrors `Session.start()`: hooks across 4 events, two SDK MCP servers (the goal server with its real tool and `timeout`), two external servers, `canUseTool`, `onElicitation`, toolConfig. The other cases cover resume/fork/limits/skills/extraArgs/custom prompt and sandbox/bypass/continue/managed settings/json schema/plugins.
  - **Test.** `tests/golden_wire.rs` maps each spec to Rust `Options` and panics on an unmapped key. It runs the real Rust `Query` against the same fake with the same env and diffs every leaf. Each allowlisted difference must name a TODO id, and a stale allowlist entry fails.
  - **Real bugs it found and I fixed:**
    - `hook_<n>` callback ids were assigned alphabetically by event. `Options.hooks` is now an `IndexMap`, so TS insertion order is kept, and `Session::build_hooks` already inserts in TS order.
    - `extraArgs` and `mcpServers` were emitted sorted; both are now `IndexMap`.
    - `resume_drops_turn` was a `bool`; SDK 0.3.299 types it as a string.
  - **Remaining, allowlisted:** none. A02 closed `sdkMcpServerConfigs` and `sdkMcpServerManifests`, and A03 closed the `CZ` sandbox merge.
- [x] **I08** Request-body semantics helper. Ported routes mix `await req.json()` (throws, so Next returns 500) with `.catch(() => ({}))`. Add `JsonBody::{strict, lenient}` extractors that replicate both. Document which to use in PORT_PLAN, and switch existing handlers to them. Accept: unit tests for empty, malformed and non-object bodies. — done 2026-10-25.
  - **Module.** `claudius-server/src/body.rs`:
    - `JsonBody::parse` follows `Body.json()`: BOM stripped, lossy UTF-8, any JSON value.
    - `strict` → `Rejection::Thrown`, i.e. Next's `new Response(null, {status: 500})`: empty body, no content type (confirmed in `next/dist/build/templates/app-route.js`).
    - `lenient(fallback)` keeps a valid `null`. `or_bad_request(msg)` gives `400 {error}`.
    - `js_member` models `body.x` without `?.` (throws on `null`, `undefined` on non-objects). `tri!` returns the rejection as a response.
  - **Helpers, not extractors**, on purpose: TS evaluates `req.json()` after its 404 check, and an axum extractor would reject first.
  - **Every ported body route is now switched and audited against its TS line.** Real fixes:
    - `rename`, `permission` and `model` were lenient (400) but TS is strict (500).
    - `input` and `advisor` returned a JSON 500; Next's is empty.
    - `create`, `prompt-draft` PUT and `prompt-color` POST now throw on a literal `null` body like TS (`body.resume` / `body.text` / `body.color`). `prompt-color` keeps TS's order: parse → 404 → member access.
  - Known edge, documented: lone-surrogate escapes, which `JSON.parse` accepts and serde rejects.
  - **Tests:** 5 unit tests in `body.rs` (empty/malformed/non-object/BOM/invalid UTF-8/duplicate keys; strict/lenient/400/member access) and `tests/body_semantics.rs` (over HTTP: each route class with empty, malformed, `null`, array and string bodies; 404-before-parse; exact TS error strings). Workspace: 64 tests.
  - The rule is documented in PORT_PLAN *Parity rules*.
- [x] **I09** Debug-log parity. Map the TS `console.log("[sess-load] …")`, `[session.*]` and `[api/*]` diagnostics to `tracing` targets, and document `RUST_LOG` recipes in PORT_PLAN. Low priority.
  - *Done 2026-10-26.*
  - **Targets** (`claudius_core::log`): `claudius::sess_load` (TS `sessLoadDebug()`), `claudius::session` (`[session*]`), `claudius::api` (`[api/*]`, `[input]`). The message text keeps the TS bracket prefix and the structured fields keep the TS names (`bufferLen`, `resumeFrom`, `priorSubscribers`, …), so grepping a log works the same on both backends.
  - **Filter** (`claudius_server::logging`): `RUST_LOG` if set and valid, else `claudius=info` (an invalid `RUST_LOG` falls back instead of crashing). `CLAUDIUS_DEBUG_SESSIONS` set to any non-empty value (TS `!!process.env…`) appends `claudius::sess_load=debug`, so the TS switch works without knowing `RUST_LOG`. ANSI colours only when stdout is a terminal, so Electron / redirected logs stay plain.
  - **Sites ported:** `[sess-load]` start.resume / start.complete / subscribe / resyncFromDisk (empty, done, FAILED) / getOrResumeSession (in-memory hit, no fileInfo, resuming, FAILED). Plus `[session] … failed to load transcript history`, `[session.setModel]` / `[session.advisor-compat]` advisor write failures, `[input] recordSuggestedMessage` / `recordGoalMessage`, and the `[api/sessions/model|commands] GET failed` lines.
  - **Behaviour fixes found on the way:**
    - A transcript that exists but can't be read now logs the warning *and* broadcasts `{type:"error", message:"Failed to load session history: …"}` like TS. Before, it was swallowed. A missing file stays silent.
    - `clear_user_advisor_model` returns its write error, so the two callers log under their own TS tags.
    - `input`'s `suggested` / `goal` flags use JS truthiness (`js_truthy`), so `"1"` or `1` counts and `0` / `""` don't.
  - **Tests:**
    - `log::debug_sessions_enabled` and `logging::filter_directives` unit tests.
    - `tests/debug_logs.rs` runs the real binary: `CLAUDIUS_DEBUG_SESSIONS=1` prints start.complete / in-memory hit / subscribe with TS field names and no ANSI. They're off by default and with plain `RUST_LOG=claudius=info`, and `RUST_LOG=…,claudius::sess_load=debug` alone turns them on.
    - The binary-driving helpers moved to `tests/common/mod.rs`, shared with `shutdown.rs`.
    - Workspace: 69 tests.
  - Recipes are in PORT_PLAN *Logging*.
  - **Tree hygiene, found during this pass:** the I04 parity runs had overwritten 146 tracked screenshots under `docs/` and `site/screenshots/` and added 6 new ones; specs write them unconditionally. All were confirmed as run artifacts against the pre-run `git status` and restored. New `rust/scripts/keep-tree.sh <cmd>` restores whatever a run dirtied there and leaves already-dirty paths alone. `test:e2e:rust` uses it, and the PORT_PLAN recipe wraps the TS baseline too.
- [x] **I10** Dev-route gate. Add a shared guard so `dev-*` routes answer the same as TS when not in dev (TS checks `NODE_ENV === "production"`). Rust: allowed in debug builds or with `CLAUDIUS_DEV=1`.
  - *Done 2026-10-26.*
  - **Decision:** made once at startup (`claudius_server::dev::dev_routes_from_env`) and stored in `AppState::dev_routes`, in priority order:
    1. `CLAUDIUS_DEV`: `0` / `false` → off, any other non-empty value → on.
    2. `NODE_ENV=production` → off, the exact TS condition. The packaged desktop app runs with it.
    3. Otherwise the build type: debug on, release off.
    When the routes are on, a startup line says so.
  - **Guard:** `tri!(dev_only(app.dev_routes, DevRefusal::…))` as each handler's first line, before params, the session or the body, like TS. The refusal is copied per route: `dev-broadcast` / `dev-reap` / `notifications/dev-emit` → 404 `{error:"dev-only endpoint"}`, `dev-inject-denial` → 403 `{error:"dev only"}`.
  - **Routes:** the three session `dev-*` routes are now registered behind the guard, POST-only like TS. Until S25 their enabled branch answers the not-ported 501. `notifications/dev-emit` stays on Next, which gates it itself.
  - `playwright.rust.config.ts` passes `CLAUDIUS_DEV=1` to the Rust server, so a release `CLAUDIUS_RS_BIN` or an inherited `NODE_ENV=production` can't silently break the suite. ESLint is clean.
  - **Tests:**
    - `dev.rs` units: the enable matrix and both refusal shapes.
    - `tests/dev_routes.rs` runs the real binary four ways:
      - debug default: enabled, plus 405 on GET and the startup line
      - `NODE_ENV=production`: each refusal for empty, malformed and valid bodies on an unknown id; health is not gated
      - `CLAUDIUS_DEV=0`: refused
      - `CLAUDIUS_DEV=1` with `NODE_ENV=production`: enabled
    - `tests/common` strips `NODE_ENV` / `CLAUDIUS_DEV` so runs are deterministic.
    - Workspace: 72 tests; `route-coverage.sh --check` is clean (rust 30).
- [x] **S25** Dev routes: `POST /:id/dev-broadcast`, `/:id/dev-inject-denial` (`injectDenialForTesting`), `/:id/dev-reap`. *(Moved up from §3 by I04: these 501s are 11 of the 12 parity failures.)* Accept: the I04 spec list minus rate-limit-options passes on Rust (`chat-scroll-pin`, `goal`, `goal-showcase`, `markdown-tmp-image`, `notifications`, `session-tab-switch`, `transcript-find`). deps: I10
  - *Heads-up from I10:* the handlers are already registered and gated in `sessions.rs` (`dev_broadcast` / `dev_reap` / `dev_inject_denial`), so only their bodies are left. `Session::broadcast` is already `pub`, and the denial ring (`recent_denials`, cap 20) exists. TS `dev-broadcast` also feeds `notificationBus.recordSessionEvent` through `Session.broadcast`. Rust has no bus yet (G01 / S31). Check whether the `notifications` spec needs it. If it does, keep that spec out of S25's accept list and hang it on S31.
  - *Done 2026-10-26.* Ports of the three `app/api/sessions/[id]/dev-*/route.ts` handlers, behind the I10 gate, with TS's validation order and body semantics:
    - **`dev-broadcast`:** lenient body → `body.event` (a `null` body throws → bare 500) → a falsy event gets 400 `event required` → 404 `session not bound` → `Session::broadcast(event)`, the same stamp/buffer/snapshot/fan-out funnel as live events → `{ok, sessionCwd, sessionId}`.
    - **`dev-reap`:** `mgr.remove` (the reaper path: end the CLI, drop from the map) → `{ok, reaped}`.
    - **`dev-inject-denial`:** 404 `session not found` first, then lenient body; non-string fields fall back to `Bash` / `auto_deny` → new `Session::inject_denial_for_testing`, which shares a `push_denial` ring helper (`RECENT_DENIALS_CAP` = 20) with the live `permission_denied` path.
  - **Tests:** `tests/dev_routes.rs` now covers enabled routes on an unknown id (each validation branch) plus a live fake-CLI session:
    - the broadcast event is replayed on a new SSE subscriber and the cwd/id echo is checked
    - denial defaults and fallbacks, a `null` → 500, `/denials` contents and `at` stamps, the 20-entry cap keeping the newest
    - reap → `reaped:true`, the session is gone, a second reap → `reaped:false`
    Workspace: 73 tests; coverage check clean.
  - **E2E on Rust (keep-tree wrapped):** `chat-scroll-pin`, `goal`, `goal-showcase`, `markdown-tmp-image`, `session-tab-switch`, `transcript-find` all pass, 20 of 21 tests. **`notifications` › "Session.broadcast still calls the bus" moved to S31:** it asserts the broadcast lands in `/api/notifications`, which needs the Rust notification bus (G01) and S31's emit from `Session::broadcast`. The route itself answers correctly.
- [x] **I11** Session-URL writer race: a client bug that the fast Rust backend exposes (found by I04).
  - **Cause.** `lib/client/use-session.ts`'s `?session=` writer calls `history.replaceState` 500 ms after a session binds, unless an anchor click or a Navigation API `navigate` event happened first. A programmatic `router.push`, as in the native slash commands in `components/chat/ChatSurface.tsx` `runNative` (`/rate-limit-options` → `/usage`, `/usage`, `/login`, …), only touches history when the RSC payload commits. A push issued inside that window is superseded by the `replaceState`, so the URL stays on the chat.
  - **Why only Rust.** On TS (dev) the bind-time fetches (`advisor`, `stream`, `commands`) take 0.8–1.2 s, so the composer is ready long after the writer has fired. On Rust they answer in milliseconds, and the user acts about 200 ms after the bind.
  - **Evidence.** `cc-parity-2.1.284-rate-limit-options` fails 2/2 on Rust and passes on TS. Rust trace: bind ≈09.85 → send click 10.05 → `GET /usage?_rsc` 10.09 (200, `text/x-component`; the proxy streams fine) → `?session=` written ≈10.38 → URL never reaches `/usage`. TS trace: bind 33.07, click 34.19.
  - **Fix (client, shared by both backends).** Give the writer a navigation-intent signal that programmatic pushes set, e.g. a small `lib/client/nav-intent.ts` (`markNavigating()` / `navigatedSince(t)`) called by `runNative` before `router.push`, or cancel the pending write when the composer dispatches a navigating command. Don't weaken the refresh-resume contract (`session-resume*` specs).
  - **Accept.** The spec passes on Rust with `--repeat-each=5` and still passes on TS. The `session-resume*` and `?session=` watcher specs stay green, and `bun run lint` is clean on the touched files.
  - *Done 2026-10-26.* Client fix, shared by both backends:
    - **`lib/client/nav-intent.ts`:** `markNavigating()`, a monotonic `navIntentSeq()` (a counter, so same-millisecond events can't tie), `withNavIntent(router)` and the drop-in `useNavIntentRouter()`, whose `push` / `replace` bump the counter *before* navigating.
    - **`ChatSurface`** swaps `useRouter()` for `useNavIntentRouter()`, which covers every push in the component: all native slash commands, `/resume`, the session links. No call sites changed.
    - **The `?session=` writer in `use-session.ts`** captures the sequence when it arms its 500 ms timer and skips the `replaceState` if it moved, the same semantics as the anchor-click guard. A push that doesn't change the pathname always carries its own `?session=`, so the refresh-resume contract is untouched.
  - **Why the old guards missed it:** Next only `pushState`s when the RSC payload commits, so neither the Navigation API `navigate` event nor the capture-phase click listener fires inside the window. Next then syncs the writer's native `replaceState` into its router, dropping the pending push.
  - **Tests:**
    - `tests/unit/nav-intent.test.ts` (vitest, 3): the sequence bumps, the intent is recorded before `push` / `replace` with args passed through, and other router methods are untouched.
    - E2E, keep-tree wrapped:
      - `cc-parity-2.1.284-rate-limit-options` passes 5/5 on Rust (`--repeat-each=5`; it failed 2/2 before) and 3/3 on TS.
      - `session-resume` passes 3/3 on TS. On Rust, `session-resume`, `session-management`, `app-functionality`, `cleared-from-banner`, `readable-session-names`, `community-nav` and `customizations-drawer` all pass, 22/22.
    - `tsc --noEmit` and ESLint are clean on the touched files. The cargo suite is unchanged (73).
  - **Not covered (follow-up if it bites):** programmatic pushes from *other* components (rail buttons, the command palette) still use plain `useRouter()`. Adopting `useNavIntentRouter` there is a one-line change per component.
- [x] **I12** End-of-§1 parity re-run, per I04's "re-run at the end of each section". Run the full `chromium` suite on Rust (`bun run test:e2e:rust`, keep-tree wrapped). Run the TS baseline over the failing files (recipe in PORT_PLAN *Testing*), then regenerate `rust/parity/e2e-status.{md,json}` and `failing-specs.txt`. Expected: 1 failure (`notifications` bus → S31). Turn any new `behavior` failure into a task. deps: S25, I11
  - *Done 2026-10-26.* `rust/parity/e2e-status.{md,json}` and `failing-specs.txt` are regenerated: **373 passed, 1 failed, 7 skipped** (190 spec files, 14.2 min).
    - The one failure is `notifications` › "Session.broadcast still calls the bus" (`behavior`). The TS baseline passes it 3/3. It is already S31's acceptance test, so no new task.
    - Since the 2026-10-25 baseline: 11 dev-route failures were fixed by S25, and the rate-limit-options race by I11.
  - **Found and fixed on the way: e2e env leak.**
    - The first full run had a second failure, `workspace-move-sessions`, failing 3/3 on Rust *and* on TS.
    - Cause: this session's e2e commands didn't unset the parent desktop session's `CLAUDE_CONFIG_DIR`. The loop prompt's `env -u` list omits it; the 2026-10-25 runs had unset it. So the e2e servers' SDK listing and `claude` CLIs used the user's real `~/.claude`.
    - Effects: the spec's fixture (written under the e2e HOME) was invisible, and the CLIs wrote 6 synthetic transcripts into the real `~/.claude/projects/-Users-filipegarcia-Projects-claudius/`, plus 2 empty `memory/` dirs under tmp-root project dirs. All were "Not logged in" with 0 output tokens, so no API usage. A read-only check found no rows for them in the real `.claudius.db`.
    - Left for the user: only `*claudius-live-*` dirs may be deleted there.
  - **Fix:**
    - New `rust/scripts/clean-env.sh` strips `CLAUDE_*`, `CLAUDECODE`, `__NEXT_PRIVATE_*`, `NODE_ENV`, `CLAUDIUS_PACKAGED` and `CLAUDIUS_ELECTRON`, and forces `CLAUDIUS_UPDATER_DISABLED=1`. `test:e2e:rust` = keep-tree → clean-env → playwright.
    - `playwright.rust.config.ts` pins `CLAUDE_CONFIG_DIR` to the e2e HOME on both servers.
    - The PORT_PLAN recipe and auto-memory are updated.
    - Re-verified: the move spec passes on both backends, and the clean full run wrote nothing to the real projects dir.


- [x] **I13** Test harness leak (found by S15b): `claudius-server/tests/common::Server` has no `Drop`, so every server test leaves its `claudius` binaries and their fake CLIs running (about 8 per `mcp_dynamic` run; 573 were found and killed in one clone). Give `Server` a `Drop` that kills and reaps the child (and its process group, so the fake CLIs go too), and check no test relies on a server outliving its handle. Accept: `pgrep -f 'target/debug/claudius'` is empty after `cargo test -p claudius-server`, apart from processes that predate it (never the user's app).
  — done 2026-10-27: `common::Server` now has a `Drop`: if the child is still running, SIGTERM (so it ends its sessions and their CLIs), poll up to 3 s, then SIGKILL and reap. `stop()` still works (its exited child is skipped). No test relied on a server outliving its handle; `mcp_dynamic`'s own `Server { child, port }` gets the same drop. The fake CLIs exit on stdin EOF once their server is gone, so no process group was needed. Verified: after a full `cargo test --workspace` in the main tree, 0 orphaned `claudius --no-next` servers and 0 fake CLIs from it (each clone without the fix left about 200 meanwhile).
- [ ] **I14** Consolidate the Node/JS emulation helpers (found while merging the 2026-10-27 parallel batch). Each port grew its own:
  - `claudius_agent::js` (A14: `stringify`, `json_parse`, `json_parse_error`, `trim`, …);
  - `claudius_core::node_fs` (G02a: `path.posix.join`/`normalize`, recursive `mkdir`, Node fs error text);
  - `claudius_core::node_err` (D10a: `uvException` text, `fs::{read_file, write_file, lstat, chmod, rename, mkdir_recursive}`, the uv errno table);
  - `claudius_core::agents` (G05: its own path helpers and Node's recursive-mkdir walk with error text);
  - `claudius_core::node_path` (D04: `path.posix` `resolve`/`normalize`/`join`/`relative`/`dirname`/`isAbsolute`; D01's resolve/isAbsolute folded in);
  - `claudius_core::js_string` (D01: lone surrogates as stand-in chars, UTF-16 lengths, `String(v)`, `ToNumber`, spread, URI coding).
  - `claudius_core::active_cwd` and `claudius_server::open_tabs`'s cookie parser (D21: self-contained copies of D01's raw workspaces.json / customizations reads and its cookie parsing; switching them to D01's fixes D21's lone-surrogate difference);
  - `claudius_core::jsonl_lines` (G11: `jsonlLines` as a stream) vs the inline whole-file `split('\n')` readers in `sdk_cost_state`, `transcript`, `usage_seed`, `asset_ingest` and `sessions_store`;
  Pick one home per concern (path, fs + errors, JS strings/JSON), move callers onto it, and delete the duplicates. Every existing golden must stay green: they pin the behaviour, so a merged helper that changes any byte is a bug. deps: D01, D10a merged
- [ ] **I18** A par clone reuses the main tree's warm `target/`, so a test binary that wasn't rebuilt keeps the MAIN tree's `CARGO_MANIFEST_DIR` and reads **main's** fixtures. `claudius-agent --test sdk_snapshot` tripped over another agent's in-flight fixtures that way (found in D18a). Make that test resolve its fixtures from a path the clone owns, or have `clone.sh` drop the affected fingerprints so it rebuilds.
- [ ] **I17** `claudius-fake-claude` never replies to a `control_request` line that holds a lone-surrogate escape (serde_json refuses it), which wedges the host. The real SDK does emit such lines, so a test can't cover that path today (found in G10's feedback port). Decode those lines the way the SDK's JSON reader does, as `js::json_parse` already does for request bodies.
- [ ] **I15** SQLite text binds: better-sqlite3 binds a JS string's lone surrogate as its own 3-byte sequence (`\ud800` → `ED A0 80`, read back as three U+FFFD), but Rust binds `js_string::lossy` (U+FFFD) everywhere except G09's `JsText` (`workspace_relocate.rs`). So a `cwd` (or title, label, …) with a lone surrogate that Rust writes or queries doesn't match the bytes TS writes. Move `JsText` next to `js_string`, bind every JS-string column through it (sessions, notifications, open tabs, splash, assets, …), and add one golden that writes and queries such strings from both sides. Found by G09 (2026-10-28). deps: none

## 2. Agent SDK host (`claudius-agent`)

- [x] **I16** Proxy fallback without a Next upstream answered its 404 without reading the request body. A connection closed with unread bytes is reset (RST), so a client could lose the 404 to ECONNRESET: `schedule_routes` › `without_next_or_the_scheduler_nobody_does` failed this way in gate b8, and `plugins` › `a_session_without_a_query_replays_the_ts` once in b7.
  — done 2026-10-29 (merge loop): `proxy::handler`'s no-upstream branch drains up to 1 MiB of the body before answering. No parity impact (Rust-only mode). `schedule_routes`, `plugins`, `accounts_routes` and `rewind_golden` each passed 3/3 afterwards under load ~48.
- [x] **A01** Missing `Query` methods used by `lib/server`:
  - `seed_read_state(path, mtime)`
  - `update_settings`
  - `get_settings`
  - `submit_feedback`
  - `set_mcp_servers` (`mcp_set_servers`)
  - `reload_plugins`
  - `background_tasks`
  - `get_usage`

  Copy the request shapes from `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`. deps: I06 · Accept: a fake-CLI round trip per method.
  - *Done 2026-10-26.* On `QueryHandle`, each copying its `sdk.mjs` 0.3.299 body:
    - `seed_read_state(path, mtime)`
    - `update_settings(source, settings)`
    - `get_settings()`
    - `submit_feedback(description, &FeedbackOptions)`: unset fields are omitted like `undefined`; the `type` field is `kind`.
    - `set_mcp_servers(IndexMap<_, McpServerConfig>)`
    - `reload_plugins(hold_on_cache_impact)`: the flag is sent only when true, like the SDK's `…x && {…}`.
    - `background_tasks(Option<tool_use_id>) -> bool`: `backgrounded ?? true`.
    - `get_usage(skip_behaviors)`, the SDK's `usage_EXPERIMENTAL_…`.
    - Plus `sdk_mcp_server_names()`.
  - **`set_mcp_servers` ports the SDK reconcile:** the in-process server map is now mutable. Servers missing from the new set are disconnected, including spawn-time ones such as `claudius_goal`, exactly like TS. New ones are connected; an already-connected name keeps its instance. The request lists external configs first, then `{type:"sdk", name, ...settings}` (settings added by A02).
  - `FeedbackOptions` is exported. The fake CLI's `$text` now writes non-string values as JSON, so a `$LAST:/ptr` that resolved to null can be asserted.
  - **Tests** (`fake_cli.rs`, +2):
    - `typed_query_methods_send_sdk_request_shapes`: the exact logged body of every method, including omitted fields and key order, plus reply unwrapping.
    - `set_mcp_servers_reconciles_in_process_servers`: the spawn-time server answers before and is gone after; the new server is routable; the same name keeps its first instance; external entries come before sdk ones.
    - Workspace: 75 tests.
  - No core caller yet: `lib/server`'s users are S-tasks (output style, effort, feedback, mcp-dynamic, plugins, background-task, read-state seeding, usage).

- [x] **A02** `initialize` parity: send `sdkMcpServerConfigs` + `sdkMcpServerManifests` exactly like SDK 0.3.299, and review every other initialize field. deps: I07 · Accept: golden fixture diff is clean for initialize.
  - Found by I07 (see `claudius_session.json`). `sdkMcpServerConfigs` = `{name: settings}` for servers with non-empty settings (the goal server's `timeout: 10000`). `ToolServer` needs a `settings`/`timeout` field, and `Session`'s goal server must set it.
  - `sdkMcpServerManifests` = the result of `captureSdkMcpServerManifests()`. Before initialize, the SDK handshakes each in-process server (`initialize` → `notifications/initialized` → `tools/list` if it has a tools capability) and sends `{initializeResult, toolsListResult}`. Servers without tools get no entry (`aux_tools`). The manifest JSON must match byte-for-byte: protocol `2025-11-25`, `capabilities.tools.listChanged`, the zod-generated `inputSchema` with `$schema` draft-07, and `execution.taskSupport: "forbidden"`. It is skipped when `CLAUDE_AGENT_SDK_DISABLE_MCP_MANIFESTS` is set.
  - Done when the four `A02` entries in `tests/golden_wire.rs` `ALLOWED` are removed. — done 2026-10-26.
  - **Settings.** `SdkServerSettings {timeout, disable_auto_background}` (exported) mirrors the SDK's `Tw()`: a timeout is sent only when positive, `disableAutoBackground` only when `true`, in that key order. `SdkMcpServer::settings()` defaults to empty. `ToolServer::with_timeout` / `with_disable_auto_background` set them, and `Session`'s goal server now sets `timeout: 10_000` like TS. Settings go out in `initialize.sdkMcpServerConfigs` (non-empty only) and in each `{type:"sdk", name, ...settings}` entry of `set_mcp_servers`, which closes the I07/A01 settings gap.
  - **Manifests.** `mcp::capture_manifests` ports `captureSdkMcpServerManifests()`. It sends `initialize` (id `sdk-manifest-capture:initialize`, protocol `2025-11-25`, the SDK's `clientInfo` plus version), then `notifications/initialized`, then `tools/list` only when `capabilities.tools` is present. All servers run concurrently under the SDK's 250 ms deadline. A server that errors, misses the deadline or pages its list (`nextCursor`) gets no entry or no `toolsListResult`, and an empty result omits the field. It's skipped when the **parent** env has a truthy `CLAUDE_AGENT_SDK_DISABLE_MCP_MANIFESTS` (`Re()`: 1/true/yes/on), like the SDK's `lf()`.
    - Not ported: dropping a `toolsListResult` when the server emits `tools/list_changed` mid-capture. `SdkMcpServer` has no server-initiated messages.
  - **`ToolServer` now answers byte-for-byte like the MCP SDK's `McpServer`:**
    - results are keyed `{result, jsonrpc, id}`, errors `{jsonrpc, id, error}`
    - unknown methods get -32601 "Method not found"
    - tools/list entries carry `execution: {taskSupport: "forbidden"}`
    - tools keep insertion order
    - Found while matching the fixture: with `tools: []` the SDK server still advertises `capabilities.tools: {}`, but `tools/list` answers "Method not found" because no handler is registered. That is why `aux_tools` has no manifest; it's deterministic across 3 re-records. Rust reproduces it.
  - **Goal schema.** It is now exactly zod's output (`$schema` first, no `additionalProperties`), since it travels byte-for-byte in the manifest. The golden mapper builds the same schema and applies `timeout`.
  - **Review of the remaining initialize fields.** Every field the 4 golden cases exercise matches. Seven SDK 0.3.299 fields aren't modelled because Claudius never sets them (verified by grep over `lib/`, `app/` and `components/`):
    - `toolAliases`
    - `webSearchIsolationExemptMcpServers`
    - `supportedDialogKinds`
    - `rapidFollowupPreempt`
    - `forwardNestedSubagentToolCalls`
    - `workspaceTrust`
    - `plugins` with `pluginDelivery: "initialize"`
    - They are listed on `Options::initialize_extra`, the escape hatch.
  - **Live check against the real CLI** (temp `CLAUDE_CONFIG_DIR`, no prompt). Both servers connect. With manifests on, the CLI sends the goal server no `mcp_message` at all; it uses the manifest. With `CLAUDE_AGENT_SDK_DISABLE_MCP_MANIFESTS=1` it handshakes itself (ids 0, 1).
  - **Tests:**
    - mcp.rs unit tests: settings JSON, `McpServer` wire shape, empty-tools "Method not found", capture (order, slow / erroring / empty / no-tools / paged servers, exact handshake), the empty-capture `None`, env truthiness
    - fake CLI `initialize_carries_sdk_server_configs_and_manifests`: key order after `sdkMcpServers`, a hand-written `SdkMcpServer` overriding `settings()`, and settings in `set_mcp_servers` entries
    - `tests/manifest_capture_env.rs`, a separate binary because it sets process env: the disable flag, mutation-checked
    - Golden: the 4 A02 allowlist entries are removed and the fixture is unchanged.
    - Workspace: 83 tests.
- [x] **A03** Sandbox settings merge (the SDK's `CZ` merge) at full parity, replacing today's simplification. deps: I07 · Accept: the `sandbox_bypass` golden case is clean (TS adds `failIfUnavailable: true` when `enabled`; also port the filesystem/network/credentials pruning in `CZ`), so remove the `A03` entry from `golden_wire.rs` `ALLOWED`.
  - Done 2026-10-26. The `golden_wire.rs` `ALLOWED` list is now **empty**.
  - **Port.** `claudius-agent/src/sandbox.rs` is `CZ()` + `bZ()` line for line:
    - a truthy-sandbox guard
    - the settings-path conflict error (JS `trim` plus a `{`…`}` check; the old Rust only checked the start)
    - unparseable settings treated as `{}`
    - deep merge with array unions at `filesystem.denyRead|denyWrite`, `network.deniedDomains` and `credentials.files|envVars`
    - wholesale replacement at `ripgrep` / `network.tlsTerminate`
    - skipped `__proto__` / `constructor` / `prototype` keys
    - `filesystem.disabled` dropped when the option configures the filesystem or denies credential files
    - inherited proxy ports dropped when the option restricts domains
    - `failIfUnavailable: true` when `enabled === true` and unset
  - **Wiring.** `Options::to_args` builds `{...extraArgs, settings?}` like the SDK's `vt`, so an extraArgs `settings` keeps its position and acts as the merge base when `settings` is unset or `""`. It then calls `sandbox::merge_into_args`. The old `merged_settings` is gone.
  - **Bugs this fixed beyond the allowlisted one:**
    - the old merge was shallow, with no unions, prunes or `failIfUnavailable`
    - `serde_json::Map::remove` (a swap-remove) moved `sandbox` to the end; JS keeps it in place
    - re-serialized settings kept serde's number text and key order
  - **New `claudius_agent::js` module.** It has `JSON.stringify`-exact `stringify`, built on `number_to_string` (ECMAScript `Number::toString`; checked against node). That covers `1.0`→`1`, `1e21`→`1e+21`, precision loss past 2^53, and array-index keys enumerating first. It also has `truthy`, `trim`, `entries`, `prop` (`?.`) and `dedupe` (`[...new Set()]`, SameValueZero). There's a parity-rule bullet in PORT_PLAN.
  - **Oracle.** `rust/scripts/sandbox-merge-golden.mjs` (node, ESLint clean) lifts `CZ`/`bZ`/`mVe`/`io`/`cn` out of the installed `sdk.mjs` and runs them on 45 edge cases. It writes `tests/fixtures/sandbox_merge.json`, and `tests/sandbox_merge.rs` replays the fixture byte for byte (flag order included). The cases include falsy and non-object options, path conflicts, unparseable / nbsp / whitespace settings, extraArgs position, unions, replace paths, every prune trigger, `__proto__`, number normalization, integer keys, duplicate keys, Claudius's own session sandbox, and the golden `sandbox_bypass` shape. Mutation-checked: disabling the proxy prune fails 5 cases, and skipping the integer-key sort fails 1.
  - Not ported: JS coercion of a nonsensical `deniedDomains.length` (PORT_PLAN gap).
  - Tests: `js` unit tests (numbers vs node, stringify, integer keys, helpers), the fixture replay, and an `options` wiring test (verbatim settings without a sandbox, normalization, extraArgs position, `""` settings, path conflict, falsy sandbox). Workspace: 88 tests.
- [x] **A04** `forkSession` port (copy the JSONL with a new id, rewrite `sessionId`, honour `upToMessageId`), in `sessions_store.rs`. Accept: unit test against a fixture transcript; output readable by `sessions_store::info`.
  - Done 2026-10-26. The real SDK function (`BU` → `tTe` + `WU` + `aTe`) is far more than the copy-and-rewrite the task described. It's ported in full.
  - **`crates/claudius-core/src/fork.rs`:**
    - `load` (`tTe`/`jU`): the message types; `history-suppression`; this session's `atis-latch` (printable ASCII only), `content-replacement` (concatenated) and `relocated` (last non-empty wins)
    - `build` (`WU`):
      - drop sidechain entries (JS truthiness)
      - `upToMessageId` is searched in the resolved chain plus everything after it, by `uuid` and then by queued-command `source_uuid` (`dA`); a miss gives "Message X not found in session Y"
      - a fresh uuid per entry; progress entries dropped and bridged to the nearest non-progress ancestor, with the SDK's progress-cycle behaviour
      - `logicalParentUuid` remapped (`null` kept, unknown → `null`)
      - `model_refusal_fallback` gets `neutralizedByFork`
      - `deferred_tools_record` announcements remapped (`cTe`), and `compactMetadata` preserved uuids remapped with `runningTurnSends` dropped and the preserved blocks moved last (`lTe`)
      - queued-command `source_uuid` remapped (`vN`)
      - `GU` resets (`isSidechain:false`, 7 keys dropped)
      - `forkedFrom` added; the last entry is stamped "now"
      - trailers: history-suppression first, then content-replacement, atis-latch, relocated, and `custom-title`
    - `prune_slice` (`aTe`/`kA`/`HU`): after slicing, compact boundaries and dead branches off the live path are left out. It uses the probe child, the live set and the terminal loop. `transcript::resolve_chain` (`Pu`) now also returns `found.terminal` for this.
  - **`sessions_store::fork` / `fork_file`:**
    - `Invalid sessionId`
    - QRe-style lookup that skips **empty** transcripts (new `find_file_where`; `find_file` unchanged)
    - the SDK's not-found messages
    - title from the option (JS-trimmed), else `oTe`'s closure: tail `customTitle` (a `""` falls through *without* the sidecar), sidecar, head `customTitle`, `aiTitle` (tail, head), first prompt; then `"<title> (fork)"`, or `"Forked session (fork)"`
    - written as `js::stringify` lines (JS number and key order), mode 0600, truncating, next to the source
  - **Oracle.** `rust/scripts/fork-golden.mjs` (node, ESLint clean) runs the real SDK `forkSession` on 31 crafted transcripts under a temp `CLAUDE_CONFIG_DIR`. It normalizes the new ids to `$FORK`/`$U<n>` and "now" to `$NOW`, and writes `tests/fixtures/fork_golden.json`. `tests/fork_golden.rs` replays every case byte for byte, including the errors. The cases cover:
    - every title source; mid-chain, missing, queued-command and progress targets
    - progress bridging and cycles, sidechains, logical parents, compact metadata, deferred tools, refusal fallback
    - trailers, resets, numbers / integer keys / junk lines, missing timestamps, duplicate uuids, the three no-messages errors
    - dead-compaction pruning, a target on a compact boundary, kept side branches, preserved messages, parallel tool results
    - Mutation-checked: disabling compaction pruning, keeping `runningTurnSends`, serde stringify, and no progress bridging each fail their case.
  - **Accept.** `forked_session_reads_back` reads the fork through `read_head_tail` → `info_from_head_tail` (title and summary `"go (fork)"`) and `transcript::session_messages` (bridged chain, new session id). It also checks the source is untouched and the mode is 0600. Lookup errors are covered by `fork_lookup_errors_match_the_sdk`.
  - **Not ported:** `sessionStore` forks (`eqe`; remote stores are an existing gap). Also, like every Rust transcript reader, a line with a lone-surrogate escape is skipped where `JSON.parse` accepts it (PORT_PLAN gap).
  - The route itself is D05. Workspace: 91 tests.
- [x] **A05** `resolveSettings` port (the managed/policy tier read used by `managed-model-policy.ts`). Accept: unit tests with fixture managed-settings files. Done 2026-10-26: every tier Claudius's `resolveSettings({ cwd })` can see is ported (A05a–b, A05d–e) or proven unread (A05c), pinned by 208 SDK-recorded cases.
  - Split 2026-10-26. The SDK's managed source (`Zq` → `ac`) is a priority chain: remote cache, then MDM (plist / HKLM), then the managed file tier, then HKCU, then WSL. The first tier present wins, unless `managedSourcesBehavior: "merge"`. A05a ports the tier a machine without MDM or remote policy uses. A05b–d port the rest, each pinned by the same patched-SDK oracle.
  - [x] **A05a** Managed file tier, the two consumers, and `GET /model` — done 2026-10-26.
    - **`crates/claudius-core/src/managed_settings.rs`:**
      - `managed_dir` (`k0e`: macOS `/Library/Application Support/ClaudeCode`, Windows `C:\Program Files\ClaudeCode`, else `/etc/claude-code`; the SDK's override hook `P0e` is compiled out).
      - `read_file_tier` (`rw`): reads `managed-settings.json`, then `managed-settings.d/*.json`. Drop-ins must be files or symlinks, not dot-files, and are sorted in UTF-16 code-unit order.
      - Per-document parse (`xGe`/`b_`): strips a BOM; text that isn't a JSON object, or blank text, contributes nothing; comments and trailing commas fail. `JSON.parse` reads out-of-range literals (`1e400`) as ±Infinity, so those are clamped to ±`f64::MAX` where serde_json would reject the whole document.
      - Per-key leniency, as the CLI's policy-tolerant schema leaves these three keys:
        - `deniedModels`: string entries kept, duplicates within one document kept; a non-array drops the key.
        - `availableModelsMatch`: `null` drops the key; any other invalid value fails closed to `"exact"`.
        - `modelPricing`: an object is kept (even `{}`). `0 < multiplier <= 10`. `overrides` must be an object of rows with all four rates in `0..=10000`; invalid rows are dropped and extra keys stripped.
        - Bad sibling keys don't drop the document.
      - Merge (lodash `mergeWith` + `xr`): arrays unioned with SameValueZero dedupe, objects deep-merged, scalars from the later document. An invalid later value leaves the earlier one.
      - Consumers: `model_policy_from` / `resolve_managed_model_policy` (managed-model-policy.ts) and `model_pricing_from` / `resolve_managed_model_pricing` (model-pricing-override.ts; `{}` counts). Also `is_model_denied_by_managed` (lib/shared/denied-models.ts).
    - **`GET /api/sessions/:id/model`:** `augment_with_aliases` skips any `ALWAYS_SHOWN_ALIASES` row the managed policy denies, before the coverage check, as in the TS route. This closes S32's `/model` item.
    - **Oracle.** `rust/scripts/managed-settings-golden.mjs` (ESLint clean) copies sdk.mjs to a temp dir and patches the compiled-out hook so `k0e()` returns a temp dir. It runs the real `resolveSettings({cwd, settingSources: []})` in a fresh node process per case, with a temp `CLAUDE_CONFIG_DIR`, and fails unless `policyOrigin` is `"file"`. It writes 63 cases to `tests/fixtures/managed_settings_golden.json`, covering:
      - every validation branch above and later-document wins
      - drop-in sort, filtering, symlinks (followed and dangling), a directory named `*.json`, `managed-settings.d` as a file, the main file as a directory
      - bad JSON, non-object roots, blank and BOM-only files, duplicate keys, huge and tiny numbers, JS number forms, integer keys
      - No case uses names that collide case-insensitively, so it replays the same on Linux.
    - **Tests.**
      - `tests/managed_settings_golden.rs` replays the managed keys, policy and pricing through `js::stringify` (number forms and key order count).
      - Mutation-checked: removing the BOM strip, union dedupe, overflow clamp, null-drops-match, dot-file filter, symlink filter, later-scalar-wins, or the empty-pricing keep, or using locale sort, each fails it.
      - Unit tests: `denied_model_matching` (the cases from `tests/unit/denied-models.test.ts`), `policy_and_pricing_from_source`, `overflowing_literals_read_as_out_of_range_numbers`, and `always_shown_alias_respects_managed_denied_models` (server).
      - Workspace: 96 tests.
    - `resolve_managed_model_pricing` has no caller yet; `cost-aggregate.ts` uses it, and the cost route is phase 4.
  - [x] **A05b** macOS MDM tier and tier selection — done 2026-10-26.
    - **Plist read** (`gw` + `WWe`, in `managed_settings.rs`):
      - `tq()` paths `<root>/<user>/com.anthropic.claudecode.plist`, then `<root>/com.anthropic.claudecode.plist`. The user is `getpwuid_r(geteuid())`, like `os.userInfo()`.
      - Per plist: `access(R_OK)` (missing → skipped, else unreadable); `/usr/bin/plutil -convert json -o - --` (5 s timeout, 2 MiB buffer). On failure, `plutil -lint -s`: a valid plist with a date/data value is unreadable. If it isn't a plist either, a 1-byte read probe decides between readable `""` and unreadable.
      - **Only plists up to the first readable one count**, so an empty, behavior-only, invalid or garbage per-user plist hides the device plist. That one is used if it has policy content.
      - Read once per process (`OnceLock`), like the SDK's `lZ()`. The files are still re-read on every call.
    - **Tier selection** (`ac` + `XGe` + `Eq`, as `resolve_tiers`):
      - Ranks: authored 2, only fail-closed substitutes 1, only void values 0. The MDM tier wins ties.
      - `managedSourcesBehavior` (`"first-wins"` / `"merge"`, otherwise dropped) is taken from the first tier that is primary or declares it.
      - First-wins: the winner alone, but a losing MDM tier's `availableModelsMatch: "exact"` binds beside it.
      - Merge: lower tiers deep-merge under the winner. Arrays union with the higher tier first. `"exact"` from any tier binds, and a `"prefix"` only lower tiers set is removed.
      - `policyOrigin` is `"plist"` / `"file"`.
    - **Documents now keep every other key raw**, since only their presence feeds the ranks; the three consumer keys are still validated. Gap (no Rust-side schema): other keys the CLI would drop or substitute count as authored content here.
    - **Oracle.** `managed-settings-golden.mjs` also patches `tq()`'s plist root to a temp dir. 40 new cases (103 in total) cover:
      - XML, binary, garbage, date/data, chmod 000 and directory plists
      - per-user vs device; every rank pairing; substitute binding; merge from either side and with drop-ins
      - valid and invalid behaviors, losing tiers declaring merge, and tiers whose only content is other keys
      - Plists are stored in the fixture as XML or base64. The plist cases replay on macOS only.
    - **Tests.** Mutation-checked: each of these fails `managed_source_matches_the_sdk`:
      - tie to file; no loser binding; merge order; no restrictive delete; behavior from the primary only; keeping invalid behaviors
      - void counted as authored; first plist *with content*; unreadable read as empty; lint-ok read as readable; ignoring the file tier's substitutes; dropping other keys
      - Unit test `tier_ranks_and_ties`. Workspace: 97 tests.
  - [x] **A05c** Remote managed-settings tier — done 2026-10-26. **Nothing to port: the SDK host never reads it.**
    - `pw` → `L2` → `D2` returns `null` unless `zo().eligible === true`. In sdk.mjs 0.3.299 `recordEligibility` and `replaceSessionCache` are defined but have no callers; only the CLI records eligibility. The `ea()` override is a compiled-out stub.
    - The other way in is `resolveSettings({serverManagedSettings})` (`remote: () => …`), and Claudius doesn't pass it (no caller in `lib/server`). The same goes for `managedSettings` (`parentManaged`).
    - So for Claudius's `resolveSettings({ cwd })`, a cached `<config>/remote-settings.json` is ignored, which is what `resolve_tiers` already does. Module doc updated.
    - **Pinned.** 5 new oracle cases (108 in total) seed a well-formed remote cache alone, over the file tier, over MDM, declaring merge, and as a fail-closed substitute. The SDK ignores it in all of them.
      - The recorder also runs a **control** on an SDK copy with the `D2` eligibility gate removed. There the same seeded cache becomes the managed source (`policyOrigin: "remote"`), which proves the cases seed the right file and only the gate keeps it out. If the gate anchor disappears after an SDK bump, the recorder fails, so remote behaviour gets re-checked.
      - `managed_source_matches_the_sdk` asserts the remote cases stay in the fixture. Workspace: 97 tests.
    - If Claudius ever passes `serverManagedSettings`, port `pw`'s tier into `resolve_tiers` (rank, `servedSnapshot`/`vt`, `nWe`, `policyOrigin: "remote"`).
  - [x] **A05d** Windows HKLM/HKCU registry policy — done 2026-10-26. Split: the WSL chain is now A05e.
    - **Registry tier** (`WWe`'s win32 branch, `Qq` + `oZ` + `hw`). `os_policy()` runs `%SYSTEMROOT%\System32\reg.exe query <key> /v Settings` for both hives, with a 2 MiB buffer and a 5 s timeout. `reg_value` is a hand-written `oZ`: JS line starts, ASCII-only case folding (non-`u` `/i`), `REG_SZ`/`REG_EXPAND_SZ`, and the capture runs to the end of the output, JS-trimEnd'd.
      - HKLM with policy content becomes the MDM tier (`policyOrigin: "hklm"`, wins ties like the plist). An HKLM that overflows or doesn't parse (`didNotLoad`) ends the read with no HKCU.
      - HKCU is the last resort (`registry_policy`): admin-only keys stripped (`managedMcpServers`, `isolation`, `prependPlugins`, `appendPlugins`; `enabledPlugins` keeps only non-`@builtin` `false` entries, and is rewritten only when one goes), composition keys removed. It isn't loaded when the file tier binds (`VWe`: a file that doesn't parse, has policy content, or fails with anything but ENOENT, ENOTDIR included; a drop-in dir that's ENOENT/ENOTDIR is missing). It's used only when no tier has policy content (`kt`).
    - **Reader parity fix** (`i0e`/`mh`/`EK`), now shared by the file tier and `VWe`: regular files only, over 2 MiB rejected, `FF FE` → UTF-16LE (odd trailing byte dropped), else lossy UTF-8, CRLF → LF. Before this a UTF-16 or non-UTF-8 file read as unreadable.
    - **Oracle on macOS by emulating win32.** The recorder patches the SDK's darwin branch to call `Qq` against a fake `reg.exe` (a shell script that logs argv and replays the captured stdout/exit code) and `ra()` to return `"hklm"`. 48 new cases (156 in total) cover: HKLM alone / over HKCU / vs the file tier, substitutes, `REG_EXPAND_SZ`, lowercase names, wrong types, `ſettings`, empty values, multi-line capture, overflow and bad JSON on either hive, HKCU composition and admin-only keys, every `VWe` blocking path (bad JSON, invalid value, behavior only, drop-ins, dot-files, directory, dangling and ENOTDIR symlinks, over 2 MiB, UTF-16), and reader cases (UTF-16LE BOM, odd byte, UTF-16BE, invalid UTF-8, exactly / over 2 MiB). Registry cases replay on every platform. `reg_query_argv_matches_the_sdk` pins the argv the SDK passed.
    - **Tests.** Mutation-checked (each fails a test): overflow read as missing; no `VWe`; read errors ignored; ENOTDIR as missing for files, binding for the drop-in dir; blank file binding; no `REG_EXPAND_SZ`; first-line capture; no UTF-16; UTF-16BE; strict UTF-8; size off by one; no HKCU strip; empty `enabledPlugins` dropped; each half of `kt`; HKLM keeping HKCU. Equivalent: the pre-read size check (the post-read check catches the same files) and Unicode case folding (any non-ASCII letter that folds to ASCII is multi-byte, so the byte-sliced head never matches). Unit tests `reg_value_parsing`, `hkcu_drops_user_writable_keys`, `policy_content_without_settings_shuts_out_hkcu`. Workspace: 101 tests.
  - [x] **A05e** The WSL chain — done 2026-10-26.
    - **Detection** (`Yd`): Linux with a non-empty `WSL_DISTRO_NAME`, or a `/proc/version` that mentions `microsoft`/`wsl` in any case; cached per process. The SDK's other check, `wt()==="wsl"` in `vq`, also accepts `WSL_INTEROP`. When only that one fires, `gw` reads no registry and `vq` ends up reading `/etc/claude-code` as on plain Linux, so `Yd` alone decides.
    - **`registry_policy(.., windows_dir)`** ports `WWe`'s WSL branch. `os_policy()` runs `/mnt/c/Windows/System32/reg.exe` (`eq`) and passes `/mnt/c/Program Files/ClaudeCode` (`Jn`).
      - **Flag (`BT`):** `true`/`"true"` arm; `false`/`"false"`/`null`/no value don't; anything else is unreadable. HKLM's value comes first. If it isn't armed, `windows_flag` (`qWe`) walks `Jn`: its main file, then any drop-in. Any armed document arms it; otherwise any unreadable value makes it unreadable. ENOENT/ENOTDIR are skipped silently; other read errors and bad JSON count as load failures.
      - **Unarmed:** no Windows source counts, but a load failure (HKLM overflow or bad JSON, a `Jn` document that won't read or parse, a drop-in folder that can't be listed) leaves the MDM tier binding with nothing in it.
      - **Armed:** a binding HKLM is the MDM tier. An unreadable flag binds with nothing in it (`kt` then leaves no managed settings unless a file tier has content). HKCU is shut out when `Jn`'s or `/etc/claude-code`'s tier binds (`VWe`), and must arm the flag itself.
    - **`file_tier(os, managed, windows_dir)`** ports `vq`. Armed: `Jn`'s tier when it or the MDM tier binds, else `/etc/claude-code`. Unarmed with a binding MDM tier: no file tier. `resolve_managed` uses it.
    - **`Tier` now carries `did_not_load`** (`lc` = policy content or didNotLoad). `read_file_tier` tracks it like `rw`/`DGe`: any read error but ENOENT, non-blank text that doesn't parse, or a drop-in folder that can't be listed for a reason other than ENOENT/ENOTDIR. `file_tier_blocks_hkcu` is now just `read_file_tier(dir).binds()`, since `yw` and `lc(rw)` agree.
    - **Oracle.** The recorder also patches `Yd()` and `vq()`'s platform check, found by shape, to report WSL, and points `Jn` at a temp `win` tree. It reuses the fake `reg.exe`.
      - 52 new cases (208 in total; 51 WSL, 1 Windows ELOOP drop-in folder) cover: every arming source and flag spelling, unreadable flags (HKLM, `Jn` main file, drop-in), unreadable-then-armed, HKLM ties and merge with `Jn`, a substitute HKLM binding beside `Jn`, and every load failure that shuts `/etc/claude-code` out (bad JSON, directory, symlink to a directory, ELOOP folder, HKLM overflow and bad JSON). They also cover what doesn't (blank, dangling, ENOTDIR, dot and `.txt` drop-ins), UTF-16, and HKCU needing its own flag and being shut out by either file tier.
      - All matched on the first replay. `managed_source_matches_the_sdk` asserts the WSL cases stay in the fixture.
    - **Tests.** Mutation-checked; each of these fails a test:
      - flag spellings (`"true"`, `"false"`, `null`, unreadable as disarmed); the walk not upgrading an unreadable HKLM, ignoring unreadable drop-ins, skipping its armed-main shortcut, counting dot-files, counting missing files as failures, treating blank as a failure, ignoring folder errors
      - load failures ignored (HKLM or walk); the unarmed MDM never binding; an unreadable flag not binding; `VWe` without `Jn`; HKCU without its own flag; each half of `vq`'s choice; unarmed keeping `/etc/claude-code`
      - the file tier treating ENOTDIR as absent, ENOENT as a failure, bad JSON as loaded, blank as a failure, a missing folder as binding, or ignoring folder errors
      - Unit test `wsl_detection`. Workspace: 102 tests.
- [x] **A06** SDK drift detector: `rust/scripts/sdk-diff.sh` compares the installed SDK version, control subtypes, Options keys and env rules against `claudius_agent::SDK_VERSION` and a checked-in snapshot, and fails on new subtypes or keys. Add the const if missing. Accept: script prints a clean report today. Done 2026-10-26.
  - **`claudius_agent::SDK_VERSION`** (lib.rs) is now the one version literal; `options::MIRRORED_SDK_VERSION` aliases it.
  - **`rust/scripts/sdk-diff.sh`** (wrapper) → **`sdk-diff.mjs`**: everything is extracted with TypeScript's parser (a direct devDependency), not regexes over minified code. Snapshot: **`rust/scripts/sdk-snapshot.json`**. `--update` rewrites it; `--sdk DIR` reads another SDK copy. It compares:
    - versions: `package.json`, the `CLAUDE_AGENT_SDK_VERSION` literal in sdk.mjs, `SDK_VERSION`, and the snapshot
    - control requests: the `SDKControlRequestInner` union (40), every `request({subtype})` the host sends plus `initialize` (55, incl. internal ones the typings don't declare), every `request.subtype === …` it handles (13)
    - `SDKMessage` `type`/`subtype` pairs (42); the `Options` keys (69); every name `query()` destructures (69, which surfaced 8 undeclared ones: `getOAuthToken`, `getHostAuthToken`, `workload`, `workspaceTrust`, `rapidFollowupPreempt`, plus the internal `isSingleUserTurn` / `resumeConfigDir` / `deferSpawn`)
    - env rules per variable (set / delete / read / key / host-set) in the two functions that tag `CLAUDE_CODE_ENTRYPOINT = "sdk-ts"` (query(): 16, ProcessTransport: 4)
  - **Any difference fails** (exit 1), not only additions: a removed or changed rule is behaviour the port may still mirror. Prints a clean report today.
  - **Self-tested** on mutated SDK copies: a new `Options` key, a declared request, a sent request, a handled request, a message type, a new and a changed env rule, and a version bump. Each is reported, with exit 1.
  - **Parity fix it surfaced:** `query()` writes `process.env.CLAUDE_AGENT_SDK_VERSION` before copying the process env, so an inherited env always carries the SDK's version. Rust kept a parent's value, e.g. when Claudius runs under a shell Claude Code spawned. `to_env` now forces it unless a custom `env` sets a non-empty one. Unit test `sdk_version_env_overrides_inherited_value`, mutation-checked.
  - **`tests/sdk_snapshot.rs`:** the snapshot and every recorded fixture (`sdkVersion`, 7 files) must be on `SDK_VERSION`. Every env variable in the snapshot must be listed as mirrored or not mirrored, with a reason; stale entries fail too. So a rule `--update` adds after a bump fails CI until it's classified. Not mirrored: `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` (run-end ceiling, A07), the two `*_AUTH_REFRESH` flags (undeclared callbacks), `CLAUDE_CONFIG_DIR`/`CLAUDE_SECURESTORAGE_CONFIG_DIR` (internal `resumeConfigDir`), `TRACEPARENT`/`TRACESTATE` (no tracer). Each assertion was mutation-checked. Workspace: 106 tests.
  - The script needs `node_modules` (TypeScript and the SDK), so it isn't in the Rust CI job; the Rust test keeps the snapshot honest there.
- [x] **A07** Audit the host-side handling of CLI-initiated control requests (`handle_control_request`) against sdk.mjs: every subtype the CLI can send, error replies for unsupported ones, `mcp_message` variants, URL-mode elicitation. Accept: a test per subtype.
  - **Done 2026-10-26.** New oracle `rust/scripts/control-golden.mjs`: the real SDK `query()` runs against `claudius-fake-claude`, whose `on_init` fires 79 control requests, then collects the replies. It records two setups: `bare` (no callbacks) and `wired` (echoing `canUseTool` / `onElicitation` / a PreToolUse hook, plus an SDK MCP server `srv` with an `echo` tool). Fixture `tests/fixtures/control_golden.json`. `tests/control_golden.rs` replays the same script through the Rust `Query` with mirrored callbacks and compares every reply with `JSON.stringify`, or checks it's absent where the SDK leaves the request unanswered.
  - Fake CLI: new `$send` step (fire a control request without waiting) and `$collect_ms` (wait until every sent id is answered or the time runs out). Stdin is read on a thread so replies can be collected with a deadline.
  - **Parity fixes, Rust `process_control_request`:**
    - The SDK's `DZ` subtypes (`remote_tool_call`, `remote_plumbing_call`, `remote_tools_probe`, `remote_tools_reannounce`) are left unanswered. They used to get "Unsupported".
    - `oauth_token_refresh` / `host_auth_token_refresh` / `remote_control_work_secret` reply "`getOAuthToken` / `getHostAuthToken` / `refreshWorkSecret` callback is not provided."
    - Subtypes match only as strings. Others print with JS `String()`: `undefined`, `null`, `7`, `false`, `a,,1,,[object Object]` (new `js::to_string`).
    - A missing or null `request` gets V8's `Cannot read properties of undefined/null (reading 'subtype')`.
    - Hook and MCP-server lookups are by string only, and their errors print the id with `String()`.
    - `mcp_message` follows `kZ`. A primitive message gets V8's `Cannot use 'in' operator…` error. An array counts as a notification. A request the server never answers stays unanswered instead of getting a made-up -32603.
  - **Parity fixes, `ToolServer` (the SDK's bundled MCP server):**
    - The strict `JSONRPCRequestSchema` check: only `jsonrpc`/`id`/`method`/`params` keys, `"2.0"`, a string or safe-integer id, and an object `params` with a valid `_meta`. Anything else is dropped without a reply.
    - Protocol-version fallback to `2025-11-25` for an unsupported version.
    - An unknown tool gets an `isError` result, "MCP error -32602: Tool X not found", rather than a JSON-RPC error.
  - **Parity fixes, `ToolPermissionContext`:** new `decision_reason_type`, `decision_reason_code`, `plugin`, `requires_user_interaction`, `server_prompt`, `computer_folder` and `matched_ask_rule` (renamed to `{source, toolName, ruleContent?}`), each with the SDK's type filters. `mcp_server` is now the SDK's `{name, source}` projection of any truthy value.
  - Known gaps, listed in the test's `GAPS` (which must still differ): zod validation of `initialize` / `tools/call` params and of tool arguments (4 cases).
  - `sdk-diff.mjs` now also captures the subtypes the host leaves unanswered (`hostIgnores`, 4), self-tested on a mutated SDK. `fixture_covers_every_sdk_subtype` fails when the snapshot lists a handled or ignored subtype the fixture doesn't send.
  - Run-end audit: the ceiling only matters for single-turn queries. Claudius' `end()` aborts in the same step as closing input. Folded into A08.
  - 28 mutants across query.rs, mcp.rs, permission.rs and js.rs are all killed (two needed new cases), plus 3 on the drift and coverage checks. Workspace: 109 tests.
- [x] **A08** One-shot query helper (`claudius_agent::oneshot(prompt, opts) -> String`) for features that call `query()` for a single answer: commit messages, recap, titles. Accept: fake-CLI test.
  - **Done 2026-10-26.** Ported the SDK's single-turn mode, which every `query({prompt: "<string>"})` caller in `lib/server` relies on: commit-message, customization-description, session-recap, scheduler, the updater merge and the models probe. Some return at the first `result`; the rest drain the stream and depend on the SDK closing stdin when the run ends.
    - `Query::spawn_prompt(prompt, opts)` writes the SDK's exact user line (`session_id: ""`, a text-block content array, `client_composed: true` under the new `Options::verbatim_prompts`).
    - It ports the run-end state machine (`endRun` / `armRunEndCeiling`). A `result` ends the run when the session state is unknown or `idle`, or when there are no bidirectional needs. `hasBidirectionalNeeds` counts a `hooks` object with keys even when no matchers are set. Otherwise the run ends on `session_state_changed: idle` (if a result arrived), or after the ceiling. `requires_action` and top-level `assistant`/`stream_event` clear the ceiling; subagent output doesn't. A single-turn query closes stdin at run end.
    - The ceiling comes from the CLI env's `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`, through a port of the SDK's integer parser `Ic` (`js::env_int`, plus `js::parse_int`). That covers scientific notation, digit grouping, the 32-unit cutoff and `parseInt` prefixes. The default is 600000, `0` disables it, and the value is clamped to `setTimeout`'s maximum.
    - `send_user_message` starts a new run, like each `streamInput` message, and applies `verbatim_prompts`.
    - `oneshot(prompt, opts) -> Result<Option<Value>>` returns the first `result` message (callers need its `subtype`, not just text) and then closes the query, like returning out of the TS `for await`.
  - **Oracle** `rust/scripts/run-end-golden.mjs`: 19 cases run the real SDK against the fake CLI. The fake gained a `$mark` step and `$FAKE_CLAUDE_EVENTS`, which logs marks and stdin EOF in order, so the fixture pins where stdin closed among the marks. The fixture also records the user lines, the yielded `type/subtype`s, and a 52-entry ceiling table computed by the SDK's own `Ic`, extracted from sdk.mjs and evaluated. `tests/run_end_golden.rs` replays all of it through `spawn_prompt`, plus `oneshot` tests: returns the result and the CLI is gone; no result gives `None`.
  - **Bug found and fixed: inherited descriptors.** The replay flaked 5/20 with `eof` never arriving. On macOS `std` creates pipes without an atomic `O_CLOEXEC`, so a CLI spawned concurrently on another thread inherited a sibling's stdin and the sibling never saw EOF. In production a one-shot could hang for as long as a session lives. Node avoids this through libuv's cloexec lock.
    - Fix: `Query` spawns now run `close_leaked_fds` in `pre_exec`. It closes every inherited descriptor above stdio that isn't close-on-exec, which keeps `std`'s exec-error pipe. It's exported for future long-lived children such as the bash-mode shell.
    - Result: 0/20 flakes. Two new `fake_cli` tests cover it: `cli_does_not_inherit_leaked_descriptors` (the fake reports its fds via the new `$FAKE_CLAUDE_FDS`) and `missing_executable_fails_spawn`. Both are mutation-checked.
  - `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` moved to `MIRRORED` in `tests/sdk_snapshot.rs`.
  - Mutation check: 30 mutants on the single-turn and parser code. 29 are killed; two needed stronger cases (a follow-up with `idle` before its result, and `oneshot` against a CLI that stays alive). The survivor is equivalent: resetting `runEnded` on a non-idle state only matters once the run has ended, and in single-turn mode stdin is closed by then. The same holds for the reset on top-level output. Plus 2 mutants on the descriptor cleanup. Workspace: 115 tests.
- [x] **A10** `readMessages` parity beyond run end (found in A08). The SDK's reader also does these, which Rust's `dispatch_line` doesn't:
  - drops `session_state_changed` messages with `sdk_host_only: true` instead of yielding them
  - replaces a process-exit error with `Claude Code returned an error result: <text>` when the last result was an error (`lastErrorResultText` / `modelLessTurnEnded` / `errorTextBeforeModelLessTurns`)
  - tracks `system/commands_changed` so `supportedCommands()` returns `latestCommands ?? initialize.commands`
  - [-] stashes unmatched `control_response`s (up to 1024). Won't do: the stash only feeds the SDK's internal `awaitControlResponse` (a multi-client remote path), so no public API or yielded message can observe it, and Claudius never uses that path.

  Accept: an SDK-recorded fixture for each, replayed against the Rust `Query`.
  - **Done 2026-10-26.** `read_message` (the old `track_run`) now follows the SDK reader branch by branch:
    - `commands_changed` with an array is remembered, and `supported_commands()` prefers it over the `initialize` list.
    - `post_turn_summary`, `task_summary`, `session_metadata`, `active_goal` and `autocompact_state` are yielded without touching any state.
    - A `result` records its error text: `result` for an `is_error` success, else the JS-trimmed, non-blank `errors` joined with `; `, kept only when truthy. It also records whether it was a model-less turn (`success`, not `is_error`, `num_turns === 0`, `result === ""`).
    - `session_state_changed` keeps the error and drops `sdk_host_only: true` (only the boolean `true`).
    - Any other message clears the last error. `system/init` also resets the model-less flag; a non-system message or `compact_boundary` resets both the flag and the error saved from before model-less turns.
    - When the stream ends in an error, `on_stdout_closed` swaps it for the new `AgentError::ErrorResult` ("Claude Code returned an error result: …") when there's text to show.
  - **Transport parity, found by the new cases:**
    - Stdout is read as bytes and split like Node `readline`: lines end at `\n`, `\r\n` or a bare `\r`, including a `\r\n` split across reads. Lines are decoded lossily, so a bad byte becomes U+FFFD. Before, one invalid UTF-8 byte ended the whole stream with an I/O error.
    - Blank lines are tested with JS `trim`, but parsed untrimmed, so an NBSP-padded line is dropped like `JSON.parse` drops it. Bare JSON values (`5`, `[1]`, `"s"`) are yielded, as in the SDK.
    - Stderr goes through a `StringDecoder` port (`stream::Utf8Decoder`). Before, a bad byte silently stopped stderr reading, so a chatty CLI could block on a full pipe.
    - The stderr tail is kept in UTF-16 units, like `yf`: trimmed to the last 2048 once past 4096, with a cut surrogate pair dropped whole, and JS-trimmed when quoted. The `stderr` callback now gets decoded chunks like `options.stderr`, not lines.
    - The exit error waits up to 200 ms after the exit for stderr to drain (`vVe`), so its tail is complete, and ignores later stderr. Without this the replay flaked 1/15 with an empty tail.
    - Signals print by name through a port of Node's `signo_string` (`claudius_agent::signal_name`). A signal Node can't name (SIGEMT on macOS, real-time signals on Linux) gives no error at all, as in Node, which reports exit code 0.
  - **Races fixed:**
    - When the CLI exited right after answering `initialize`, `on_stdout_closed` could mark `initialize` failed before the init task stored the reply.
    - `await_reply`'s `select!` could pick the close over a reply that had already arrived.
    - `initialization_result()` returned `Aborted` as soon as the query closed. Now the init task alone settles `initialize`, `await_reply` is biased toward the reply, and `initialization_result()` waits for the init task's verdict (which is guaranteed once the query closes). So `supported_commands()` works after the stream ends, as in the SDK.
  - **Oracle** `rust/scripts/reader-golden.mjs`: 45 cases recorded on macOS, one of them macOS-only (SIGEMT). It records yielded descriptors, the final error and `supportedCommands()` once the stream is over; asking earlier would race the SDK's reader. The fake gained `$stdout_bytes`, `$stderr_bytes` and numeric `$kill`. `tests/reader_golden.rs` replays every case concurrently. New unit tests cover line splitting, the decoder, the UTF-16 tail and signal names, and a `fake_cli` test covers the `stderr` callback chunks.
  - Mutation check: 42 mutants. 41 are killed; four of them needed new cases (each model-less condition alone, and an assistant message after a model-less turn), one a byte-vs-unit tail assertion. The survivor is equivalent: the blank-line check only saves a doomed parse. Flakes: 0/45 runs after the drain fix. Workspace: 123 tests.
  - Left: the SDK redacts secrets in the stderr tail before quoting it (`up()`). That's A11. Documented gaps in PORT_PLAN: the SDK's reader crashes on a non-array `errors`, a non-string error entry or a `null` message line, where Rust stays lenient.
- [x] **A11** Stderr tail redaction (found in A10). Before the SDK quotes the CLI's stderr in an exit error (`formatStderrTail`), and each time it trims the buffer, it runs `up()`. That's about 17 fixed regexes (`pVe` + `fVe` in sdk.mjs): bearer/basic auth, `sk-ant-…` and other `sk-` keys, AWS key ids, GitHub/GitLab/Slack/Square/Facebook tokens, Slack webhooks, JWTs, Google API keys and OAuth secrets, Stripe-style `sk_live_…` keys. They're replaced with `<token>` / `<jwt>` / `hooks.slack.com/<redacted>`. Rust quotes stderr unredacted, so a token the CLI prints could reach the UI's error banner.
  - Port them with fixed patterns only (they use lookahead/lookbehind, so `fancy-regex` or hand-written matchers; never compile input). Watch JS semantics: ASCII `\w`/`\b`, the non-unicode `i` flag, `$1` replacements, `g` order across the list.
  - Accept: a corpus of secret-shaped and near-miss strings run through the SDK's own `up()` (extracted from sdk.mjs like `Ic`) and through Rust, compared exactly, plus one reader case with a token in stderr.
  - **Done 2026-10-26.** New `claudius_agent::redact` module.
    - `SDK_PATTERNS` holds the SDK's 18 patterns verbatim: JS source, flags, replacement.
    - `translate()` turns a JS source into `fancy-regex` syntax with JS semantics. `\b`/`\w`/`\d` become ASCII classes, `\s` the JS whitespace set (BOM yes, NEL no), and `.` excludes line terminators. Under the non-unicode `i` flag, ASCII letters fold only to their other case, so `ſ` doesn't match `s` and the Kelvin sign doesn't match `k`. Class members are hex-escaped, so Rust never reads `--`, `&&` or `~~` as set operations. Unknown escapes, flags or a negated class under `i` panic, so an SDK bump that needs more fails in tests.
    - `translate_replacement()` handles `$1`, `$&` and `$$`. `redact()` applies the patterns in order, like `up()`.
    - Patterns are fixed strings compiled once (`LazyLock`). Input is never compiled.
    - New dependency: `fancy-regex` 0.20, pure Rust, for the look-around. The `regex` crate can't do look-around, and `re2` is a known dead end.
  - **Wiring:** the stderr tail is redacted, then cut, both when the buffer passes 4096 units and when it's quoted in an exit error, as in the SDK.
  - **Deliberate difference:** a pattern can only fail at runtime by hitting `fancy-regex`'s backtracking limit (1M). Then the whole text becomes `<redacted>` instead of risking a leak. V8 would just run longer. No recorded input comes close; the 1610-case corpus replays in about 1 s in a debug build, including a 13k-char tail.
  - **Oracle** `rust/scripts/redact-golden.mjs` evaluates the SDK's own `up()` and pattern list, sliced out of sdk.mjs between fixed anchors that it checks. The fixture holds 18 patterns and 1610 inputs: 109 hand-written (each pattern, near misses, case variants, boundaries next to `_`/`-`/`é`/`ſ`/Kelvin/emoji, JS-only whitespace, overlaps in list order), 1500 seeded random strings built from secret-ish fragments, and one long tail.
  - `tests/redact_golden.rs` checks the pattern list equals `SDK_PATTERNS` (drift guard) and that every input redacts identically: all 1610 match. A new reader case (`stderr_redacted`) checks the quoted exit error end to end. Unit tests cover the translator's JS semantics, the replacement syntax, and redaction before both cuts.
  - Mutation check: 13 of 13 mutants killed (word boundary, whitespace set, both folding paths, Unicode `(?i)`, `$1`, pattern order, negated classes, a pattern edit, each redaction call site, redact-after-cut). Workspace: 132 tests.
- [x] **A09** Cross-platform binary resolution and spawning (Windows `claude.exe`, Linux packages, PATHEXT). Low priority until a non-mac target is in scope.
  - **Done 2026-10-26.** The TS app never sets `pathToClaudeCodeExecutable`, so parity means the SDK's default lookup and its `ProcessTransport` launch. `binary.rs` now ports them:
    - `native_candidates` is `xZ`'s package list, under Node's platform/arch names (`node_platform` / `node_arch`). Linux tries glibc then `-musl`, swapped on a non-glibc build (`prefers_musl`, the `IVe` check); Android has its own package; Windows adds `.exe`.
    - `lookup` resolves candidate by candidate, skipping a resolved path that doesn't exist. `resolve_in_node_modules` walks `node_modules` up like `require.resolve`, never into `node_modules/node_modules`. `locate` keeps the port-only fallbacks: `$CLAUDIUS_CLAUDE_BIN` first, `claude[.exe]` on `PATH` last.
    - No binary at all gives `AgentError::BinaryNotFound`, worded like the SDK's ("Native CLI binary for darwin-arm64 not found. …"). It used to be a Rust-only message.
    - `is_native` (`wVe`): a path ending in `.js`/`.mjs`/`.ts`/`.tsx`/`.jsx` runs through the new `Options::executable` (default `node`). The new `executable_args` go first, before the CLI arguments, even for a native binary, as in the SDK.
    - `launch_error_message` gives `AgentError::Spawn` the SDK's wording. Node reports EACCES/EAGAIN/EMFILE/ENFILE/ENOENT asynchronously and throws every other errno from `spawn()` itself ("spawn ENOTDIR"). ENOENT/EACCES get `xVe`'s four messages (exists or not × native or JS), with the path redacted. Errno names come from a port of libuv's map (`errno_name`, "Unknown system error -N" otherwise).
    - Windows: the CLI is spawned with `CREATE_NO_WINDOW` (Node's `windowsHide`).
    - The fake CLI's `$kill` and `$FAKE_CLAUDE_FDS` are Unix-gated, and two tests gate their Unix-only probes. `claudius-agent` (lib, bins and tests) now passes clippy for x86_64 Linux glibc and musl and Windows MSVC, and the lib also for aarch64 Android. That's type-checked only; nothing has run there.
  - **Oracle** `rust/scripts/binary-golden.mjs` (macOS):
    - The SDK's own `xZ`, sliced from sdk.mjs between checked anchors, run with a fake resolver over 5 platforms × 4 arches × both libc preferences × 8 install sets (320 cases), recording the order tried and the pick.
    - The not-found template.
    - 11 real `query()` launch failures: missing, a directory, not executable, no shebang, the parent is a file, a 300-char name, a symlink loop, JS entries with and without `node`, and two secret-looking paths. Each records whether `query()` threw synchronously.
    - Two JS entries recording the argv and `execArgv` node received.
    - Node's errno names for 1..120.
  - `tests/binary_golden.rs` replays all of it: lookup and the template everywhere, the rest on macOS. JS entries are skipped without `node` on `PATH`. One gap is listed in its `GAPS`, and the test fails if it ever starts matching: `no_shebang`. Node's posix_spawn reports ENOEXEC, but std's `execvp` retries the file through `/bin/sh`.
  - Mutation check: 13 of 13 killed after adding a `node_modules/node_modules` decoy (musl order, Android, `.exe`, the exists check, a JS suffix, the exists/native message choice, the sync wording, redaction, an errno name, the walk filter, `executableArgs` order, the interpreter, `is_native`). Workspace: 141 tests.

- [x] **A12** Control requests at and after cleanup (found in S09). In sdk.mjs:
  - `Query.request` rejects up front with `ww()` ("Query closed before response received") once `cleanupPerformed` is set (its reader ended, or `close()` ran).
  - `performCleanup` rejects every pending control response, `initialize` included, with the cleanup cause (the exit / error-result error) or `ww()`.
  - `ProcessTransport.write` throws "ProcessTransport is not ready for writing" once the process's `exit` has fired.

  Rust instead:
  - A request after the CLI died writes into the dead pipe (`Broken pipe (os error 32)`), or after `closed` gets `Aborted` ("Claude Code process aborted by user").
  - Waiters still pending at stdout close get `Closed`, and those pending at `close()` get `Aborted`.
  - A failed `initialize` reads "Claude Code process exited before initialize completed", which is Rust's own wording (not in sdk.mjs).

  Record the SDK's behaviour with an oracle that drives the real `query()` against the fake CLI: a request after a clean / non-zero exit, in flight at exit 0 / 3 / an error result, in flight at `close()`, after `close()`, and `initialize` unanswered at exit. That needs a fake control directive that exits without replying. Then match it. It surfaces as the 503 text of every route that forwards a control request (`background-task`, `stop-task`, `mode`, `model`, …) on a dead CLI. deps: A07, A10
    — done 2026-10-26:
    - **Oracle.** `rust/scripts/cleanup-golden.mjs` drives the real SDK `query()` through 21 step lists (streamed / single-turn; the fake CLI, or a shell CLI that closes its stdin), 5 runs each, all stable. It writes `tests/fixtures/cleanup_golden.json`, which `tests/cleanup_golden.rs` replays through `Query`.
    - **Fake directives.** `control.<subtype>.$no_reply` and `$hold_stdout_ms`.
    - **Host changes** (`QueryHandle`):
      - `request` fails up front with the new `AgentError::QueryClosed` once the reader ended. The check sits under the `pending` lock, so a request can't slip past the drain.
      - The cleanup fails waiters, `initialize` included, with the exit's cause (`AgentError::duplicate`), or `QueryClosed`. The "exited before initialize completed" wording is gone.
      - `write_json` follows `ProcessTransport.write`: after an abort, `Aborted`, now worded "Operation aborted". After the exit, a failed write or the cleanup, `Closed`. An ended stdin drops the write, and so does a dead pipe (it also marks the transport not ready).
      - After `close()` the stream ends with `Aborted` (it used to end clean). `close()` now sets a separate `aborted` token.
    - **Tests.** The dead-CLI test in `claudius-server/tests/background_task.rs` now asserts the exact 503 `Query closed before response received`, waiting on the session's exit error over SSE. `read_until` moved to the shared test helpers. `fake_cli` close test: a prompt after `close()` fails "Operation aborted" and the stream's last item is the abort.
    - **Checks.** Mutation 14/14. Flake: golden 0/24 serial, 0/12 in 4-way parallel; `background_task` 0/8. No e2e (the user's app holds `.next-e2e`; no spec drives a dead CLI).
    - **Left as documented differences** (PORT_PLAN): waiters fail at `close()` rather than at the SDK's later cleanup, and the SDK's racy "aborted by user" wording.

- [x] **A13** Deflake `cleanup_golden`'s `cli_closed_stdin` (found in S11b: 1/100 alone, more under the gate's load). The case's shell CLI reads the `initialize` line, closes its stdin, sleeps, exits 3; the steps assume stdin is closed 300 ms after spawn. When the shell is slower than that, request `a` lands in the pipe buffer, so `b` is the first dead write and gets the exit error instead of "ProcessTransport is not ready for writing". The SDK behaves the same with that timing, so the margin is the bug, not the host. Make the order deterministic in both the recorder (`rust/scripts/cleanup-golden.mjs`) and the replay: e.g. the shell prints a `system` line after `exec 0<&-` and a new step waits for the first message before `request a`. Re-record with the real SDK, 5 runs each. deps: A12 · Accept: the case is stable under load (0/100 serial and 0/20 alongside a full `cargo test --workspace`).
  — done 2026-10-26 (background agent, merged by the loop): the shell CLI prints a `system` line after `exec 0<&-`, and the case waits for it with a new `["next"]` step (read one message) instead of `sleep 300`, in both the recorder and the replay. The replay's `request` step now polls the request in place until it waits for its reply, then spawns it, so its write is done before the next step, as with the SDK's synchronous `transport.write`. Before, the `sleep 200` between `a` and `b` was a second hidden margin: removing it made the old spawn-only replay fail 10/10, while the new one passes 0/30. Node needs no margin there because the stdin `EPIPE` arrives on `nextTick`, and the recorder gives the same outcome with `sleep 0`. Re-recorded with SDK 0.3.299, 21 cases × 5 runs, all stable. The other 20 cases are byte-identical, and `cli_closed_stdin`'s outcomes are unchanged. Flake 0/100 serial, and 0/20 alongside `cargo test -p claudius-core` (not the full workspace). No host code changed, so no mutation run.

- [x] **A14** V8 `JSON.parse` `SyntaxError` messages as a shared helper (`js::json_parse_error(text) -> Option<String>`, `None` when the text parses). Found in S13: a TS route that catches `await req.json()` and returns the error's `message` (`rewind`'s 503, and 8 unported routes: `accounts`, `accounts/oauth`, `agents/db`, `customizations`, `doctor/fix`, `settings/import`, `settings/import/[id]/resolve`, `workspaces/[id]/move-sessions`) answers V8's exact wording. D10a's `sanitizeJsonParseReason` needs the same text.
  - Cover every V8 template: unexpected end of input, unexpected token with its short / start / end / surrounding context forms and their windows, unexpected number and string, expected property name / comma / colon / double-quoted name, bad escape / `\u` escape / control character, unterminated string, missing exponent or fraction digits, `-` without a number, non-whitespace after the value, and positions with line and column.
  - The input is the body as `Body.json()` decodes it (BOM stripped, invalid UTF-8 → U+FFFD), and positions count UTF-16 units.
  - Lone-surrogate escapes (`"\ud800"`) parse in V8: this answers `None` for them even though serde rejects them.
  - Accept: a golden recorded from node@22 `JSON.parse` over at least 200 malformed inputs, matched byte for byte.
  — done 2026-10-26 (background agent): `rust/scripts/json-parse-golden.mjs` records node 22's own `JSON.parse` (V8 12.4) on 2 560 inputs: 2 388 malformed (every length 1–26 × token position plus 7 longer lengths at the window edges, every Latin-1 unit after `\`, every C0 control in 5 string spots, 7 line-break styles, astral characters across both window cuts, BOM and 11 disallowed spaces, 2 000-deep nesting, 754 mulberry32 fuzz cases) and 172 valid (with `JSON.stringify` of the well-formed value). It also records 19 raw lone-surrogate inputs (UTF-16 units) and 44 raw bodies through `new Response(bytes).json()`; 3 recordings byte-identical. Port: `claudius_agent::js::json_parse_error` (+ `json_parse_error_utf16`, exact units) is V8's `ParseJsonValue` reduced to an iterative validator; `js::json_parse` gives the value or the message; `claudius_server::body::JsonBody::text` / `parse_or_message` are `Body.text()` / `Body.json()` with the message (older helpers unchanged). Found:
    - The window is ±10 units once the source has ≥ 21 (start / surround / end forms; position 10 is already "surround").
    - Token forms carry no line/column.
    - The short form is only for `[object Object]` / `undefined` / `Infinity` / `NaN`.
    - "Expected …" messages keep their wording at the end of input.
    - `Body.json()` strips two leading BOMs, the older `JsonBody` helpers one.
  Differences (PORT_PLAN): lone surrogates in a message are dropped from the `String` (39 recorded); `json_parse` maps lone-surrogate escapes to U+FFFD and out-of-range numbers to `null`, and nesting past 127 is an `Err`. Tests: `tests/json_parse_golden.rs` (8), `body.rs` units (3: BOMs, invalid UTF-8, empty body, the recorded bodies). Mutation 124/125 (1 equivalent: the CRLF lookahead bound). No caller yet: S13 and D10a wire it in. Merged from the parallel clone; main-tree gate green.
- [x] **A15** Control requests with `JSON.stringify` number text (found by S15a): `Query` writes stdin with `serde_json::to_string`, so user JSON that reaches the wire (e.g. `mcp-dynamic`'s server configs) prints `0.000001` as `1e-6` and `123456789012345680000` as `1.2345678901234568e+20`, where the SDK prints `JSON.stringify` text. Switch `write_json` to `js::stringify` and drop `mcp-dynamic`'s round trip. Accept: the golden wire tests and `tests/mcp_dynamic.rs` stay green, with the number-text gap removed from its `KNOWN` list.
  — done 2026-10-27: `QueryHandle::write_json` writes `js::stringify(message) + "\n"` (the SDK's `JSON.stringify`), so every stdin line (control requests, user messages, permission and hook replies) carries JS number text (`0.000001`, `123456789012345680000`) and integer-like keys first. The two JSON argv values the SDK builds with `JSON.stringify` do the same: `--json-schema` and `--mcp-config`. `mcp-dynamic`'s parse-and-reprint round trip is gone, and its number-text case left the `GAPS` list of `tests/mcp_dynamic.rs`: it now matches the TS-recorded wire byte for byte. Gate in the clone: 344 passed, 1 failed (`background_task::reports_what_the_cli_answers`, a connection reset under the load of five agents' builds), and that test then passed 5/5 alone; main-tree gate with S20 merged: 357 passed, 0 failed. No e2e: the wire is covered by the TS-recorded goldens.

## 3. Session engine — feature slices (session methods + their routes + tests)

TS reference: `lib/server/session.ts`, unless a task names another file. Session
routes live in `app/api/sessions/[id]/<name>/route.ts`. Routes whose TS
handler uses `session-resume` must use `mgr.get_or_resume`.

- [x] **S01** JSONL watcher: `startJsonlWatcher` / `stopJsonlWatcher` / `scheduleJsonlResync`.
  - Watch the project dir (`notify` crate) and filter on `<id>.jsonl`.
  - Coalesce with a 200 ms debounce; re-arm while a resync is busy.
  - Stop the watcher in `end()`.

  Accept: a test appends lines to the JSONL externally and the SSE subscriber receives them.
  — done 2026-10-26: new `claudius_core::jsonl_watch` (`notify` 8.2, non-recursive watch on the transcript dir; filter is "`<id>.jsonl` directly in the dir, not an access event", because inotify reports opens and the resync's own read would loop) plus `Session::start_jsonl_watcher` (end of `start()`, as in TS), `stop_jsonl_watcher` (in `end()`), `fire_jsonl_resync`, and the `jsonl_resync_busy` flag around `resync_from_disk`. Deliberate difference: watches `<config>/projects/<SDK name>` (where the transcript is and `resyncFromDisk` reads), not TS's `projectRoot(cwd)`, which misses for >200-char cwds or a separate `CLAUDE_CONFIG_DIR` (PORT_PLAN gaps). Tests: 6 paused-clock/filter unit tests + a real-FS watch test + missing-dir test, a busy-flag unit test (holds the state lock so a resync stalls mid-flight), `session_fake::external_transcript_writes_reach_subscribers` (once each, `at` from the transcript, carry-forward, `end()` stops it, no dir → no watcher), and server `tests/jsonl_watch.rs` (append → event on an open SSE stream). Mutation 17/17; flake 0/35; `jsonl_watch.rs` clippy-clean for linux-gnu/musl/windows-msvc (core itself can't cross-build: bundled SQLite needs a C cross toolchain).
- [x] **S01b** Start the JSONL watcher off `start()` (found by S19). `notify`'s FSEvents `watch()` blocks in `FSEventStreamStart` for 3–11 s on this macOS 27 machine, for any path (the real `~/.claude/projects` included), and `start_jsonl_watcher` called it inline: every session create and resume, in the app too, waited that long, where libuv starts `fs.watch`'s stream on its own thread and TS `start()` returns at once.
  — done 2026-10-26: the watch starts on a detached thread (entering the runtime for the coalescing task; not `spawn_blocking`, so a runtime shutting down doesn't wait for it) and is installed only if the session hasn't stopped it meanwhile (`WatchSlot::{Idle, Starting, Running}`); a failed thread spawn leaves it unwatched. `watching_jsonl()` is true only once it runs; the new `wait_jsonl_watcher()` waits for every start in flight, including one that lost to `end()`. Events before the stream is up are missed, as with libuv, and a subscribe resyncs from disk anyway. Stopping had the same problem (found in the S19 flake run, under the load of five parallel builds): dropping a notify FSEvents watcher joins its run-loop thread, which sat in an fseventsd RPC (`FSEventsGetCurrentEventId`) for over two minutes, blocking the thread that ended the session. Dropping a `JsonlWatch` now cancels the debounce at once and closes the OS watcher on a detached thread. Effect: a resume in `session_fake` went from 6.6 s to 0.2 s, and S19's rebuild loop from 65 s to 0.7 s. Tests: the watcher tests wait for the watcher before writing; `external_transcript_writes_reach_subscribers` also ends a session whose watch is still starting and checks the late watch is dropped; `claudius-server/tests/jsonl_watch.rs` re-touches the file (a blank line) every second until the resync delivers the line. Mutation: in S19's set (2 mutants). The start latency itself has no functional test (it depends on the OS).
- [x] **S02** Effort: `setEffort`, `refreshAppliedEffort` (after live `init` and after `model_changed`), `effort_applied` echoed on subscribe, and `POST /:id/effort`. Accept: http test.
  — done 2026-10-26: `claudius_core::effort` (`buildEffortFlagSettings`, `parseAppliedEffort`, the route's `LEVELS`; replayed against the TS functions by `tests/effort_golden.rs`, recorded by `rust/scripts/effort-golden.mjs` under bun: 12 payloads, 40 `get_settings` shapes). `Session::set_effort` (apply via `applyFlagSettings`; save to `userSettings` unless "auto" or session-only) and `refresh_applied_effort` (seq taken at call time so a stale reply is dropped; broadcast even when unchanged), triggered after the live `init`, after `set_effort`, and from `Session::broadcast` on any `model_changed` (as TS's `broadcast()` does, so dev-broadcast counts). `POST /:id/effort` (`mgr.get`, strict `req.json()`, `body?.level` → 400 "invalid effort level", flags only on literal `true`). Tests: golden (3) + unit (2), `session_fake::effort_is_applied_refreshed_and_re_emitted`, the http scenario's effort section (400s, flags coercion via the fake's control log, SSE `effort_applied`, 404), body-semantics strict/`null` cases. Mutation 18/19 (the survivor was an equivalent `as_object()`, now removed); flake 0/15; e2e on Rust: the 5 effort specs (bare-model-picker, usage-behaviors, model-picker, effort-init-mirror, max-effort-level) 16/16.
- [x] **S03** Fast mode: `setFast` + `POST /:id/fast`. Accept: http test.
  — done 2026-10-26: `Session::set_fast` (`applyFlagSettings({fastMode})`, errors swallowed, no effort refresh since fast mode is orthogonal to it) and `POST /:id/fast` (`mgr.get`, strict `req.json()`, non-boolean `body?.enabled` → 400 "invalid 'enabled' (boolean required)", echoes `{ok, enabled}`). Tests: the http scenario's fast section (400s for null/string/number/array, the exact payloads via the fake's control log, no `effort_applied` follows, 404) and body-semantics strict/non-object cases. Mutation 7/7; e2e on Rust: `cc-parity-2.1.218-fast-mode-model-switch`, `cc-parity-2.1.299-bare-model-picker`, `sdk-update-0.3.219-fast-mode-disabled-reason` 7/7.
- [x] **S04** Ultracode: `setUltracode` + `POST /:id/ultracode`. Accept: http test.
  — done 2026-10-26: `Session::set_ultracode` (`applyFlagSettings({ultracode})`, errors swallowed, then the S02 applied-effort refresh) and `POST /:id/ultracode`, sharing `toggle_body` (strict `req.json()`, boolean `body?.enabled` or 400 "invalid 'enabled' (boolean required)") with `fast`. Tests: the http scenario's ultracode section (400s, exact payloads via the fake's control log, an `effort_applied` after each toggle, 404 for both toggles) and body-semantics strict/non-object cases for both routes. Mutation 6/6; e2e on Rust: `cc-parity-2.1.299-usage-behaviors`, `model-picker`, `sdk-update-0.3.219-workflow-size-guideline` 9/9.
- [x] **S05** Output style: `setOutputStyle` + `GET/PATCH /:id/output-style`. Accept: http test.
  — done 2026-10-26: `Session::set_output_style` (live `updateSettings("localSettings", {outputStyle})`, best effort and skipped without a CLI; then `{...current, outputStyle}` into the `local` scope, so an existing key keeps its place; a read/write failure is the error) and the routes: GET via the CLI's `initializationResult()` (`output_style_view`: the CLI's list only when it's a non-empty array, `output_style ?? "default"`, `source` session/fallback; a failed call or `null` result logs and falls back), PATCH with `.catch(() => null)` semantics where a non-string `outputStyle` throws (bare 500) like `.trim()` does, JS `trim`, 400 "outputStyle is required", 500 `{ok:false, error}`. Tests: `output_style_view` unit (11 shapes), server `tests/output_style.rs` (real binary: scripted `initialize` list → session; failing `initialize` → fallback; 404), the http scenario's output-style section (400s, thrown 500s, BOM/NBSP trim, key order + 2-space file, the `localSettings` payload, malformed file untouched, 404s). Mutation 14/14; e2e on Rust: `cc-parity-2.1.269-output-style-command`, `settings-backup` 4/4. Found: the shared settings layer's error text differs from TS (new D10a).
- [x] **S06** Agent: `setAgent`, `supportedAgents`, `GET/POST /:id/agent`, `GET /:id/agents`. deps: I06
  — done 2026-10-26: the agent moved from the immutable create options into session state (`State.agent`, `Session::agent()`), read through `truthy_agent()` (`this.agent ? { agent } : {}`, so `""` is kept but omitted) by both `ready` events and the CLI options. `Session::set_agent` (no-op without a query; `applyFlagSettings({agent})` with errors swallowed; `name ?? undefined` into state; `agent_changed` broadcast). Routes: `GET /:id/agent` (`{agent: … ?? null}`), `POST /:id/agent` (`req.json()` try/catch → 400 "invalid JSON body"; destructuring a `null` body throws → bare 500; type then required 400s; `{ok, agent ?? null}`), `GET /:id/agents` (raw `initialize` response, not `QueryHandle::supported_agents`'s `[]` default, so a missing key answers `{}`; no query → 503 "session not active"; a `null` response → 503 "Cannot read properties of null (reading 'agents')"; failed initialize → 503 with its message, logged). The `Session.supportedAgents` wrapper isn't ported: no route calls it. Tests: `session_fake::agent_switch_needs_a_live_query_but_not_a_successful_apply` (no-query no-op, refused apply still recorded and broadcast, `--agent=` in argv, `""` absent from both `ready`s), server `tests/agents.rs` (real binary: scripted agent list, create-time `--agent`, `""` not passed, missing key → `{}`, `agents: null` kept, `null` response and failed initialize → 503, 404s), the http scenario's agent section (400s, switch/reset/`""` over SSE and the control log, a late tab's `ready`, a never-spawned session → no-op 200 + 503) and body-semantics cases. Mutation 16/16; flake 0/8; e2e on Rust: `agent-picker`, `cc-parity-2.1.218-agent-name-colon`, `cc-parity-2.1.233-spinner-tip-agents-removed` 6/6.
- [x] **S07** Todos (all four subtasks done 2026-10-26). Split 2026-10-26 (the TS is ~900 lines across `captureSnapshotState`, `clearTodos`, the override set and the turn-end sync). Accept for the whole: fake-CLI TodoWrite/Task* tests + http tests.
  - [x] **S07a** Snapshot capture at parity: `captureSnapshotState`'s todo branches with the `latestTodosSnapshotAt` cutoff (TodoWrite replace, TaskCreate pending entry + promotion from the `Task #N created` result or a JSON `{task:{id}}`, TaskUpdate status/subject/delete, TaskList rebuild via `lib/shared/parse-tasklist-result.ts`), the Edit/Write worktree detection that also runs on replayed tool uses, `markTodosTouchedThisTurn` / `openTodoCount`, the mid-turn staleness reminder (`TODOS_MIDTURN_TOOLUSE_THRESHOLD`, `todosMidTurnReminderBody`), and in `sendInput` the stale-TodoWrite nudge (`STALE_TODO_TURN_THRESHOLD`, `staleTodoReminderBody`) plus the per-turn resets. Accept: golden parse/body fixtures from TS + fake-CLI scripted Task* turns.
    — done 2026-10-26: new `claudius_core::todos` (`parse_task_list_result`, `task_create_real_id`, `open_todo_count`, the three reminder bodies; the regexes hand-matched with JS `\s` / `.` / ASCII-only `/i` semantics) replayed by `tests/todos_golden.rs` against the TS (`rust/scripts/todos-golden.mjs` under bun imports `session.ts` itself and reads the module-private regex and thresholds from its source: 39 task lists, 33 create results, 9 bodies, 6 open counts), plus `js::stringify_pretty` (`JSON.stringify(v, null, 2)`). `State::capture_snapshot_state` now follows TS branch by branch (TodoWrite / TaskCreate / TaskUpdate / TaskList with the `latest_todos_at` cutoff, promotion, error removal, live-only rebuild flag, any truthy `parent_tool_use_id` skipped), the worktree heuristic runs on replayed edits too (`State::broadcast_cwd`), the mid-turn reminder (12 non-todo tool uses with an open list, once per turn until a touch), and `send_input` gains the stale-TodoWrite nudge (every 15th silent turn, only with a non-empty list) and the per-turn resets. Dropped: the old capture's un-staling on TodoWrite (TS doesn't; S07d owns staleness). Fake CLI: `$HOOK:<Event>` resolves the host's callback id, so a script can drive PreToolUse. Tests: golden (5), unit (3 in `todos`, 7 State-level in `session`), `session_fake::task_tools_drive_the_todo_snapshot` (create → promote by string and JSON result, update, failed create, delete, TaskList rebuild; the mid-turn reminder read back through a real PreToolUse `additionalContext`: quiet at 11, once at 12, restarted per turn, re-armed by a touch) and `stale_todowrite_nudge_rides_every_fifteenth_silent_turn` (15th only, not 16th, not with an empty list). Mutation 37/38 (the survivor was an equivalent empty-path filter, now removed); flake 0/12; e2e on Rust: `sse-stream-recovery`, `chat-screenshots` 7/7. Found: a TS dedupe bug the port mirrors (PORT_PLAN "Mirrored TS bugs", new T08).
  - [x] **S07b** `clearTodos(reason)` (cutoff, `todosClearedAt` via `mergeSessionState`, empty `session_snapshot`, `todos_auto_cleared` for non-manual clears) + `POST /:id/clear-todos` (resume); `start()` seeds the cutoff from `todosClearedAt`, then after replay runs the 24h stale clear (`TODOS_AUTO_CLEAR_MS`) and the all-completed clear; `hasTodosActivity` in `subscribe()`'s snapshot. deps: S07a
    — done 2026-10-26: `Session::clear_todos(TodosClearReason)` sets the cutoff before anything else (so a racing older write bounces), drops the list and pending creates, resets the turn / tool-use counters and `todos_stale`, persists `todosClearedAt` best effort, broadcasts the empty `session_snapshot`, then `todos_auto_cleared {reason, count}` only for a non-manual clear of a non-empty list. `start()` seeds `latest_todos_at` from a finite `todosClearedAt` before the replay, then runs the 24h stale clear and the all-completed clear. `subscribe()` sends `todos` whenever the cutoff is finite (`hasTodosActivity`), so after a clear the empty list is explicit. `POST /:id/clear-todos` goes through `get_or_resume` (any body; 404 with no transcript). Not yet reset by the clear: S07d's progress counters (noted on S07d). Tests: `session_fake` `clear_todos_persists_and_paints_empty` (fresh-session clear, marker, toast gating), `resume_honours_the_clear_marker_and_auto_clears` (7 resume cases), `a_clear_bounces_older_transcript_writes` (watcher-resynced writes before vs after the clear), `a_clear_rearms_the_stale_todowrite_nudge`; `http` clear-todos (live, unknown id, a reaped session it resumes and marks). Mutation 19/22: the 3 survivors can't change behaviour today (the pending-create and tool-use resets, since no list → nothing to promote or remind; the `todos_stale` reset, since nothing sets the flag before S07d). Flake 0/16; e2e on Rust: `sse-stream-recovery`, `chat-screenshots` 7/7.
  - [x] **S07c** Manual overrides: `updateTodoItem`, `applyManualTodoOverrides`, `clearManualTodoOverrideFor` (clear-on-touch in the TodoWrite/TaskCreate/TaskUpdate branches, the temp-id → real-id migration on promotion), loading `manualTodoOverrides` in `start()`, `POST /:id/todos/[itemId]` (resume). deps: S07b
    — done 2026-10-26: `State.manual_todo_overrides` (insertion-ordered; persisted through `mergeSessionState` in JS key order, integer-like ids first) with `apply_manual_todo_overrides` (`deleted` filters, any other status replaces `status` in place; called after a TaskList rebuild and in `start()` between the stale and all-completed clears), `clear_manual_todo_override_for` (live only; from the TodoWrite ids, TaskCreate's temp id after its dedupe, and TaskUpdate's taskId) and the temp → real id move on promotion (also on replay; only the live move is persisted). `start()` loads the persisted map with the clear marker (non-object ignored, empty ids and unknown statuses skipped). `Session::update_todo_item(item_id, TodoItemAction)` edits in place, bumps the cutoff, records + persists the override and broadcasts `session_snapshot {todos, todosStale}`; `POST /:id/todos/{item_id}` checks the body before the session (400 `invalid JSON body` / thrown on `null` / the action message), resumes via `get_or_resume`, and maps `no active todo list` / `item not found` to 422. Persistence runs synchronously under the session lock (TS fires it and moves on). The TS 503 for a pre-HMR Session instance has no Rust equivalent. Tests: unit (overrides yield to live touches only, incl. the deduped TaskCreate; promotion keeps order; TaskList re-apply; apply counts and key order; action mapping), `session_fake` `user_edits_stick_until_the_model_touches_them` (edit / re-edit / errors, stored order, live touch, TaskList, a click between TaskCreate and its result), `an_edit_bounces_older_transcript_writes`, `resume_reapplies_the_users_edits` (6 cases: replayed touch can't drop an edit, malformed entries, edits completing a list → all-completed clear, a reopen keeps a finished list, the stale clear counts the model's list, an unsaved replayed promotion), `http` (422s, percent-decoded ids, a reaped session resumed and edited, the post-replay snapshot) and `body_semantics`. Mutation 28/29 (the survivor, `todosStale` in the edit's broadcast, can't differ until S07d sets the flag). Flake 0/16; e2e on Rust: `sse-stream-recovery`, `chat-screenshots` 7/7 (no spec drives the per-item controls).
  - [x] **S07d** Turn-end sync: `maybeAutoSyncTodosOnTurnEnd` + `setTodosStale` (progress-based staleness: flag at `TODOS_STALE_FLAG_TURNS`, clear at `TODOS_STALE_CLEAR_TURNS`; the `todos-current` reminder; the one-turn TaskList-rebuild suppression of the all-completed clear) from the `result` handler; also add the `turnsTodosNoProgress` / `lastTodosDoneCount` / `lastTodosTotalCount` resets to `clear_todos`, and test the `todosStale` that `clear_todos` resets and `update_todo_item` broadcasts (unobservable until the flag can be set). deps: S07b
    — done 2026-10-26: `State::todos_turn_end` + `Session::maybe_auto_sync_todos_on_turn_end`, run from the `result` handler on `success` only, before the queue drain. Resets the per-turn flags (the TaskList-rebuilt flag is taken, the mid-turn counters zeroed); no or empty list → progress baseline reset; all `"completed"` → baseline reset and `clear_todos(Completed)` unless a live TaskList rebuilt it this turn; otherwise progress (more done, or a shorter list, against the last turn end) un-stales and restarts the count, and a turn without it counts toward `TODOS_STALE_FLAG_TURNS` (3: `set_todos_stale(true)`, which repaints only on a change, with the live list) and `TODOS_STALE_CLEAR_TURNS` (6: `clear_todos(Stale)`, no reminder); then the `todos-current` reminder (whole list) is queued for the next turn. `clear_todos` now resets the progress baseline. Thresholds in `claudius_core::todos`, checked against the TS source by the golden fixture. Tests: unit `turn_end_flags_then_clears_a_list_that_stops_moving`, `turn_end_clears_a_done_list_unless_a_task_list_just_rebuilt_it`; `session_fake::turn_ends_keep_the_list_in_view_then_flag_and_clear_it` (a failed turn doesn't count or remind, flag at 3 / clear at 6, a non-progress edit keeps the flag, the clear restarts count and flag, all-done clear and the TaskList one-turn reprieve, which prompts carried the reminder). Existing tests updated for the new turn ends (TS behaves the same): the stale-TodoWrite nudge tests keep their list moving with user edits, `task_tools_drive_the_todo_snapshot` keeps an open item; match keys the reminder text can contain (`list`, `prune`) renamed, since the fake CLI matches on the whole message. Mutation 27/27; flake 0/8 (whole `session_fake`); e2e on Rust: `sse-stream-recovery`, `chat-screenshots`, `turn-status`, `cc-parity-2.1.275-send-all-queued`, `sdk-update-0.3.287-prompt-queue`, `sdk-update-0.3.245-queued-turn-count` 23/23.
- [x] **S08** Task persistence: `lib/server/session-tasks-db.ts` → `persistTask`, `persistTaskForToolUse`, `sendTaskSnapshot` (`task_snapshot` on subscribe), with `captureTaskState` at parity. deps: I06 · Accept: tasks survive reap → resume and repaint via `task_snapshot`.
    — done 2026-10-26: new `claudius_core::session_tasks_db` (`TaskEntry` with `to_json` in `rowToEntry`'s key order, `save_session_task` with the TS upsert, `list_session_tasks` oldest update first; number / flag columns read leniently so one foreign text value can't sink the list). `State::capture_task_state` rewritten branch by branch: a truthy string `parent_tool_use_id` → `{at?, message}` kept per parent (cap 500, oldest dropped) + throttled write for the first task with that tool-use id; `task_started` (full entry, write), `task_progress` (throttled), `task_updated` / `task_notification` (write; the notification's fallback entry carries no tool-use id, like TS). `persist_task` throttles at 2 s per task, every write restarts the window; `task_clock` seam pins the clock in tests. `subscribe()` sends `task_snapshot` between the fresh title and the queue snapshot when rows exist. Golden: `rust/scripts/tasks-golden.mjs` runs under node@22 (bun can't load better-sqlite3; `--experimental-transform-types` + a resolve hook import `session.ts` itself) and records the DB layer (5 saves with rows + types after each, 5 hand-written rows) and `captureTaskState`/`persistTask` on a bare session with `Date.now` stubbed (8 scenarios, 40 steps); replayed by `tests/tasks_golden.rs` (4 tests) and `session::tests::tasks_golden_capture`. `session_fake::tasks_survive_a_reap_and_repaint_via_task_snapshot` (none without tasks, the running row mid-run, the final state with the conversation, the same snapshot after reap → resume). Mutation 46/48 (survivors: the unsubscribed-during-read guard, race-only like the title / queue sends; a dead REAL arm in the flag reader, since removed). Flake 0/36. No e2e: the task specs mock the stream, and the user's live app instance held `.next-e2e`; instead the app was launched for the user (Rust front door on `localhost:3100` + `next dev`), which created a session and drove the real CLI.
- [x] **S09** Background tasks: `backgroundTasks` + `POST /:id/background-task`, using `background_tasks` from A01; `countActiveBackgroundTasks` at parity. deps: A01
    — done 2026-10-26: `Session::background_tasks(tool_use_id)` (`no active query` before the query exists, else the CLI's answer or error) and `POST /:id/background-task` (live sessions only → 404; `req.json().catch(() => ({}))` then a string `toolUseId` or nothing; `{ok, backgrounded}`; 503 with the message). `countActiveBackgroundTasks` was already at parity from S08 (the golden checks the count after every step; both `turn_status` sites carry `backgroundTasks`). Tests: `claudius-server/tests/background_task.rs` (one task or all, an empty id kept, 7 bad bodies → all, the exact control requests, `backgrounded` false / null / missing, a refused request → 503 with its message, 404, a dead CLI → 503), `body_semantics` (bad bodies, 404), unit `background_tasks_need_a_query`, `session_fake::backgrounding_a_subagent_frees_the_session` (Ctrl+B with the CLI's `task_updated` patch: running/0 → idle/1 → idle/0). Mutation 6/6, flake 0/24, no e2e spec drives the route. Found: the host's errors for control requests at and after cleanup differ from the SDK's (new **A12**); the dead-CLI test checks only the 503 until then.
- [x] **S10** Bash mode (`!`): `runBashCommand`, `lib/server/bash-mode.ts` (404 lines), `lib/server/pending-bash-output.ts`, `POST /:id/bash`. The command runs in the session cwd, its output is broadcast, and pending output is folded into the next prompt. Accept: http test with `echo`.
    — done 2026-10-26: new `claudius_core::bash_mode`. `BashSession` is a handle to an actor owning one persistent `/bin/bash --norc --noprofile` (its own process group via `setsid`, `close_leaked_fds` like the CLI children). Commands run in call order, one at a time, each framed by a per-command sentinel (stderr first, then `marker:exit` on stdout); each stream keeps its JS-length cap (16 Mi UTF-16 units, `truncated`) and loses one trailing newline at the marker. A timeout (120 s default) SIGTERMs the group and respawns; output between commands and from a replaced shell is dropped; a spawn error reads `spawn /bin/bash <CODE>`. A per-session registry (`get_or_create_bash_session` / `drop_bash_session`, called from `end()`). `plan_bash_command` mirrors the route's sudo handling: more than one `\bsudo\b` → the compound error; else the first `sudo` gets ` -S -p ''` and a quoted heredoc feeds the password; a non-string uuid with a password is the TS `uuid.replace` throw (an empty 500). `Session::run_bash_command` formats the `<bash-input>/<bash-stdout>/<bash-stderr>` block, queues it, and broadcasts it as a synthetic user message (`uuid` = body's or random v4); `send_input` prefixes the joined blocks ahead of the goal reminder and the reminders. `POST /:id/bash` (live sessions only → 404; bad JSON → 400 `invalid JSON body`; a JS-trim-empty or non-string command → 400 `command required`; NUL → 400; `{ok, uuid, stdout, stderr, exitCode, truncated, timedOut}`). Golden: `rust/scripts/bash-golden.mjs` (node@22) records the real TS `BashSession` on 10 scenarios and the real handler + `runBashCommand` on 39 request bodies in order on one session (with a fake `sudo` first on PATH), the 26 broadcast events and the pending prefix; stable over 3 recordings. Tests: `claudius-core/tests/bash_golden.rs` (the scenarios; a timeout kills the whole process group), unit (sudo word bounds, flag injection, the uuid throw, the UTF-16 cap, exit-code parsing, a sentinel split across reads), `claudius-server/tests/bash.rs` (every case, the events, the next prompt's prefix then a bare one; dev-reap kills the shell and its job), `body_semantics`. Deliberate difference: commands still queued at `dispose()` get `BashSession destroyed` (TS never answers them). Mutation 26/27 (the survivor, keeping stray output, is equivalent: the next command's reset wipes it). Flake 0/16 serial + 0/8 parallel. No e2e (the user's app holds `.next-e2e`).
- [x] **S11** Scheduled loops:
  - `trackScheduledLoops`: CronCreate / ScheduleWakeup / CronDelete tool uses and results, with pending→real id promotion
  - `getScheduledLoops`, `hasArmedLoops`
  - `lib/server/loop-keepalive.ts` (the reaper must not reap armed sessions)
  - `lib/server/loop-ticks-db.ts`

  deps: I06 · Accept: fake-CLI cron sequence test; reaper exemption test.
  Split 2026-10-26 (the keep-alive needs cron-parser's next-fire, which the G07 scheduler shares):
  - [x] **S11a** The tracker: `trackScheduledLoops` (CronCreate pending → real id from the result text, CronList `nextFireAt` refresh, CronDelete, ScheduleWakeup arm / supersede / noop streak / `stop: true`, the `result` token attribution) from the live consume, the transcript replay and the JSONL resync; `getScheduledLoops`; the clear in `end()`; `loop-ticks-db.ts` (`recordLoopTick`, `attachLoopTickTokens`, `listLoopBreakdown`). deps: I06 · Accept: a TS-recorded golden of the tracker and DB; fake-CLI cron and wake-up sequence test.
      — done 2026-10-26: new `claudius_core::session_loops` (`LoopTracker`, `SessionLoop` serialized in the TS objects' key order, `LoopEffect`, the `readCronCreateNextFireAt` / `readCronListNextFireAt` / `isScheduleWakeupStop` readers; the job-id regex with V8's `\s` and ASCII-only `/i` folding) and `claudius_core::loop_ticks_db` (`record_loop_tick` with `ON CONFLICT DO NOTHING`, `attach_loop_tick_tokens` once per tick with JS `Math.round` and a floor of 0, `list_loop_breakdown`). `State.loops` is fed from `on_message` (now), `replay_transcript` and `resync_from_disk` (the JSONL time); effects run under the session lock with the session's title; `end()` clears it; `Session::scheduled_loops()` is `getScheduledLoops`. Golden: `rust/scripts/loops-golden.mjs` (node@22) runs the real `trackScheduledLoops` on a bare session (`Date.now` stubbed) and the real DB layer; stable over 2 recordings. Tests: `tests/loops_golden.rs` (DB steps, breakdown, 6 tracker scenarios compared as text so key order counts), unit (`Math.round`, the job regex), `session_fake::the_live_stream_arms_and_cancels_loops` (a session-only cron promoted to `ci42` with its `nextFireAt`, a quiet wake-up with streak 1, the tick with the session's title and the turn's 2 tokens, then stop + CronDelete, then `end()` drops it), `session_fake::resumed_loops_keep_their_arming_time` (JSONL timestamps as `startedAt`, no `nextFireAt` since the SDK reader drops `toolUseResult`, the replayed tick; an appended stop + delete through the resync). Mutation 33/33 (34 mutants; the one equivalent, a redundant object check, was removed). Flake 0/20 serial + 0/4 parallel. No e2e.
  - [x] **S11b** Cron next-fire: `lib/shared/cron.ts` (`validateCron`, `nextFires`, `nextFireMs`, `nextFireAfter`) at cron-parser 5.5.0 parity, local time zone and an explicit `tz`, DST included. `describeCron` (cronstrue) stays out unless a ported route needs it. Accept: a golden recorded from cron-parser over many expressions × start dates × zones.
      — done 2026-10-26: new `claudius_core::cron`, a port of cron-parser 5.5.0 (aliases, `H` on mulberry32, `L`, `#n`, JS `Number` field values, the forward `findSchedule` with its DST flags, per-day transition cache and 9 999-step limit, the lazy `L`-weekday throw) and of the luxon 3.7 arithmetic under it. `Zone::Local` (chrono over the system TZif), `Zone::Tz` (jiff 0.2 on the system tzdb; chrono-tz was dropped because its rules stop DST after 2099), `Zone::Fixed` (luxon `utc±H[:MM]`, `Intl` `±HH[:MM]`, U+2212). Golden: `rust/scripts/cron-golden.mjs` (node@22, re-run per zone with `TZ`, `Math.random` / `Date.now` stubbed): 140 expressions × 15 starts × 7 zones, 29 `H` forms × 6 pinned randoms, 109 `nextFireAfter` cases, stable over 2 recordings. Tests: `tests/cron_golden.rs` (6, including a child process per zone through `Zone::Local`), unit (the `Date.UTC` overflow round trip, `utc`/`gmt` as luxon's fixed zone). Mutation: 62 of 67 killed. The new duplicate-`0`, `0-7,1` and future-anchor cases and the `utc`/`gmt` test killed 4 earlier survivors. 4 equivalents were removed as dead code: `set`'s day clamp, `plus_ms`'s `fixOffset` re-resolve, `#` in the weekday chars, the `L` field check. 1 equivalent is kept: `nearest_after`'s `>` vs `>=`, since every caller checks `contains(current)` first. No e2e.
  - [x] **S11c** Keep-alive: `loop-keepalive.ts` (`isLoopArmed`, `hasArmedLoop`), `Session::has_armed_loops`, and the reaper re-arming instead of reaping an armed session. deps: S11a, S11b · Accept: TS-recorded golden of `isLoopArmed`; reaper exemption test.
      — done 2026-10-26: new `claudius_core::loop_keepalive` (`LOOP_TICK_GRACE_MS`, `LOOP_KEEPALIVE_MAX_MS`, `is_loop_armed[_in]`, `has_armed_loop[_in]`; a one-shot cron's first fire in the process zone, like TS). `Session::has_armed_loops(now)`, evaluated outside the state lock. The idle reaper re-arms after the pending-prompt check, as in TS. `SessionManager::reap_ms_override` is a test hook with no 5 s floor. Golden: `rust/scripts/keepalive-golden.mjs` (`TZ=America/New_York`): 24 loops at the edges of grace, cap, fire time and first fire, 373 checks, plus 6 `hasArmedLoop` lists, stable over 2 recordings. Tests: `tests/keepalive_golden.rs` (2), `session_fake::an_armed_loop_keeps_an_unwatched_session_alive` (200 ms window: the idle session is reaped, the armed one survives past 1 s, `stop: true` lets it be reaped and its loops are cleared; flake 0/15). Mutation 14/14 (keep-alive edges, the reaper branch, `has_armed_loops`). No e2e.
- [x] **S12** Recap: `requestRecap` + `lib/server/session-recap.ts` (326) + `POST /:id/recap`. deps: A08
  — done 2026-10-26:
    - New `claudius_core::session_recap`:
      - `extract_transcript_tail`: 4 000 UTF-16 units, newest first; tool results, synthetic and subagent turns skipped by JS truthiness; JS `trim`.
      - `cap_recap`: the 60%-of-budget space cut, JS `trimEnd`.
      - `recap_prompt`.
      - `generate_recap`: `Query::spawn_prompt` with `persistSession: false`, `maxTurns: 1`, a deny-all `can_use_tool` ("Recap mode cannot use tools."), `permissionPrompts: "none"`, `permissionMode: "default"`, `verbatimPrompts`, the session's model, account env and CLI. Top-level assistant `text` blocks are concatenated, `\s+` collapsed, trimmed and capped. It runs under a `CancellationToken`.
    - `Session::request_recap(origin)`:
      - The gates in TS order: `running` (a turn waiting on the user still gets one), the 60 s `rate_limited` window, `sessionRecapEnabled === false` → `disabled`, `no_history`.
      - The slot is claimed before the query, and an older recap is superseded.
      - It broadcasts `session_recap {type, text, at, origin}` or `session_recap_error {type, reason[, message]}`; a cancelled one sends nothing.
      - An `sdk` event without a message (where TS throws) is logged, not broadcast.
    - `send_input` cancels the in-flight recap.
    - `POST /:id/recap`: 404 for a session that isn't live; `origin` is `"manual"` only when it says so; 202 `{ok: true}`, with the work spawned.
    - Golden: `rust/scripts/recap-golden.mjs` (node@22) runs the real `extractTranscriptTail` and `capRecap`, and the real `generateRecap` through a loader shim that only adds the fake CLI's path.
      - 18 buffers, 30 cap cases (including NEL/BOM `trimEnd` and the whole-number 60% boundary), and 13 fake-CLI runs, normalized like `golden-wire.mjs`: outcome, argv, env, stdin.
      - Outputs are recorded without lone surrogates, plus their JS length.
      - Stable over 2 recordings.
    - It showed that TS never reports `aborted` (the SDK's abort errors aren't `AbortError`s), which `requestRecap` hides behind its `signal.aborted` check.
    - Tests:
      - `tests/recap_golden.rs` (4: tails, caps, constants, wire).
      - Unit: UTF-16 cuts, collapse, a cancelled recap spawning nothing.
      - `session_fake`: `a_recap_reaches_every_tab_once_per_window`, `a_new_turn_cancels_the_recap_and_a_running_one_refuses_it`, `a_failed_recap_says_why`, `a_recap_runs_while_a_prompt_waits`.
      - `claudius-server/tests/recap.rs`: 404, 202, 7 `origin` bodies, `rate_limited`, `disabled` and a non-`false` value.
    - Mutation 57/57. Two equivalents were removed before the run: the early `is_cancelled` return, since the biased `select!` already covers it, and TS's `!tail.trim()` check, since a counted turn always leaves a line.
    - Flake 0/15 (`session_fake` recap) and 0/10 (route).
    - Also: the http test's 501 example moved from `recap` to `account`, and the S14 recorder's literal invisible whitespace became `\u` escapes (its fixture is byte-identical).
    - No e2e.
- [x] **S13** Rewind: `rewindFiles` + `POST /:id/rewind`; the `resumeSessionAt` path in `start()`. The route's 503 for a body that isn't JSON carries V8's `JSON.parse` message (A14). deps: A14 · Accept: fake-CLI rewind round trip.
  — done 2026-10-26 (background agent): `POST /:id/rewind`, `Session::rewind_files` (TS `rewindFiles`: "no active query" without a query) and the `resumeSessionAt` path in `start()`. The route reads the query directly like TS:
    - 404 `session not found` before the body is read (`sessionManager.get`, so a reaped session on disk isn't resumed);
    - a body `JSON.parse` refuses → 503 with V8's message (`JsonBody::parse_or_message`, A14; no body at all is "Unexpected end of JSON input");
    - 400 `userMessageId required` unless a non-empty string;
    - 503 `session not active` without a query;
    - `dry_run` only for `dryRun === true`;
    - 200 `{result}` re-printed with `js::stringify`;
    - the SDK's error as 503 (e.g. "Query closed before response received" once the CLI exited).
  `start()` was verified against the real TS `Session.start()`: the replay is cut after the first message whose uuid matches, an unknown / sidechain / differently-cased uuid keeps the whole replay, and the flag is passed either way. Fixed: an empty `resumeSessionAt` is now unset like TS's `this.resumeAt ?` (no slice, no `--resume-session-at=`). `QueryHandle::rewind_files` takes `Option<bool>` (None omits `dry_run`, as the SDK drops `undefined`). `rust/scripts/rewind-golden.mjs` records the real TS: `Session.prototype.rewindFiles` on an SDK query against the fake CLI (11 cases / 22 calls); the route handler (98 cases in 11 groups, including raw-byte bodies, no body, no query, an exited CLI); and the real `new Session({resume, resumeSessionAt}).start()` over a recorded transcript (9 resumes). It is byte-identical across recordings and on re-record, ASCII-only and lint clean. Tests:
    - `claudius-core/tests/rewind_golden.rs`: every control call's outcome and the `rewind_files` request byte for byte, no query, after `end()`; every resume's replayed uuids and `--resume*` argv.
    - `claudius-server/tests/rewind.rs`: the fake-CLI rewind round trip; 98 route cases on the real binary, 97 byte for byte and 1 listed gap; a transcript on disk isn't resumed; other methods 405.
  Mutation 31/33. The 2 survivors are equivalent: slicing on an empty `resumeSessionAt`, and first vs last uuid match. The SDK's chain walk `_Te` only follows a truthy `parentUuid` and stops on a repeated uuid, so a `""` uuid can only be the leaf and the chain never holds duplicates. Flake 20/20. No e2e: no spec reaches the backend's `/rewind`. `cc-parity-2.1.295-fork-trailing-bubble` and `sdk-update-0.3.216-rewind-skipped-links` stub it with `page.route`, `cc-parity-2.1.191-cleared-from-banner` is the slash-command banner, and the user's app holds `.next-e2e`. Merged from the parallel clone; main-tree gate green.
- [x] **S14** Transcript and search: `GET /:id/transcript` and `GET /:id/search`. The query must be escaped, never compiled as a regex (CLAUDE.md ReDoS rule). Accept: http tests, including regex metacharacters.
  — done 2026-10-26 (background agent, merged by the loop): new `claudius_server::session_transcript`.
    - `GET /:id/transcript`:
      - The query is read like `URLSearchParams.get`: first pair wins, form-decoded, and `before` / `dir` treat "" as absent.
      - `limit` is `Math.min(200, Math.max(1, Number(x ?? "50") || 50))` through the new `js::to_number`, kept fractional (`slice` truncates `start`; `hasMore` is `start > 0`).
      - `dir` falls back to the live session's cwd.
      - An unknown `before` → 400 `before uuid not found`.
    - `GET /:id/search`:
      - A JS-trim-empty `q` answers `{hits: []}` before any read.
      - Only user and assistant turns are searched.
      - The match is a literal `indexOf` on UTF-16 units of the JS-lowercased text, never a regex. The index is applied to the original text, so `İ` shifts the window as in TS.
      - Snippet: ±60 units, JS-whitespace `\s+` collapse, `…` on each open side.
      - A turn with a missing or null `message`, or a null content block or tool_result part, gives Next's empty 500.
      - The JSON is written by hand, so a snippet edge that splits a surrogate pair prints `\udXXX` like `JSON.stringify`.
    - Shared readers:
      - `sessions_store::stringify_content` now matches the TS (`String(c.name)`, `JSON.stringify(input ?? {}, null, 2)` in JS key order and number format, `p.text ?? ""`), over a new `try_stringify_content` that reports where the TS throws.
      - `sessions_store::messages` now decodes invalid UTF-8 as U+FFFD, like the SDK, instead of returning `[]`.
    - Golden: `rust/scripts/transcript-golden.mjs` (node@22) runs the real route handlers on 132 cases over 10 transcripts, storing the raw transcript bytes; stable over 2 recordings.
    - Tests:
      - `claudius-server/tests/transcript_search.rs`: every case byte for byte against the real binary; ReDoS patterns over 100k `a`s answer fast; 9 metacharacter queries match only literally; POST → 405.
      - 7 unit tests.
    - Mutation 67/68: the survivor, search reading system messages, is equivalent because the loop skips non-turns. Flake 0/25 serial, 0/12 parallel. No e2e.
- [x] **S15** MCP per session (split 2026-10-26 into S15a, S15b; both done 2026-10-26):
  - `mcpServerStatus`, `reconnectMcp`, `toggleMcp`, `setMcpServers` (`POST /:id/mcp-dynamic`), `recheckMcpStatusMidSession`
  - startup notices `noteMcpNeedsAuthAtStartup` / `noteMcpDisconnectedAtStartup` (`mcp-needs-auth-db.ts`, `mcp-disconnected-db.ts`)

  deps: A01
  - [x] **S15a** The session's MCP controls: `mcpServerStatus`, `reconnectMcp`, `toggleMcp`, `setMcpServers` (session.ts ~6249), the `mcp-delta` reminder they queue (`McpDelta`, `mcpDeltaReminderBody`, ~605), and `POST /:id/mcp-dynamic` (404, 400 "servers object required", 503 with the error, 200 `{result}`). The global `mcp/[name]/{toggle,reconnect}` routes that fan out to these are G03. deps: A01 · Accept: fake-CLI round trips of the four control calls, the reminder text on the next turn, and the route's statuses on the real binary.
      — done 2026-10-26: `claudius_core::mcp_delta` (`McpDelta`, `mcp_delta_reminder_body`, `set_servers_delta`), `Session::{mcp_server_status, reconnect_mcp, toggle_mcp, set_mcp_servers}` and `POST /:id/mcp-dynamic`. `rust/scripts/mcp-delta-golden.mjs` runs the real TS (`mcpDeltaReminderBody`; the `Session.prototype` methods on an SDK query against the fake CLI with a stand-in `claudius_goal`; the route handler): 37 deltas, 57 control cases (71 calls), 64 route cases, byte-identical across recordings. Tests: `claudius-core/tests/mcp_controls.rs` (the bodies; the reply filter without a CLI; every control case on a real Session: outcome, the `mcp_*` request byte for byte, the next turn's reminder and its drain, no query, after `end()`) and `claudius-server/tests/mcp_dynamic.rs` (64 route cases on the real binary, including a server whose CLI never starts for `no active query`: 61 byte for byte, 3 listed gaps). `Query::mcp_server_status` now returns `Null` without `mcpServers` (the SDK's `undefined`); `Query::set_mcp_servers` mirrors the SDK's `null`-entry TypeError and its `__proto__` drop. Mutation 31/32 (1 equivalent: the route's lenient `{}` vs `null` fallback, both 400), flake 20/20. Merged from the parallel clone (recorder's literal NBSP/BOM/U+2028/U+3000 escaped, fixture unchanged); main-tree gate green, 271 tests. Follow-up: A15 (serde number text on the wire).
  - [x] **S15b** MCP notices: `noteMcpNeedsAuthAtStartup` / `noteMcpDisconnectedAtStartup` (fire once per session, after init; `mcp-needs-auth-db.ts`, `mcp-disconnected-db.ts`), and `recheckMcpStatusMidSession` with `mcpRecheckDue` (at most once per 30 s). deps: S15a
      — done 2026-10-26 (background agent): new `claudius_core::mcp_notices`. `mcp_recheck_due` is `now - lastAt >= intervalMs` (NaN never due). `servers_in_status` takes the entries whose `status` is exactly `needs-auth` / `failed`, a non-string `name` as `"unknown"`, order and duplicates kept; a reply that isn't a list syncs nothing. `sync_needs_auth_notifications` / `sync_disconnected_notifications` run one transaction: forget the announced servers that left the status, announce and record the rest at `now`. Without a database they fail open, so every due check announces again; a database without the tables announces nothing; foreign NULL / BLOB rows behave as in better-sqlite3. Session wiring: on the first live `system/init` (started before the init is broadcast, as TS does inside `broadcast()`), both `mcp_status` requests go out at once and each check announces as its reply lands. Two replies that land together announce needs-auth first; an unanswered request holds up only its own check; a re-entrant init doesn't check again. At each `result` both checks run one after the other when due. `lastMcpRecheckAt` starts at 0 and is taken before the checks, so a failed check still uses up the window, and a clock that goes back isn't due. The notices reach every open tab and are never replayed. The fake CLI gained `control.<subtype>.$sequence`. `rust/scripts/mcp-notices-golden.mjs` runs the real TS (`mcpRecheckDue`; the two sync modules on the real migrations; the `Session.prototype` notes and re-check on a bare session with an SDK query against the fake CLI): 43 due cases, 15 db cases (62 steps), 13 session cases (18 sessions, 55 steps), byte-identical across two recordings. Tests: `claudius-core/tests/mcp_notices.rs` (every recorded case: return values, both tables' rows after each step, the notices, the `mcp_status` wire byte for byte; plus the real clock through the manager, every tab once with no replay, an unanswered request, racing first opens) and `fake_cli::control_sequences_answer_in_turn`. `mcp_controls` now waits out the two startup checks before its live calls (TS recorded those on a bare session), and `mcp_dynamic`'s wire filter leaves out the session's own `mcp_status` (checked against the fixture). Flake fix in the shared `db.rs`: two threads making the first `open_db` on a cwd at once each opened and migrated the file, so the loser's open failed ("database is locked", "duplicate column name: goal") or kept a second writer, and the startup sync failed open and announced again (about 1 run in 60 to 100). Instrumented over 160 runs: 1479 second connections and 1034 failed opens before, 0 after. First opens now go one at a time behind a double-checked cache: one connection per (mode, cwd), like TS's one handle. Differences: the checks run on a tokio task and the sync's transaction blocks a worker thread briefly; one clock stamps both the window and `notified_at`. Mutation 49/49 (3 on `db.rs`), flake 0/60 serial (20 rounds × mcp_notices, mcp_controls, mcp_dynamic) and 0/260 at 4× parallel. No e2e: `cc-parity-2.1.193-mcp-needs-auth-notice` and `cc-parity-2.1.273-mcp-disconnected-notice` stub the session stream in the browser, and the user's app holds `.next-e2e`. Recorder ASCII-only, fixture unchanged on re-record, eslint clean. Merged from the parallel clone; main-tree gate green (309 tests).
- [x] **S16** Usage extras: `getWeeklyUsedSkills` (fills `weeklyUsedSkills` in `/context`), `getUsageBehaviors`, `fetchFullUsage`, `GET /:id/usage-behaviors` (resume). deps: A01
  — done 2026-10-26: new `claudius_core::usage_behaviors`. `extract_usage_behaviors`: `behaviors.{day,week}` each an object or array (an array is an empty window), else `None`; `requestCount` / `sessionCount` a number as is, else 0; entries kept only for the 9 `USAGE_BEHAVIOR_COPY` keys with a numeric `pct`, as `{key, pct, count}` (`count` else 0). `extract_weekly_used_skills`: `behaviors.week.skills[].name` when a non-empty string, unless its `pct` is a number not above 0; order and duplicates kept. `with_weekly_used_skills`: the route's `{...data, weeklyUsedSkills}` through `js::entries` (an existing key keeps its place). `FullUsageMemo` (`fetchFullUsage`): one `get_usage` scan without `skip_behaviors` per query, keyed by the new `claudius_agent::QueryId` (a `Weak` identity, so it never keeps a CLI's stdin open), shared in flight and for 30 s after it succeeds (wall clock, like `Date.now`); a failure reaches its waiters but is never reused; the scan runs on its own task, so a dropped caller doesn't cancel it. `Session::{get_weekly_used_skills, get_usage_behaviors}`, `GET /:id/usage-behaviors` (resumes; `{behaviors}`, `null` still a 200) and `weeklyUsedSkills` on the full `/context` fetch; both routes print with `js::stringify` (the summary `/context` too). Tests: `tests/usage_behaviors_golden.rs` replays 106 usage responses and 19 context bodies × 4 `weeklyUsedSkills` values recorded from the real TS by `rust/scripts/usage-behaviors-golden.mjs` (stable across two recordings), byte for byte; the memo's unit test ports the TS session tests; `session_fake::usage_extras_share_one_full_scan`; `claudius-server/tests/usage_behaviors.rs` (404, bodies byte for byte with `1e+21` / `1.0`, summary vs full `/context`, one scan for both overlays, resume from disk). Mutation 33/33 (one redundant filter in `extract_usage_behaviors` removed first); flake 0/20 each. No e2e: `cc-parity-2.1.299-usage-behaviors` stubs the route with `page.route`, and the user's app holds `.next-e2e`. Main-tree gate green, 271 tests.
- [x] **S17** Historical usage estimate in `seedUsageBaseline` when no usage row exists: `lib/server/litellm-pricing.ts` (374) and `model-pricing-override.ts` (198) pricing table. Accept: resume of a transcript with no usage row reproduces the TS numbers (golden values from running the TS helper).
  — done 2026-10-26. Correction: `seedUsageBaseline` prices with `lib/shared/cost-pricing.ts`, not the LiteLLM table or the model-pricing override, which only the Cost page uses (D18). New `cost_pricing.rs`: the `Pricing` table, `price_for` (lowercased substring markers in the TS order, newer generations first, Sonnet for anything else), `cost_from_tokens` (summed in the TS order, then `/ 1e6`), `inference_geo_multiplier`, `MODEL_PRICING_MULTIPLIER_MAX`. New `usage_seed.rs`: `estimate_usage` (assistant records with truthy `usage`, keyed by `message.id ?? uuid`, falsy keys skipped, deduped with `Set` semantics (numbers by value, objects never equal), cache writes priced at the 5-minute rate, `None` without a turn) and `seed_usage_baseline` (the persisted row wins; otherwise the estimate, saved best effort). `replay_transcript` now returns the loaded records for it. Fix: `save_session_usage` rounded half away from zero and saturated through `i64`; it now binds JS `Math.round` as a REAL (`loop_ticks_db::math_round`, reused), as better-sqlite3 does. Tests: `tests/usage_estimate_golden.rs` replays 39 `priceFor` ids, 429 costs (including sums whose rounding depends on the addition order), 12 geo values and 31 seeds through the real `Session.prototype.seedUsageBaseline` (`rust/scripts/usage-estimate-golden.mjs`; a JSONL-text case pins number ids `1` / `1.0` / `1e0` and 2^53 + 1 parsing equal), with the `session_usage` row read back, all byte for byte; `session_fake::a_legacy_transcript_seeds_the_usage_estimate`. Mutation 34/34 on the final code, one of them an `f64::round` swap (the `-0` branch was removed: an INTEGER column stores `-0` as `0`); flake 0/20. No e2e: no spec covers a legacy resume's cost.
  — follow-up 2026-10-27 (usage accounting fix, TS commits 191008d9 + a79c2c60 on main; the same two applied uncommitted to this tree's `lib/` and `tests/unit/`): the TS fold misread the SDK result's PER-TURN `num_turns` as a running total, so every turn with fewer round-trips than the last looked like a `/clear` and re-banked the whole running cost (one 1.5-day session read $12,081 against ~$726 real; the Rust fold was a faithful port of the bug). Fixed in both:
    - `sessions_db::fold_result_into_usage(totals, last, message)`: `num_turns` / `duration_ms` summed; `total_cost_usd`, `modelUsage` and `duration_api_ms` are process-cumulative, so only their growth past `last` (`SdkCumulative`) is added. Only a cost DECREASE is a reset. `reconcile_baseline_on_first_fold` and `UsageTotals::add` are gone; the session holds `usage_totals` + `sdk_last_cumulative`.
    - New `sdk_cost_state::last_recorded_cost_state(id, cwd)` (`lib/server/sdk-cost-state.ts`): the last valid `{"type":"cost-state"}` record for the resumed id, mirroring the CLI's own schema check. A resumed CLI restores it and re-reports it as its starting "cumulative", so it seeds `sdk_last_cumulative`.
    - `usage_seed`: `estimate_usage_from_transcripts` replaces `estimate_usage(historical)` — every API call in `<resume>.jsonl` AND `<resume>/subagents/**/*.jsonl` (depth 4, no symlinks, UTF-16 sorted), deduped by `message.id:requestId`, priced with `cost_pricing` (the record's `costUSD` wins; the 1h cache-write share at its own rate; × the US premium); `numTurns` counts main-thread calls. The old read of the post-compaction message chain seeded a long session near $0. `seed_usage_totals(cwd, id, resume)` saves it under the session's own id (a fork estimates its source).
    - Migration 025 (TS) deletes every `session_usage` row: they can't be repaired, and each session re-seeds on its next start. build.rs embeds it.
    - Tests: `usage_estimate_golden.rs` now replays 35 seeds (files written under the project root, incl. subagent/workflow nesting, depth limit, symlink, BOM/CRLF/invalid UTF-8, checkpoints) through the real `seedUsageBaseline()`, 13 fold sequences (36 steps) through the real `foldResultIntoSessionUsage`, and 10 `lastRecordedCostState` ids; `session_fake::a_legacy_transcript_seeds_the_usage_estimate` resumes with a subagent transcript and a $5 checkpoint, then folds $5.50 / 3 turns and $5.75 / 1 turn (+$0.50, +$0.75; no reset). Mutations caught: subagents dropped, checkpoint not seeded, cumulative cost added whole. Gate green in the COST clone.
- [x] **S18** Compaction: `compact_boundary` handling in consume; track `recentReadPaths` from Read tool uses; `reseedReadPathsAfterCompact` via `seed_read_state`. deps: A01, I06
  — done 2026-10-26: new `read_paths.rs`. `extract_read_paths` (`read-tool-paths.ts`): the non-empty string `file_path` of each `tool_use` block named exactly `Read` in an assistant message's `message.content`, in order with repeats; any other shape gives nothing. `floored_mtime_ms`: `Math.floor(stat.mtimeMs)` from Node's double `sec * 1e3 + nsec / 1e6`, which floors up a few nanoseconds short of a second, where integer math wouldn't; before the epoch, a floor split. The session keeps `recent_read_paths` (an `IndexSet`, so first-read order, never pruned; G08's `notifyMemoryUpdate` reads it) from every live message. A `system` `compact_boundary` spawns `reseed_read_paths_after_compact` off the consume loop. It walks the live set by index, so a path Read mid-pass is still visited, as JS `Set` iteration would. It stats each path (a failure skips it) and sends `seed_read_state(path, mtime)` (a refused seed or a missing query skips it). Tests: `tests/read_paths_golden.rs` replays 30 message shapes through the real `extractReadPaths` (`rust/scripts/read-paths-golden.mjs`, stable across two runs); a unit test for the mtime (the round-up boundary, before the epoch); `session_fake::a_compaction_reseeds_every_read_path` (dedupe, order, a non-`system` subtype ignored, a deleted file dropped, the set growing across compactions, every seed refused) and `session_fake::a_read_during_the_reseed_pass_is_seeded_too`. Mutation 16/16; flake 0/20. No e2e: the re-seed has no UI.
- [x] **S19** Thinking replay recovery: `lib/server/thinking-replay-recovery.ts`, `scheduleThinkingReplayRecovery`, `runThinkingReplayRecovery`, `getRebuildOpts` (rebuild the query with identical options). deps: I06
  — done 2026-10-26: new `thinking_replay.rs`: `is_thinking_replay_error_text` (lowercased: "thinking" and "cannot be modified", plus "redacted_thinking" or "latest assistant message"), `extract_message_text`, `thinking_replay_error_from` (only an `assistant` record) and `plan_thinking_replay_recovery` (anchor = latest assistant with a thinking / redacted_thinking block, else the latest assistant; prompt = the last real user prompt before it, by `extract_user_prompt_text`; resume at the last assistant with a non-empty string uuid before that prompt; `None` if any step finds nothing). Session wiring: `on_message` checks each live message before the broadcast and, after it, schedules the recovery once per session object (`thinking_replay_recovery_scheduled`): the "auto-recovering" error goes to every tab, then a tokio task reads the transcript, plans, and asks the manager for `recover_in_place(id, resume_at, prompt)`. The manager carries `getRebuildOpts` (cwd, live model, agent and permission mode over the original options, with id / resume / resume-at cleared), allows 3 attempts in a row per id (reset by a successful `result` through `note_thinking_recovery_success`), removes the session and creates its replacement under the same id with `resume` + `resume_session_at`, then re-sends the prompt. Each failure reports TS's message (no safe rewind point, gave up after repeated failures, could not rebuild, `Auto-recovery failed: …`). The session holds a weak handle to the manager that created it (falling back to the global one). Also `restart_in_place(id)` (same rebuild, no rewind, no attempt count) for the manager's own callers. `rust/scripts/thinking-replay-golden.mjs` runs the real TS module: 18 error texts, 14 message texts, 18 records, 32 transcripts; byte-identical across two recordings. Tests: `tests/thinking_replay_golden.rs` (4); `session_fake`: `a_thinking_replay_error_rebuilds_the_session_in_place` (rewinds to the safe point with the live model / agent / mode, re-sends the prompt, drops the poisoned turn from the replay; gives up after 3 in a row; a successful turn resets the count), `a_thinking_replay_error_without_a_safe_point_is_reported`, `rebuilds_in_place_keep_the_id_and_settings`. Found while testing: the slow JSONL-watcher start made every resume take seconds (S01b). Mutation 32/32 (with S01b's). Differences (PORT_PLAN): the transcript read error's wording, a non-string truthy uuid, the gone / create-failure messages unexercised. No e2e: no spec drives the 400, and the user's app holds `.next-e2e`.
- [x] **S20** Detectors and notices: `opus-overload-detector.ts`, `long-context-credits-detector.ts`, `auth-failed-detector.ts`, `token-expiry.ts` (`noteTokenExpiringAtStartup`). These are the `note*Observation` calls in consume. deps: I06
  — done 2026-10-27 (background agent): `detectors.rs` ports `opus-overload-detector.ts`, `long-context-credits-detector.ts`, `auth-failed-detector.ts` and `token-expiry.ts` (the text and message predicates, `isOpusModelId`, `shouldWarnTokenExpiring`) plus session.ts's `noteOverloadObservation` / `noteLongContextCreditsObservation` / `noteAuthFailedObservation` / `noteTokenExpiringAtStartup`, as a `Nudges` state on `State`. Hooks:
    - `on_message` (live only) runs the three notes after the `sdk` broadcast, then the `result` resets.
    - consume's `Err` arm runs the overload and auth text tests on the thrown message after the `error` event (TS's catch; no billing note there, as in TS).
    - `State::broadcast` runs the token check on a live `system/init`, so the nudge is buffered after the init but fanned out before it, the TS order.
  Events byte for byte: `opus_overload_nudge {model, count}`, `long_context_credits_required {model}`, `auth_failed_required {model, reason?: "oauth_revoked"}`, `token_expiring_required {expiresAt}`. Behaviours found and mirrored:
    - A nudge fires on the turn's first signal (the assistant 529), not at the result.
    - The overload streak counts at most once per turn and keeps counting after the nudge fired and on non-Opus models, so switching to Opus mid-streak fires with count > 2.
    - Any `result` ends the turn, but only `success` clears the streak. A `success` with `api_error_status: 529` is no signal.
    - `oauth_org_not_allowed` is no auth failure.
    - The first live init uses up the token check even when it doesn't warn, and a replayed init doesn't.
    - An in-place rebuild is a new session object, so the fire-once flags re-arm, as in TS.
    - TS's `isFinite` check is redundant (the range test already rejects non-finite values) and is dropped.
  Differences: `enable1mContext` is read as `== Some(true)` where TS tests truthiness (unreachable: the create route refuses a non-boolean with 400). `activeProfileExpiresAt` is an `Option<f64>` that is always `None` until G02a/S30, so the token nudge never fires today. Rust `to_lowercase` vs JS `toLowerCase`: the Kelvin sign and U+0130 are in the golden and match. Tests: `tests/detectors_golden.rs` replays what `rust/scripts/detectors-golden.mjs` recorded from the real TS modules and the real `Session.prototype.note*` methods: 63 texts, 19 model ids, 75 messages, 45 expiry cases (NaN / ±Infinity / -0 / non-numbers) and 47 sessions (147 steps, 37 nudges; events compared as `JSON.stringify` strings plus the six state fields after every step). The recorder checks every call site, the enclosing if/try/loop path, its order relative to the broadcasts, every write to the nudge fields and the field initializers against session.ts's AST, so a TS change breaks the recording; it runs twice and the runs must match byte for byte. `session_fake` covers:
    - an Opus 529 streak nudging once across two tabs, not replayed;
    - no overload nudge off Opus;
    - billing (1M only) and auth (with `reason`) firing once;
    - a thrown 529 / revoked-token crash nudging right after the `error` event;
    - no token nudge without an account profile.
  A `session` unit test pins the token nudge to the first live init and the buffer/fan-out order. Mutation 71/71 killed (first attempt 66/67 + 7/7; the survivor was the redundant `isFinite` filter, an equivalent mutant, so it was removed and the reshaped function re-mutated). Flake 0/60 (20 rounds × 3 suites). Clone gate 357. No e2e: `cc-parity-2.1.204-token-expiring-notice` stubs `EventSource` in the browser and `sdk-update-0.3.187-subagent-permission` serves its stream through `page.route`, so neither reaches the backend; no spec drives a live 529/401/billing error. Merged from the parallel clone.
- [x] **S21** Reminders: `flushLinterModifiedReminder` (linter-modified files), and an audit of every `queueMidTurnReminder` / `takeMidTurnReminders` source against `system-reminders.ts`.
  — done 2026-10-27 (background agent): new `claudius_core::reminders`:
    - `wrap_reminder`.
    - `ReminderQueue`: one channel (`queueReminder` / `takePendingReminders`, or the mid-turn pair); FIFO, no dedupe, `None` when empty. TS's debug-only kind isn't kept.
    - The linter-modified-file reminder: `postWriteSnapshots` as an `IndexMap` in first-write order holding the last write's sha256, `post_write_target`, `flushLinterModifiedReminder` and `linterModifiedReminderBody`.
    - The date-change helpers: `localDateKey`, and `toDateString` with years under 1000, 0, negative and past 9999.
  Session changes:
    - The PostToolUse hook hashes the target of Edit/Write/MultiEdit/NotebookEdit: a string `file_path`, else a string `notebook_path`. An empty path or an unreadable file is skipped, and a failed read keeps the earlier hash.
    - `sendInput` flushes at TS's spot, in the order date-change → ultrathink → midturn-inject → linter-modified-file → stale-todowrite, after the reminders queued earlier (todos-current, verify-plan, plan-mode-reentry, auto-mode-exit, mcp-delta).
    - Slash commands neither flush nor drain; a mid-turn prompt flushes too.
    - Unchanged bytes give no reminder. A file deleted or unreadable at the flush is skipped and dropped. The map is cleared on every flush.
  Audit of every reminder source:
    - OK: date-change, midturn-inject, stale-todowrite, auto-mode-exit, mcp-delta ×3 (S15a), verify-plan.
    - Ported: linter-modified-file.
    - Gap: memory-update (G08).
    - Fixed, ultrathink-prose: JS `\b` and `/i` are ASCII-only, so `éultrathink` matches and `ultrathinK` doesn't.
    - Fixed, todos-current: TS queues it before serving anything else. Rust queued it after the idle broadcast, so on the multi-thread runtime a prompt sent on the idle could miss it. It is now queued under the lock that ends the turn.
    - Fixed, plan-mode-reentry: `priorPlan` uses JS `trim` (U+FEFF stripped, U+0085 kept). There is no dedupe, so two re-entries queue two.
    - Fixed, verify-plan: `resolvePlan`'s edited-plan trim and compare now use JS `trim`.
    - todos-stale-midturn (~8631): OK. It uses the mid-turn queue, once per turn, drained into the next PreToolUse `additionalContext`.
    - system-reminders.ts itself: the wrapper, FIFO order, no dedupe, `null` when empty and the separate queues are OK. Its declared-but-unused kinds (stale-task-tools, truncated-read, linter-modified-file-midturn, mcp-delta-midturn) have no producer.
    - Also fixed, PreToolUse's worktree switch: `file_path ?? notebook_path` (a `null` falls through), and JS `.` stops at `\r`, U+2028 and U+2029.
  Differences:
    - The flush hashes under the session lock (TS's `readFileSync` blocks its event loop; same order).
    - The hook's read runs on tokio's blocking pool.
    - The all-done / no-progress `clearTodos` still runs just after the turn-end lock, so a prompt racing it can still name the old list in stale-todowrite.
    - Date-change isn't exercised end to end: there is no clock seam, as in TS.
  Tests:
    - `rust/scripts/reminders-golden.mjs` drives the real TS: the pure bodies, the real queues over two hosts, and the real `Session` on a stubbed SDK `query`. It records 6 wraps, 28 ultrathink texts, 48 date cases, 7 path lists, the fixed bodies and 5 re-entry priors, 28 queue ops and 13 scenarios (243 ops). Two runs are byte-identical, the fixture is unchanged on re-record, the file is ASCII-only and eslint is clean.
    - `tests/reminders_golden.rs` replays the scenarios against the fake CLI, using its new `$fs` step. It checks every user message byte for byte, the hook replies, the plan replies and `cwd_changed`.
    - `session_fake`: a rewritten file rides the next prompt once (same bytes: none); deleted files are skipped, with paths in first-write order; a prompt sent on the idle carries `todos-current` (12 turns, 4 workers).
    - Mutation 39/42. The 3 survivors are justified: the empty-path filter (reading "" fails anyway); `{b:02x}`→`{b:x}` (both hashes come from the same function); date-change never queued (no clock seam; the body and key are pinned by the golden).
    - Flake 0/20. Clone gate 355; main-tree gate with S20 + S21 merged: 367 passed, 0 failed.
    - No e2e: no `tests/e2e` spec greps for `linter-modified` or `system-reminder`. Reminders only ride the model-bound message, never the UI, and TS covers them with unit tests only.
  Merged from the parallel clone.
- [x] **S22** Spinner tips: `mergeSpinnerTipsFile` + `normalizeSpinnerTipsOverride` parity in `select_tips`.
  — done 2026-10-26: new `spinner_tips.rs`. `normalize_spinner_tips_override`: plain objects only; each entry a JS-trimmed non-empty string or `{text, id?, priority?, cooldownSessions?}` (fields kept by type, TS key order), the rest dropped, so index ids follow the normalized list; `excludeDefault === true`; JS-trimmed `label` / `tipsFile`. `merge_spinner_tips_file`: `~/` joined like `path.join` (`..` resolved lexically), absolute only, regular file (through symlinks) ≤ 256 KiB, lossy UTF-8, a JSON array, entries normalized; no usable entry or any error leaves the inline tips; `tipsFile` dropped. `SpinnerTipsConfig` (boolean `spinnerTipsEnabled` plus the merged override, `.tips()` → `select_tips`) is built once in `start()`, outside the lock; subscribe re-sends the cached list. `select_tips` trims with JS `trim()` (U+FEFF stripped, U+0085 kept). Tests: `tests/spinner_tips_golden.rs` replays 127 cases recorded from the real TS source by `rust/scripts/spinner-tips-golden.mjs` (the functions plus `start()`'s `readSettings` / `spinnerTipsConfig` statements and `subscribe()`'s `selectTips` call, read out of session.ts and run with node's type stripping, on real files under a temp HOME): 121 byte for byte at all four stages, 6 listed differences; plus 253 `~/` expansions. A unit test that a pipe is never read; `session_fake::a_spinner_tips_file_reaches_subscribers_read_once_at_start`. Recording stable (two HOMEs per run; two runs byte-identical). Mutation 55/55 on the final code (4 unobservable relative-path branches removed); flake 0/20, session_fake 0/6 whole-binary. No e2e (no spec sets the spinner-tip settings). Merged from the parallel clone; main-tree gate green.
- [x] **S23** Session titles: the legacy title JSON fallback in `lib/server/session-titles.ts` (81); `resolveSessionTitle` at full parity.
  — done 2026-10-26 (background agent): the live fallback is `readLegacyTitle` in `sessions-db.ts`'s `getSessionTitle`. `lib/server/session-titles.ts` has no importer, so its writer (temp file + rename, `version` check, cache) has no Rust counterpart, and nothing writes the file on either side.
    - `sessions_db::get_session_title` now returns the row's title when it isn't empty. TEXT is read as lossy UTF-8 like better-sqlite3; before, a non-UTF-8 title failed the read.
    - Otherwise it calls `read_legacy_title`, which reads `$HOME/.claude/.claudius/session-titles.json`:
      - as lossy UTF-8, where a BOM fails the parse; through `js::json_parse`, with no `version` check;
      - `titles?.[id]` by JS property rules: an object's own key (`__proto__` included), or an array element or a string's UTF-16 unit at a canonical index;
      - the title is kept only if JS `trim()` leaves it non-empty, and is returned untrimmed.
    - That title is copied into the row best effort (`ON CONFLICT(id) DO UPDATE SET title` only; a new row gets the cwd and now).
  New `session_titles.rs`:
    - `resolve_session_title`: moved from session.rs, now JS `trim()`. Rust's kept a BOM and stripped NEL.
    - `start_title`: on resume, the row, else the SDK `customTitle` only without one, and no title at all on a database error (Rust used to fall through to the SDK's); fresh, the row as stored.
    - `fresh_title`: `sendFreshTitle`'s `Moved` / `Echo` / `Quiet`; a database error reads as no row.
  JS `trim()` is also used in `set_session_title`, `Session::rename` and `sessions_store::rename` (the SDK's `renameSession`). TS quirks kept: a whitespace-only row title hides the SDK title on resume and becomes a fresh session's title; a fresh session's untrimmed legacy title is trimmed and broadcast on the first subscribe. Tests: `tests/session_titles_golden.rs` replays 400 cases recorded from the real TS by `rust/scripts/session-titles-golden.mjs` (216 resolve, 93 get, 31 start, 16 fresh, 28 set, 16 SDK rename; stable across the recorder's two runs and on re-record), with 16 fields in 6 cases listed as differences (lone surrogates, 200-deep nesting, BLOB titles). `session_fake::legacy_and_foreign_titles_reach_live_sessions` covers:
    - migration at start;
    - the first subscribe's trim and broadcast;
    - a title another writer stored reaching every open stream with its upsert;
    - the echo after replay;
    - a resumed session's legacy title beating the transcript's.
  `session_fake::rename_matches_the_recorded_ts` replays the 14 recorded `Session.prototype.rename` titles on a live session. Mutation 50/51; the survivor drops the existing `still_subscribed` guard on the echo, which is equivalent because the receiver is dropped with the subscription. Flake 0/20 each. No e2e: no spec seeds a legacy title file or a title written by another process, and the trim fixes only show on BOM- or NEL-edged titles; the user's app holds `.next-e2e`. Follow-up: `getSessionTitlesByCwd`'s legacy map goes with D18/D19/D21. Merged from the parallel clone; main-tree gate green.
- [x] **S24** Notification prefs: `GET/POST /:id/notification-prefs` (the per-session prefs table in `notifications-db.ts`; this table only, the bus is G01).
  — done 2026-10-26 (background agent): new `claudius_core::notifications_db` (the prefs half of `notifications-db.ts`: `get_session_prefs`, `set_session_prefs`, `is_session_muted[_at]`, and the route's `snooze_until`) and `claudius_server::notification_prefs` (`GET/POST /:id/notification-prefs`; the cwd comes from `sessions::resolve_cwd`, now `pub(crate)`: the live session, else the transcript index). Behaviors, all mirrored:
    - An unknown id, or a transcript without a cwd (or with `""`), is 404 before the body is read.
    - GET opens the DB read-only (a cwd that's only read never gets a DB file) and answers `{sessionId, blocked: false, snoozeUntil: null}` without a row.
    - POST reads `req.json().catch(() => ({}))`, then `body.blocked` with no `?.`, so a `null` body is Next's empty 500 (after the 404). Only a boolean `blocked` counts.
    - `snoozeMinutes: null` clears. A finite number > 0 snoozes to `Date.now() + Math.floor(m) * 60_000` in f64 (0.5 min is "now", past 2^53 it rounds, an overflow is Infinity and prints `null`). Anything else is 400 `invalid snoozeMinutes` and writes nothing. JS reads `1e400` as Infinity, so the new `JsonBody::lenient_overflow` turns an overflowing literal into a stand-in instead of failing the whole body.
    - A query that throws (a newer schema without the table) is Next's empty 500.
    - Bodies go through `js::stringify` (`9e+21`, `60000001761562000000`).
    - Rows are read as better-sqlite3 hands them to JS and bound as it binds them, every number as a REAL. So a foreign TEXT / BLOB deadline answers as a string / `{type: "Buffer", data}` and compares through `Number()`; `blocked` is `=== 1` (a REAL 1.0 counts, TEXT '1' and 2.5 don't); and `setSessionPrefs` answers what it bound, not what a TEXT-affinity column stored.
  Golden: `rust/scripts/notification-prefs-golden.mjs` (node@22, temp HOME / CLAUDE_CONFIG_DIR, `Date.now` stubbed, ASCII-only) records 143 route steps (129 requests: the live session whose transcript names another cwd, foreign rows, a schema without the table), 203 snooze sums, and 166 DB-function steps (including a table created with other column types); it is stable over 2 recordings. Tests: `claudius-core/tests/notification_prefs_golden.rs` (3), `claudius-server/tests/notification_prefs.rs` (the route steps on the real binary, byte for byte, on the real clock; GET/POST only), unit (3 in `notifications_db`, 2 in `body`). Differences: none on recorded cases. A body serde_json refuses but `JSON.parse` reads (a lone-surrogate escape, nesting past 128) falls back to `{}` and patches nothing, where TS applies it. `is_session_muted` has no caller until the bus (G01). Mutation 84/85: the foreign-schema steps killed the one earlier survivor (answering the stored row) and exposed `blocked` being bound as an INTEGER, now fixed. The one survivor left is equivalent: `blocked`'s `js_member` → plain `get`, where a `null` body still throws at `snoozeMinutes` on the next line with nothing in between; it is kept because it mirrors the TS property access. Flake 0/20. No e2e: no spec drives the notify menu (`SessionNotifyMenu`) or calls the route; the route is covered by the TS-recorded golden on the real binary, and the user's running app holds `.next-e2e`. Merged from the parallel clone (body.rs 3-way with A14's `parse_or_message`); main-tree gate green.
- [x] **S26** Feedback survey: `maybeOfferFeedbackSurvey` (`feedback-survey.ts`) and `submitFeedback` on the session. The global route is G10. deps: A01
  — done 2026-10-26 (background agent): `feedback_survey.rs` ports `feedback-survey.ts` (`coerceSurveyRate`, `shouldOfferSurvey`, the process-wide `lastShownAt` throttle) and the decision in `maybeOfferFeedbackSurvey`. `FeedbackSurvey` owns the throttle plus a clock and a `Math.random`-like roll; `global()` is shared and `Session::set_feedback_survey` pins it for tests. Session: `sawUserInput` is set in `send_input` before the slash shortcut, the hook runs after every `result` where TS calls it (before the to-do sync and the queue drain), and `submit_feedback(description, surface = None → "claudius", attach_transcript)` sends the `submit_feedback` control request (`false` with no query, an ended one, or a CLI error). Found:
    - Only `is_error === true` blocks; an error subtype with `is_error: false` still offers.
    - The input gates run before `Date.now`, so nothing is read on those paths.
    - The throttle is checked once before the settings read and again before the roll; the roll is drawn only after every gate, and a failed roll doesn't stamp.
    - A clock within 6 h of the epoch never offers.
    - A `null` settings.json drops the nudge (TS throws reading the key, and the catch-all swallows it).
    - The user settings are read like `readSettings` + `JSON.parse` (lossy UTF-8, `js::json_parse`), so invalid UTF-8, a lone surrogate or a `1e400` elsewhere in the file still match.
    - The event is `{type, sessionId, surface: "claudius"}` and isn't replayed to a late tab.
  Differences: the nudge is broadcast in place, where TS broadcasts after an awaited settings read; settings.json nesting past 128 levels counts as `{}` (serde limit; listed KNOWN); the roll draws differ from V8's (RandomState stand-in, cosmetic); the check and the stamp are one locked step. Tests: `tests/feedback_survey_golden.rs` replays 32 rates, 552 decisions (Math.random draws counted), 225 `maybeOfferFeedbackSurvey` steps over 16 scenarios (221 exact including `Date.now` calls; the 4 steps of one body are KNOWN) and 15 `submitFeedback` calls on an SDK query against the fake CLI (wire byte for byte), plus a barrier-pinned "another session shows it between the checks" test. `session_fake` covers:
    - every tab getting the nudge after a prompted turn;
    - no roll for a CLI-reported result with no prompt or an errored turn;
    - the pinned clock holding it for 6 h;
    - no replay to a late tab;
    - `submit_feedback`'s wire, a refusal, an ended and an unstarted session.
  A probe that forced a nudge on every eligible turn across the whole workspace broke no existing test. Mutation 35/36 killed; the survivor removes the first throttle check and is equivalent (it only skips a settings read; the locked check repeats it with the same `now`). Flake 20/20. No e2e: no spec drives the nudge or `/api/feedback` against the backend, `/api/feedback` is G10, and the user's app holds `.next-e2e`. Until G10, a nudge raised by Rust can't be submitted: `/api/feedback` is proxied to Next, which has no live session (409 `session-unavailable`, and the banner shows its failure copy). Merged from the parallel clone; main-tree gate green.
- [x] **S27** `start()` audit. Diff TS `start()` (≈1000 lines) against Rust `start()` line by line, and add every remaining delta as a task in this section. Known so far:
  - `loadDbAgentsForOptions` (→ G05)
  - `buildEnvForProfile` / `resolveAccountProfile` (→ S30)
  - `sweepOrphanedActionableForSession` (→ S31)
  - `createHash` digest use
  - `clearTodos` / `stopTask` / `rewindFiles` calls inside hooks
  - `isWorkflowSizeGuideline` / `isCrossSessionInbound` validation
  — done 2026-10-28 (background agent): audited `start()` (TS lib/server/session.ts 2476–3456 at HEAD 860dd77c, with `build_options`, its hooks, the SDK argv builder and `SessionManager.create`) against Rust, ported the small deltas, and filed the rest as S27a–S27d.
  Behaviors found and fixed:
    - SDK truthiness in `to_args`: an empty-string model, agent, fallbackModel, permissionMode, effort, resume, sessionId, resumeSessionAt, permissionPrompts, managedSettings, debug file or thinking display writes no flag. An empty model can't clash with an empty fallback.
    - JS template-literal number text: `--max-turns=2.5`, `--max-budget-usd=1e+21`, `0.000001`, `Infinity`, `--task-budget=NaN`. A fractional `maxTurns` or `taskBudgetTokens` is no longer truncated (`Options.max_turns` / `task_budget_total` are now `f64`). `--max-turns` is written only for a truthy count.
    - A fallback model equal to the model makes the SDK's `query()` throw synchronously, so TS `start()` rejects and `create` fails with route 500 `{error, name: "Error"}`. Rust used to broadcast an error on a live session. Now `AgentError::InvalidOptions` fills D10a's `start_error` slot with `("Error", message)`, and `create` fails through D10a's `CreateError::Threw`: the session is ended, dropped from `starting`, and every joiner gets the same name and message.
    - A CLI that can't be spawned (missing binary): TS still broadcasts `ready`, then the stream's `error`, then `turn_status: idle`, and later subscribers still get `ready` (`this.query` stays set). Rust used to broadcast only the error. It now matches through `spawn_failed()`, which mirrors consume()'s end, with `has_query` kept true.
    - Empty `fallbackModel` dropped from `ready`, both at start and in subscribe's re-emit.
    - Joined system-prompt appends and `planModeInstructions` are trimmed with JS `trim` (`js::trim`: a BOM is stripped, NEL is not).
    - `projectConfigRoot`: `trusted_cwd::project_config_root_for` was never called. A worktree cwd now passes its trusted root.
    - Forwarded settings: `workflowSizeGuideline` accepts only `unrestricted|small|medium|large` (was `small|medium|large|unlimited`), and `crossSessionInbound` only `accept|hold|refuse` (was any string or bool). The blob goes through `js::stringify`.
    - `promptSuggestions`: `(promptSuggestionEnabled ?? promptSuggestions) !== false`, so a null `promptSuggestionEnabled` falls back to `promptSuggestions`.
    - Fable advisor clear: an empty `advisorModel` is no advisor (no clear, no `advisor_disabled_on_model_change`), at start and in `enforce_advisor_model_compatibility` (PostModelSwitch hook and init). The `delete` key order (`shift_remove`) and the `JSON.stringify(next, null, 2)` write text arrived with D10a; the golden's `settingsAfter` checks them against the TS.
    - Resume replay: an unreadable transcript replays nothing and broadcasts nothing (the SDK's `getSessionMessages` returns `[]`). Rust used to broadcast "Failed to load session history: Permission denied (os error 13)". Invalid UTF-8 is decoded lossily; Rust used to fail and replay nothing.
    - Cwd preflight: the errno text is libuv's name from `binary::errno_name`, with `UNKNOWN` when it has none. A 300-character name now says `(ENAMETOOLONG)`; Rust used to say `(unknown error)`.
  Rebase onto D10a (2026-10-28): both branches made a failed `start()` fail `create`. Unified on D10a's mechanism: S27's `start_error: Option<String>`, its second `take_start_error()` and its `CreateError::Start` path were dropped; `InvalidOptions` writes D10a's `(name, message)` slot. D10a's `write_settings` and `shift_remove`s were kept over S27's identical-in-effect versions, so S27e (settings writers' delete order) is already fixed by D10a and is not filed. The golden's `threw` field now records `{name, message}` the way the create route's catch reports it, and both create tests check `name() == "Error"` (including a joiner). Merged from the parallel clone (rebased onto main by the merge loop: kept G05's `load_db_agents_for_options` line at the `build_options` call, emptied the golden's `KNOWN` list now that G05 is in, and changed G06's `models.rs` `max_turns: Some(1)` to `1.0`).
  Audit (Rust lines are the clone's `crates/claudius-core/src/session.rs` unless noted):
  | TS lines | Statement / block | Rust | Status |
  |---|---|---|---|
  | 2477 | `if (this.query) return` | 1606 | OK |
  | 2489–2498 | `validateWorkspaceCwd` preflight | 1609, `validate_workspace_cwd` 4331, `errno_name` 4355 | FIXED (errno names) |
  | 2499–2503 | `readLimits` → `toolBudgetLimits` | 1613 (`read_tool_budget_limits`) | OK (the cap's use in canUseTool → S27b) |
  | 2518 | `sweepOrphanedActionableForSession` | — | KNOWN (S31) |
  | 2530–2568 | `todosClearedAt` seed, manual overrides read | 1618–1636 | OK (S07b) |
  | 2578–2690 | replay: `getSessionMessages`, `resumeAt` cut, `at`/`carriedAt`, `trackScheduledLoops`, catch → error event | 1637–1641, `replay_transcript` 1940 | FIXED (unreadable / invalid UTF-8); `Date.parse` → S27c |
  | 2691–2708 | title reads | 1642 | OK (S23) |
  | 2714–2719 | `seedUsageBaseline`, replay flag off | 1653–1660 | OK (S17) |
  | 2731–2770 | stale clear, `applyManualTodoOverrides`, all-done clear | 1661–1684 | OK (S07) |
  | 2775–2794 | `upsertSession`, `getSessionGoal` | 1685–1690 | OK |
  | 2799–2801 | `readSettings("user")` with `.catch(() => ({}))`, then `userSettings.spinnerTipsEnabled` | 1694–1700 | OK (D10a: a `null` file rejects start with a `TypeError` through the same `start_error` slot) |
  | 2805–2821 | `spinnerTipsConfig`, `queueDispatchMode` | 1720–1732 | OK (S22) |
  | 2829–2833 | `joinSystemPromptAppends`, `buildSystemPromptOption` | 2008, 2040, `join_system_prompt_appends` 4387 | FIXED (JS trim) |
  | 2839 / 2957 | `loadDbAgentsForOptions` → `agents` | — (G05 adds it at the `build_options` call) | KNOWN (G05, now in main: after the merge the golden's `db agents` case matches) |
  | 2847 / 3038 | `projectConfigRootFor` → `projectConfigRoot` | 2093 | FIXED |
  | 2857–2878 | `resolveAccountProfile`, `buildEnvForProfile`, `envOverride` (and `ready.account`) | — | KNOWN (S30) |
  | 2887–2889 | `advisorModel` from settings | 1703–1708 | OK |
  | 2904–2923 | fable advisor clear (delete, write, `setImmediate` notice) | 1703–1719, 1766 | FIXED (empty advisor); delete order and write text are D10a's |
  | 2926–2952 | `cwd`, `model`, `env` (`buildQueryEnv`), `mcpServers`, `systemPrompt` | 2014–2016, 2040, 2141, `build_query_env` 1284 | OK (golden env delta, `initialize` byte for byte) |
  | 2962 | `agent` | 2018 | OK |
  | 2966–2980 | `maxBudgetUsd`, `taskBudget`, `maxTurns` | 2047–2054; `options.rs` 227 (`js_number`) | FIXED (number text, no truncation) |
  | 2981 | `fallbackModel` | 2019; `options.rs` 424 (`truthy`) | FIXED (empty; equal to model → reject) |
  | 2991–3024 | sandbox | 2055– | OK (6 golden variants) |
  | 3025–3031 | betas, `persistSession`, `additionalDirectories` | 2078–2085 | OK |
  | 3044 | `planModeInstructions` `.trim()` | 2087 | FIXED |
  | 3047–3054 | `permissionMode`, restricted `disallowedTools` | 2020, 2096 | FIXED (empty mode writes no flag); restricted OK |
  | 3056–3061 | `abortController`, `canUseTool`, `onElicitation` wiring | 2139 | OK (handler bodies → S27b) |
  | 3062–3101 | partial messages, hook events, per-task stop, subagent text, progress summaries | 2021–2025 | OK |
  | 3111 | `promptSuggestions` | 2027 | FIXED (null falls back) |
  | 3148–3173 | settings forward | 2102–2128 | FIXED (literals, `js::stringify`) |
  | 3174–3226 | file checkpointing, `allowedTools`, `thinking`, `toolConfig` | 2129–2130 | OK |
  | 3228–3276 | PreToolUse hook (worktree `cwd_changed`, mid-turn reminders) | `build_hooks` 2187 | OK except the `file_path: null` → `notebook_path` fall-through (S27b) |
  | 3277–3315 | PostToolUse sha256 snapshots (`createHash`) | 2226 (`reminders::post_write_target`, `file_sha256_async`) | OK (S21) |
  | 3316–3339 | CwdChanged hook | 2242 | OK |
  | 3340–3388 | PostModelSwitch hook (`enforceAdvisorModelCompatibility`, persist) | 2261, `on_post_model_switch` 2275, `enforce_advisor_model_compatibility` 3836 | FIXED (empty advisor) |
  | 3390–3391 | `resume` / `sessionId`, `resumeSessionAt` | 2136 | OK |
  | 3393 | `query()` (sync throw) | 1734–1744, `take_start_error` 1599, `session_manager.rs` 135 (D10a's `create`) | FIXED |
  | 3394–3412 | `ready`, `session_title`, `broadcastGoal`, advisor notice | 1745–1777 | FIXED (`fallbackModel` truthiness; spawn-failure `ready`) |
  | 3422 | `void this.consume()` | 1778–1804; `spawn_failed` 1826 | FIXED (spawn-failure events); the tail is S27a |
  | 3435–3446 | auto-mode `supportedModels` check | 1806 | OK (no `this.query === q` guard; harmless) |
  | 3447–3455 | `startJsonlWatcher`, `flushQueueIfIdle` | 1818–1819 | OK (not run after a spawn failure → S27a) |
  The six "known so far" bullets:
    - G05, S30, S31: still accurate (G05 has since landed in main).
    - `createHash`: ported by S21 (the PostToolUse hook hashes the written file).
    - `isWorkflowSizeGuideline` / `isCrossSessionInbound`: FIXED.
    - `clearTodos` / `stopTask` / `rewindFiles` inside hooks: moot. start()'s four hooks call none of them. `clearTodos` runs from start's auto-clears (ported in S07b). `stopTask` appears only in the `perTaskStopAffordance` comment.
  Tests:
    - `tests/session_start_golden.rs` replays 83 runs of the real `new Session(options).start()` against the fake CLI, recorded by `rust/scripts/session-start-golden.mjs` (two runs byte-identical; re-recorded 2026-10-28 for the error name, nothing else changed). Temp HOME and CLAUDE_CONFIG_DIR, a registered git root with a worktree, seeded goals, `db_agents` rows and transcripts.
    - Each run compares 8 fields: what start rejected with (`{name, message}`); the non-`sdk` events; the replayed messages with `at`; a late subscriber's `ready`s; the argv; the env delta; the `initialize` line byte for byte; and settings.json afterwards.
    - All 664 fields match except one KNOWN (`db agents` / `initialize`, G05), which goes away when G05 merges. A stale KNOWN entry fails the test.
    - In the same file: `advisor_compat_clear_matches_ts` runs `clear_user_advisor_model` against the fable cases' TS text; `a_rejected_start_is_not_joined`; `a_joined_rejected_start_reports_its_message` (both check the `Error` name).
    - `claudius-agent` options unit tests: `empty_string_options_are_skipped_like_the_sdk`, `numbers_print_like_js_template_literals`.
  Mutation: 38/40 killed. Of these, 32 are on S27's own code (31 killed) and 8 on D10a's create / settings code that S27's tests also cover (7 killed). 28 ran before the rebase on unchanged anchors. The 3 whose code moved, the new error-name mutant and the 8 D10a ones were re-run after the rebase. The 2 survivors are equivalent:
    - comparing the fallback with the raw model instead of the truthy one (a non-empty fallback can only equal a non-empty model);
    - dropping `session.end()` after a rejected start (both throw sites come before any spawn, watcher, shell or input pump, so there's nothing to tear down; kept to mirror TS).
  Flake: 20/20 after the rebase for `session_start_golden` (4 tests) and the `options::` unit tests, throttled (`CARGO_BUILD_JOBS=4 RUST_TEST_THREADS=4`).
  No e2e. `advisor-picker`, `cc-parity-2.1.295-advisor-unavailable` and `sdk-update-0.3.251-auto-model-switch-notice` stub `/api/sessions` and its stream (or `/api/models`) in the browser. `sdk-update-0.3.219-workflow-size-guideline` and `cc-parity-2.1.245-model-picker-setting` only drive the settings API on Next. No spec starts a session with a fallback equal to the model, an empty option, a fractional budget, a worktree cwd, a missing binary or an unreadable transcript. The user's app holds `.next-e2e`.
- [x] **S27a** Spawn-failure tail. After a CLI that can't be launched, TS `start()` still runs `startJsonlWatcher()`, `flushQueueIfIdle()` and the auto-mode `supportedModels` check on the query object (its control calls reject). Rust's `spawn_failed()` stops at consume()'s end, so there's no JSONL watcher: an external `claude --resume <id>` writing that transcript doesn't reach the open tab. Accept: a fake-CLI test with a missing binary and an existing projects dir sees the watcher up and a resync. deps: none
  — done 2026-10-28 (background agent): `Session::start()`'s spawn-failure arm now runs TS `start()`'s tail before `spawn_failed`: `start_jsonl_watcher()`, then `flush_queue_if_idle()` (one 6-line session.rs hunk). Behaviors found in the recording (TS at 860dd77c): with no live CLI, `flushQueueIfIdle` still takes the queue's head out of `.claudius.db`, broadcasts `running` and the user echo, and writes the message into a CLI that never reads it. The stream's `error` and `idle` follow, so that message is lost and the rest stay queued. Rust does the same, synchronously, before `spawn_failed`, which keeps TS's event order (ready, turn_status running, error, turn_status idle). The auto-mode `supportedModels` check rejects on the dead query and TS catches it, so nothing is observable; Rust has no query handle at that point, so nothing runs (a comment says so). The watcher comes up, and an external `claude --resume` writing the transcript reaches the tab through `resyncFromDisk` with its `at`. Differences: none new. TS watches `homedir()/.claude/projects/<enc>` and Rust watches `<config>/projects/<SDK name>`; that deliberate difference is already listed in the gaps. The recorder links the two dirs, as a profile's symlinked `projects/` does. Tests: `session-start-golden.mjs` and `session_start_golden.rs` gain 3 cases ("binary missing, watched", "binary missing, queued", "binary missing, auto mode"). They compare the watcher state, the external lines' resync with `at` (the file is re-touched every 500 ms until it lands), what the flush sent, and the queue rows afterwards. The 83 existing cases are unchanged in the re-recorded fixture, and the two recorder runs were identical. Mutation 3/4: removing the watcher, removing the flush, or flushing after `spawn_failed` are all killed. Swapping the watcher and the flush is equivalent: both are synchronous, the watcher starts on a detached thread, and neither reads the other's state. Flake 0/20. No e2e: the user's app holds `.next-e2e`, and no spec starts a session with a missing binary (no `nonexistent` or `claude-bin` override in tests/e2e). The queue specs (`cc-parity-2.1.275-send-all-queued`, `cc-parity-2.1.295-queue-lift-history`, `sdk-update-0.3.205-interrupt-still-queued`, `sdk-update-0.3.245-queued-turn-count`, `sdk-update-0.3.287-prompt-queue`) all run against a live CLI. No spec drives an external transcript write: `chat-scroll-pin` injects its historical records through `dev-broadcast`. Merged from the parallel clone (rebased onto main by the merge loop).
- [x] **S27b** `canUseTool` / `onElicitation` / hook text parity, with a golden that drives the real Session through the fake CLI's `$control` steps (`can_use_tool`, `elicitation`, `hook_callback`):
  - ExitPlanMode with a non-string `plan` uses `serde_json::to_string_pretty` (`2.0`, `1e21`, insertion order) where TS uses `JSON.stringify(input, null, 2)`; should be `js::stringify_pretty`.
  - `mcp_elicitation_request` key order: TS puts `requestedSchema` after `elicitationId`, Rust last. Rust drops only a null schema where TS tests truthiness.
  - Tool-budget cap: a fractional per-cwd cap is truncated (`2.5` denies at 2 with "(2)"; TS denies at 3 with "(2.5)"). The env fallback parses with `str::parse` instead of `Number()` (`0x10`, `0b11`, `0o7`); should use `js::to_number` / `js::number_to_string`.
  - PreToolUse: `file_path: null` doesn't fall through to `notebook_path` (`??`).
  - A missing `tool_use_id` gives `toolUseId: ""` (TS drops the key). A rule without `toolName` gives `toolName: null` (TS drops it), and a truthy non-string `ruleContent` is dropped (TS keeps it).
  deps: none
  — done 2026-11-01 (merge loop): new `claudius_core::prompt_events` (the tool-budget cap with `Number()` / JS number text, the ExitPlanMode plan through `js::stringify_pretty`, and the `permission_request` / `ask_user_question` / `plan_approval_request` / `mcp_elicitation_request` events in TS key order with TS's truthiness and `??` drops), wired into `Session`'s `canUseTool` / `onElicitation` / PreToolUse paths (small hunks in session.rs, `claudius-agent` `permission.rs` / `query.rs`). Golden: `rust/scripts/session-callbacks-golden.mjs` drives the real Session through the fake CLI's `$control` steps; `tests/session_callbacks_golden.rs` replays it. Merged 2026-11-01 from its 2026-10-29 clone. Its agent was cut off by the session limit during mutation testing, before it could report; the one mutant it left applied was restored by checksum. Mutation unfinished, flake not re-run (speed). E2E deferred to the section-exit parity runs (S34 / D28).
- [x] **S27c** Replay `at` through V8 `Date.parse`: Rust parses RFC 3339 only. TS also reads date-only `2026-01-02` (UTC midnight), offset-less date-times (local time) and V8's legacy forms (`Jan 2 2026 03:04:05`, `2026/01/02`), so such a record gets the previous `at` + 1 in Rust. Only foreign writers hit this; the CLI writes `…Z`. Use S33's `claudius_core::js_date::date_parse` (the ES5 forms); V8's legacy fallback is still unported there. Accept: replay cases with those timestamps in `session-start-golden.mjs`. deps: none
  — done 2026-10-28 (background agent): the replay `at` (`replay_transcript`) and the resync `at` (`resync_from_disk`) now go through `claudius_core::js_date::date_parse` instead of RFC 3339 (one line each in session.rs). Stretch done: `js_date.rs` is now a step-for-step port of node 22's V8 `DateParser`, legacy fallback included: the tokenizer over UTF-16 units, `ParseES5DateTime`, the legacy loop with its Day / Time / TimeZone composers, `KeywordTable`, `ReadMilliseconds` and `SkipParentheses`, then the year range, local-to-UTC conversion and `TimeClip`. Its "Not ported" note is gone. Behaviors found, each checked against node 22.23.3:
  - A NUL unit ends the input.
  - Words match on their first 3 letters, and only month names may be longer, so `GMT+0100junk` reads `junk` as June while `xyz` is NaN.
  - `Jan 2` with no year is 2001. Two-digit years 0–49 become 20xx and 50–99 become 19xx, except in ISO dates.
  - Only a number's first 9 significant digits count, and its leading zeros count toward its length.
  - A `+hh:` offset is computed as `hour*3600 + minute*60` in wrapping u32 and checked against 2^31−1: `GMT+596523:` parses, `GMT+596524:` is NaN, `GMT+1193047:` wraps to +1 904 s, and `GMT+123456789:00` parses.
  - Milliseconds after a third colon: `12:34:56:789` gives 789 ms, `:99` gives 99 ms, and `:1000` is dropped.
  - An ES hour-24 fraction is checked by value before it's cut to 3 digits: `T24:00:00.0001Z` is NaN, but the legacy `24:00:00.0001` parses.
  - A local time is converted only within ±(8.64e15 ms + 30 days) and for years within ±1e6, then `TimeClip`.
  Differences: none across the recorded strings. Lone surrogates aren't recordable because the fixture is read as Rust strings. Tests:
  - New `scripts/date-parse-golden.mjs` records `tests/fixtures/date_parse_golden.json` under `TZ=America/New_York` (two runs identical). It holds 13 045 strings, 5 074 of which parse: about 400 hand-written forms and edges, `Date`'s own formatter output for 400 seeded times, and seeded token soups (4 000), field templates (3 000) and mutations (3 000). `tests/date_parse_golden.rs` replays them, and all match.
  - New `js_date` unit test `legacy_forms`.
  - New `session-start-golden.mjs` case "resume dates": 26 stamps (date-only, zone-less, New York's DST gap and fold, non-strings, legacy forms, `t`/`z`, `+hhmm`, a 6-digit year, out of range). All 87 cases match.
  - `assets_golden.rs` lost its 7-string legacy carve-out, so all 100 strings are now exact. `list_sessions_golden.rs` checks its zoned legacy strings exactly.
  Mutation 66/70: 64/68 on js_date.rs plus both session.rs call sites reverted to RFC 3339. J07 (9 to 8 significant digits), J26 (colon ms limited to 0–99) and J66 (no hour-24 fraction check) survived at first and were killed by added corpus strings. J10 (`SkipParentheses` without the end check) hangs on an unclosed `(` and was killed by the hang watchdog. Four are equivalent: the ES checks for "hour 24 only with minute 00" and "day 1–31" are redone by the composers' `Write`; a `.` after `n:` is ignored by the legacy loop anyway; and the ±(max + 30 days) guard is subsumed by `TimeClip`, since zone offsets are under a day. Flake 0/20. No e2e: the user's app holds `.next-e2e`, and no spec writes a transcript with non-RFC 3339 stamps. `workspace-move-sessions` writes `<id>.jsonl` with `toISOString()` stamps, which both parsers read the same. `session-resume` resumes CLI-written `…Z` transcripts. `chat-scroll-pin`'s historical `at` goes through `dev-broadcast`, not the replay or the resync. No spec opens the asset grid or lists sessions with legacy `createdAt` stamps. Merged from the parallel clone (rebased onto main by the merge loop).
- [ ] **S27d** Create-route body types. Rust deserializes the merged body into a typed `SessionOptions` and returns 400 with serde's message on a wrong-typed option (`"maxTurns": "5"`, `"model": 5`, `"additionalDirectories": "x"`). TS forwards every field untyped to `new Session`, where each read applies its own test: numbers need `typeof === "number"` (else dropped); string options are SDK-truthiness tested and printed with `${}` (`--model=5`); a non-string `planModeInstructions` / `systemPromptAppend` throws in `.trim()`, so start rejects with a 500 whose `name` is the error's. Accept: odd-typed bodies recorded through the real TS route, replayed on the binary. deps: none (fits S32)
- [x] **S28** Audit `consume()`, `broadcast()`, `captureSnapshotState()` and `captureTaskState()` against Rust the same way, and file the deltas as tasks.
  — done 2026-10-28 (background agent): audited `broadcast()` (TS lib/server/session.ts 8046–8186), `captureSnapshotState()` (8304–8697), `captureTaskState()` (8728–8897) and `consume()` (8967–9379) at HEAD 860dd77c against Rust. Also audited the stream route's `send` (app/api/sessions/[id]/stream/route.ts 47–50), since the route writes every broadcast. Ported 7 deltas and filed S28a–S28b.
  Behaviors found and fixed:
    - `plan_usage` / `plan_usage_unavailable` were never sent. After each `success` result, TS asks the CLI for `get_usage` (`skip_behaviors: true`) and broadcasts the plan limits. A failed request broadcasts `plan_usage_unavailable`. New `Session::spawn_plan_usage` (fire and forget, like the TS IIFE) and `session_consume::plan_usage_event` / `normalize_extra_usage` implement this. They follow JS property reads on any reply shape:
      - a truthy primitive `rate_limits` maps to `{}`, and a falsy one to `rateLimits: null`;
      - a falsy window passes through as sent;
      - `undefined` fields are left out, and `?? null` is applied where TS applies it;
      - TS key order.
      Where the TS IIFE throws (a `null` reply, a truthy non-array `model_scoped`, a `null` entry), Next logs an unhandled rejection and nothing is broadcast. Rust broadcasts nothing too.
    - `touchSession` was never called. Every `result` now moves `sessions.updated_at` / `last_seen_at`.
    - `queued_turn_count` number text. Rust kept a saturating `u64`, so `1e300` and `2^64` were sent as `18446744073709551615`. It is now an `f64` printed with `js_num`.
    - `/model` echo parse (`/^set\s+model\s+to\s+(\S+)/i.exec(content ?? "")`). The old `regex` crate pattern used Unicode `\s` (NEL matched, BOM didn't) and Unicode case folding (`ſet` matched), and read a non-string `content` as `""`. `set_model_target` now uses JS `\s` (BOM, NBSP and U+3000 match; NEL doesn't), ASCII-only `/i`, and `String()` coercion (an array `["Set model to x"]` matches).
    - Denial ring: `tool_name ?? "(unknown)"` and `decision_reason_type ?? decision_reason ?? "unknown"` now keep any non-null value as sent; Rust used to replace non-strings with the fallback. `at` is the event's own only when it's a number; Rust used to keep a string `at`.
    - Prompt snapshot: `text && m.uuid` accepts any truthy uuid (a number, `true`) and keeps it as sent. Rust used to accept non-empty strings only.
    - SSE `data:` lines were written with serde's `Display` (`1e21`, `2.0`). They now use `JSON.stringify` number text through `js::stringify` (`1e+21`, `2`).
  Audit (Rust lines are in the clone's crates/claudius-core/src/session.rs unless noted):
  | TS lines | Statement / block | Rust | Status |
  |---|---|---|---|
  | 8052–8054 | stamp `at` on an `sdk` event whose `at` is null / missing | 413–415 | OK |
  | 8066–8072 | `shouldBufferEvent`, 1000 cap, `bufferTrimmed` | 416–423, `events.rs` 26 | OK |
  | 8077, 8081 | `captureSnapshotState`, `captureTaskState` | 424–425 | rows below |
  | 8084 | `model_changed` → `refreshAppliedEffort` | `Session::broadcast` 1476–1483 | OK |
  | 8092–8094 | `sdkModel` from a non-empty init model | 431–438 | OK |
  | 8097–8104 | `latestInitSnapshot` | 439, `events.rs` 317 | OK |
  | 8105–8110 | `pluginLoadErrors` from init | — | KNOWN (G04 [~], `getPluginLoadErrors`) |
  | 8117–8123 | `commands_changed` refreshes the cached init's commands | 441–448, `events.rs` 342 | OK. A non-array `commands` throws in TS; Rust carries on (dev-only difference, new gap line) |
  | 8125–8127 | live init: MCP needs-auth / disconnected notices | `on_message` 2635–2637 | OK (S15b). A `dev-broadcast` init skips them → S28a |
  | 8128 | live init: token-expiry nudge | 450–457 | OK (S20; no expiry source until S30) |
  | 8136 | live init: advisor compat vs the init model | 2662–2666 | OK. Awaited inline → S28b; dev-broadcast → S28a |
  | 8139 | live init: `refreshAppliedEffort` | 2669–2671 | OK |
  | 8142–8151 | `permission_denied` → denial ring (20) | 459–469, `push_denial` 403 | FIXED |
  | 8154–8160 | fan-out | `fan_out` 398 | OK |
  | 8165–8185 | `notificationBus.recordSessionEvent` | — | KNOWN (S31) |
  | 8305–8312 | sdk only; skip a truthy `parent_tool_use_id` | 479–486 | OK. A null / missing `message` throws in TS (8311); Rust carries on (dev-only difference, new gap line) |
  | 8325–8343 | latest user prompt (`text && m.uuid`, `at >= prevAt`) | 496–516 | FIXED (truthy non-string uuid) |
  | 8344–8420 | TaskList `tool_result` rebuilds the list | `capture_tool_result` 529–566 | OK |
  | 8421–8498 | TaskCreate `tool_result` → real id, `is_error` drops it | 567–600 | OK |
  | 8508–8547 | mid-turn to-do reminder count and gates | 602–622 | OK |
  | 8548–8580 | worktree heuristic on edit tool_uses | 623–631 | OK |
  | 8582–8613 | TodoWrite | 632–650 | OK (a `null` entry: KNOWN, Todos gap) |
  | 8614–8662 | TaskCreate: pending entry, cutoff, dedupe | 651–679 | OK |
  | 8663–8668 | TaskList: pending | 680–683 | OK |
  | 8669–8696 | TaskUpdate (status, deleted, manual overrides) | 684– | OK |
  | 8777–8793 | subagent inner messages (cap 500) | 853–880 | OK |
  | 8794–8896 | `task_started` / `_progress` / `_updated` / `_notification`, throttled persist | 905–1031 | OK (odd field types: KNOWN, Subagent persistence gap) |
  | 8980 | broadcast each message | `on_message` 2638 | OK |
  | 8987–8993 | thinking-replay recovery | 2626–2627, 2642–2644 | OK (S19) |
  | 8994–9007 | overload / long-context credits / auth nudges | 2646–2654 | OK (S20) |
  | 9012 | `noteAccountAutoRotateObservation` | — | KNOWN (S30) |
  | 9018 | `trackScheduledLoops` | 2630 (runs before the broadcast) | KNOWN (Scheduled loops gap) |
  | 9019 | `extractReadPaths` | 2625, 2631 | OK |
  | 9027–9029 | `compact_boundary` → reseed read paths | 2657–2660 | OK |
  | 9037–9068 | "Set model to" echo → model, `model_changed` (`chat_command`), upsert, persist | 2614–2616, 2673–2694, `session_consume::set_model_target` | FIXED |
  | 9070–9076 | result: `turnInFlight` false, `turn_status` | 2701–2702 | OK |
  | 9077 | `recheckMcpStatusMidSession` | 2699 | OK (S15b) |
  | 9081 | `foldUsageFromResult` → `usage_snapshot`, save | 2703, 2722–2724 | OK (S17) |
  | 9083–9097 | `queued_turn_count` → `queue:updated` on change | 2704–2709, `queue_event` 389, `session_consume::queued_turns` | FIXED (number text) |
  | 9104–9107 | `planAwaitingVerify` → verify-plan reminder | 2710–2713 | OK |
  | 9114–9121 | success: `noteThinkingRecoverySuccess`, overload streak reset | 2729–2730, `detectors.rs` 255 | OK |
  | 9122–9232 | success: `get_usage` → `plan_usage` / `plan_usage_unavailable` | `spawn_plan_usage` 2745, `session_consume::plan_usage_event` | FIXED (was missing) |
  | 9264 | `opusOverloadCountedThisTurn = false` | `detectors.rs` 257 | OK |
  | 9265 | `touchSession` | 2726 | FIXED (was missing) |
  | 9270 | `maybeOfferFeedbackSurvey` | 2727 | OK |
  | 9286–9296 | success: to-do turn-end sync, then `flushQueueIfIdle` | 2716–2719, 2733–2737 | KNOWN (Reminders gap: runs under the lock) |
  | 9299–9328 | catch: `error` unless aborted, thrown-text nudges | `consume` 2577–2589 | OK |
  | 9329–9346 | finally: `done`, `drainPendingDecisions("Aborted")`, idle `turn_status` | 2594–2599 | OK |
  | 9348–9377 | synthetic bus `session_idle` | `let _ = saw_error` 2593 | KNOWN (S31) |
  | stream route.ts 47–50 | `data: ${JSON.stringify(data)}` | claudius-server `sessions.rs` 428–431 | FIXED |
  New tasks: S28a and S28b (below).
  Differences kept (new PORT_PLAN gap line):
    - Where TS throws out of `broadcast()`, Rust carries on (an `sdk` event with a null / missing `message`; a non-array `commands`). Only `dev-broadcast` can send either.
    - A `get_usage` reply without `response` reads as `{}` here, giving `plan_usage` with `rateLimits: null`. The SDK hands TS `undefined`, which throws, so TS sends nothing. The CLI always sends a `response`.
  PORT_PLAN gaps re-checked against the golden; all still accurate:
    - Subagent persistence: the odd-types case reproduces.
    - Todos: TS throws on a `null` entry, both out of `broadcast` and out of the mid-turn path.
    - Scheduled loops: the tracker still runs before the broadcast.
    - MCP notices: only live messages reach `on_message`.
    - Reminders: the turn-end sync runs under the lock.
    - Nudges / S30: auto-rotate is not wired.
  Tests:
    - `rust/scripts/session-stream-golden.mjs` records the real TS on node 22 under a temp HOME and CLAUDE_CONFIG_DIR, through an SDK shim that only adds the fake CLI's path. The two runs are byte-identical, and re-recording gives the same fixture. The .mjs is ASCII-only and lint-clean.
    - `session/tests/stream_golden.rs` `broadcast_matches_ts` (child of `session::tests`, for the shared path overrides) covers 33 cases and 306 steps:
      - Steps: scripted events through `Session::broadcast` on an unstarted session, and `set` steps for replaying / overrides / `todosAt` / `turnInFlight`.
      - Areas: stamping, buffer rules, the 1003-event burst and exactly-full buffer, init / `commands_changed`, denials (odd types), prompts (uuid `5` / `true` / `0`), TodoWrite / TaskCreate / TaskList / TaskUpdate with cutoffs and overrides, the mid-turn reminder, worktree, task capture with `turn_status`.
      - Compared after each step: the live subscriber's events and the captured state.
      - Compared at the end: the replay buffer, `bufferTrimmed`, both reminder channels, the `session_tasks` rows and the sessions `state` text.
      - 4 KNOWN cases: the 3 TS throws and task odd types. A stale KNOWN entry fails the test.
    - `tests/session_consume_golden.rs` `consume_matches_ts` runs 7 real sessions on the fake CLI with 55 prompts:
      - 20 `get_usage` replies, including error, null / string / array replies, falsy and odd windows, every `model_scoped` shape and the extras;
      - result subtypes `error_max_turns`, `error_during_execution`, none and success;
      - 12 `queued_turn_count`s (`2.7`, `"3"`, `-1`, `1e300`, `2^64`, `1e21`, …);
      - 16 `/model` echoes (NBSP / U+3000 / BOM / NEL / `ſ` / emoji / array / number / null / empty / leading space / tab);
      - a missing `content`, a CLI exit mid-turn (`code 3`), and a stream that ends without a result.
      Per prompt it compares the ordered events and the async ones (sorted). Per case it compares the sessions row (model, updated / last-seen moved) and settings.json. It also checks `sendQueueSnapshot`'s rule (session.ts 7595) for a subscriber at start and a late one.
    - `session_consume` unit tests: `set_model_follows_the_js_regex`, `queued_turns_floor_positive_finite_numbers`.
    - `claudius-server/tests/dev_routes.rs` `dev_routes_drive_a_live_session`: a dev-broadcast event's SSE line equals `JSON.stringify` (`1e+21`, `2`, `10000000000000000`, `0.000001`, `1e-7`, `18446744073709552000`, `0`).
  Mutation: 26/26 killed, run one at a time and throttled, with checksums restored and verified:
    - 16 on `session_consume.rs`, 9 on the session.rs hunks, 1 on the SSE line.
    - The one first-round survivor (`sdk_queued_turns >= 0.0` in `send_queue_snapshot`) was killed by the added subscribe-time queue-snapshot check.
    - Not run, as equivalent: `null` content coerced to `"null"` instead of `""` (neither matches); `> 0.0` vs `>= 0.0` in `queued_turns` (0 and -0 both print `0`); `is_finite` (serde never yields a non-finite number).
  Flake: 20/20 for each of the stream golden plus unit tests, `session_consume_golden` and `dev_routes`, throttled (`CARGO_BUILD_JOBS=4 RUST_TEST_THREADS=4`).
  No e2e. Every spec that touches these events stubs the session stream in the browser through `page.route`: `sdk-update-0.3.169-plan-usage`, `cc-parity-2.1.208-usage-staleness`, `cc-parity-2.1.251-cost-overlay-cache-spend`, `sdk-update-0.3.190`, `cc-parity-2.1.299-usage-behaviors`, `sdk-update-0.3.245-queued-turn-count`, `cc-parity-2.1.275-send-all-queued`, `cc-parity-2.1.295-queue-lift-history`, `sdk-update-0.3.200-model-switch-rejected`, and `cc-parity-2.1.193-recent-denials` (which stubs `/denials`). None of them reaches the Rust consume loop or the SSE writer. The user's app holds `.next-e2e`.
  Merged from the parallel clone (merged 2026-10-29 by the merge loop). Main-tree gate b8 (with everything merged on 2026-10-28): 673 tests; 3 failures under load ~65 (`rewind_golden`, `accounts_routes` health timeout, `schedule_routes` connection reset) each passed 3/3 when rerun alone. The connection reset was a real server bug, fixed in I16.
- [ ] **S28a** `dev-broadcast` of a `system/init` skips the init hooks. TS runs them inside `broadcast()` for every init that isn't a transcript replay: the MCP needs-auth / disconnected startup notices, the advisor-compat check against the init's model, and `refreshAppliedEffort`. (The token nudge is already in `State::broadcast`.) Rust runs them from `on_message`, so only inits that come from the CLI reach them. Only the dev-only `dev-broadcast` route can inject an init, and no spec does. Move them behind `Session::broadcast` (they're async and need the `Arc`), keeping the notices' "before subscribers see the init" order. Accept: a server test that dev-broadcasts an init naming a needs-auth server, or a model the advisor can't serve, sees `mcp_needs_auth_notice` / `advisor_disabled_on_model_change`. deps: none (low priority)
- [ ] **S28b** Don't await the init's advisor check in the consume loop. `on_message` awaits `enforce_advisor_model_compatibility(<init model>)`. When the advisor has to be cleared, that write to settings.json and the `set_advisor` control reply finish before the next CLI message is handled. TS fires it (`void`) and keeps consuming, so messages the CLI sends meanwhile reach subscribers first and `advisor_disabled_on_model_change` lands after them. Spawn it the way the MCP notices are spawned. Accept: with the fake CLI's `set_advisor` reply delayed (`$delay_ms`), the messages after the init aren't held back. deps: none
- [ ] **S29** Audit `sendInput()` (incl. `recordSendUses` asset ingest, which needs D17) and `subscribe()` (incl. `task_snapshot` timing) the same way. Also audit `session-manager.ts` / `session-resume.ts` (live-status fields in list, keepalive exemption).
- [x] **S30** Account pinning: `resolveAccountProfile`, `buildEnvForProfile`, `refreshAccountDrift`, `moveToActiveAccount`, `noteAccountAutoRotateObservation`, `lib/server/session-accounts.ts`, `GET/POST /:id/account`. deps: G02
  — done 2026-11-01 (merge loop): new `claudius_core::account_pinning` (`resolveAccountProfile`, `start()`'s account block with `buildEnvForProfile`, `moveToActiveAccount`, `noteAccountAutoRotateObservation` + `isRateLimitHitSdkMessage`, `matchesUsageLimitPrefix`), `claudius_core::session_accounts` (`resolveSessionAccounts`, `lookupSessionAccount`, `getSessionAccountsByCwd`), `ready.account`, and `claudius_server::session_account` serving `GET/POST /api/sessions/:id/account` (the last `/:id/*` 501 is gone). Golden: `rust/scripts/session-account-golden.mjs` → `tests/session_account_golden.rs`, `claudius-server/tests/session_account.rs`; `session_start_golden` re-recorded with the account cases. Merged 2026-11-01 from its 2026-10-29 clone. Its agent was cut off by the session limit during mutation testing, before it could report; the one mutant it left applied was restored by checksum. Mutation unfinished, flake not re-run (speed). E2E deferred to the section-exit parity runs (S34 / D28).
- [ ] **S31** Notifications from sessions: emit to the bus at every TS emit site (turn done, needs input, errors, …) and `sweepOrphanedActionableForSession`. deps: G01 Accept also: `tests/e2e/notifications.spec.ts` › "Session.broadcast still calls the bus" passes on Rust (moved here from S25; it drives `dev-broadcast` → `Session::broadcast` → bus → `/api/notifications`).
- [x] **S32** Fix the ported routes:
  - ~~`/model`: `managed-model-policy.ts`~~ — done in A05a (file tier). The MDM, remote and Windows tiers come with A05b–d.
  - ~~`/input`: asset ingest `recordSendUses`~~ — done in D17 (one hunk in the `input` route, as TS calls it there).
  - ~~`/context`: `weeklyUsedSkills`~~ — done in S16 (`Session::get_weekly_used_skills` + `usage_behaviors::with_weekly_used_skills` in the `context` route's full fetch, replayed by `tests/usage_behaviors_golden.rs`).
  — closed 2026-10-28 (merge loop): all three bullets were done by A05a, D17 and S16; nothing left to port. S27d (the create route's typed body) is filed separately.
- [x] **S33** `listSessions` parity in `sessions_store.rs`: fork hiding and relocated-session dedupe.
  — done 2026-10-27 (background agent): ported SDK 0.3.299 `listSessions` (`wU`) as `claudius-core/src/sessions_list.rs` (`list_sessions` / `list_sessions_in`, `ListOptions` with JS-number `limit` / `offset`, `includeWorktrees`, `includeProgrammatic`; `ListEnv` = `<NFC config dir>/projects` + the `CLAUDE_CODE_PROJECT_DIR_NAME` override), plus `js_date.rs` (V8 `Date.parse`, ES date-time format) for `createdAt`. `sessions_store::list` is now the `sessions-store.ts` wrapper (`limit ?? 200`, `includeWorktrees ?? true`).
    - Findings: the SDK hides no forks. It hides two kinds of session:
      - (a) a session whose tail ends in a `continued-in` record (last marker, valid uuid, no real turn after it: a gi prompt, or an assistant with a string `stop_reason` that isn't an API error) once `<id>.jsonl` sits beside it with a `"parentUuid":` line (head/tail, else a scan of the first 16 MiB that carries across 1 MiB reads; ≥16 MiB counts);
      - (b) in a `dir` listing, a session whose cwd (tail `relocated` stamp, else head) encodes to the listed dir's name but resolves elsewhere (`mD`), unless the cwd is inside a listed worktree (`gD`, case-insensitive on macOS/Windows), has `..`, is a network / device path or reaches one through a link (`xc` / `nP`), or doesn't resolve. Not in the all-projects listing.
    - Other SDK behaviour ported: only the realpath's project dir is read, never the raw dir. Readdir is byte-sorted. `<uuid>.jsonl` (any case) is not read through a link or as a FIFO (O_NOFOLLOW | O_NONBLOCK). Names past 200 chars scan same-prefix siblings whose transcripts record the cwd (`Qa`), also per worktree. The override reads its dir plus the natural one and skips the prefix scan. Mtimes are Node's double `Math.round` (pre-epoch too).
    - Paging: unpaged keeps the newest copy, the first on a tie. Paged sorts by stat mtime, keeps the first readable copy, then applies `offset` and `limit` as JS numbers (`0`, negative, NaN, fractional, Infinity, `limit: 0` with an offset).
    - Old Rust `list` divergences fixed:
      - the raw dir was scanned; readdir was unsorted;
      - symlinked transcripts were followed, and a FIFO would block;
      - mtimes used integer rounding;
      - an empty `customTitle` / `gitBranch` / `cwd` / `relocatedCwd` won over the `||` fallbacks;
      - `timestamp` was parsed as RFC 3339;
      - the prompt rules used Rust trim, char counts and Unicode `\w` / `\s` / `.`;
      - the sidecar sanitize had no run collapse, missed `\p{Cf}` and required strict UTF-8;
      - there were no prefix dirs, override, `offset` or `includeProgrammatic`;
      - unpaged dedupe was last-wins.
      The shared reader fixes also apply to `info()`.
    - Tests:
      - `tests/list_sessions_golden.rs` replays 22 cases / 104 calls (SDK and the TS wrapper, `JSON.stringify` text) on rebuilt trees: exact ns mtimes, symlinks, FIFOs, modes, real `git worktree add`, SDK `forkSession` output.
      - It also checks the SDK's own `xc` / `nP` predicates on 46 paths and V8 `Date.parse` on 49 strings (+4 legacy-only).
      - Recorded by `rust/scripts/list-sessions-golden.mjs`; two runs byte-identical.
      - Unit tests cover the path predicates, the `nP` link walk (64-link cap, loops, links onto `/net` / UNC / `/Network`), the wrapper options and `ListEnv::for_config`.
    - Mutation: 81/88 killed (90 written; 2 dropped after they showed dead code, which was simplified away). The 7 survivors are equivalent or unreachable:
      - `limit: 0` taken as paged with no cap gives the same list;
      - `Qa` reading non-file entries (the reader already refuses them);
      - `RU`'s dir dedupe (one path only);
      - worktree match order (needs hashed names of different lengths, but the hash covers the random temp root);
      - rescanning dirs `Hn` already took (same copy, deduped);
      - `mD` without `xc` (the `xc`-only paths don't exist on macOS/Linux, so realpath fails and the session is kept);
      - an empty `CLAUDE_CONFIG_DIR` in `from_process` (env glue).
    - Flake: 20/20 (golden and unit tests). Clone gate 352.
    - No e2e: nothing reaches this code yet, because `/api/sessions/all` (D19) is still proxied to Next. `workspace-move-sessions` and `session-tab-switch` read that route from the backend and will cover it once D19 lands; `cc-parity-2.1.196-readable-session-names`, `session-account-attribution` and `cc-parity-2.1.191-cleared-from-banner` stub it with `page.route`. The user's running app holds `.next-e2e`.
    - New dependency: `unicode-normalization` 0.1.
    - Merged from the parallel clone.
- [ ] **S34** Section exit: re-run I04, then I05. Every `/api/sessions/:id/*` route is now served by Rust and none answer 501.

## 4. Global, session-aware services (no more degraded proxying)

- [x] **G01** Notification bus. (All parts done: G01a–G01c; the session emits are S31.)
  - [x] **G01a** `lib/server/notification-bus.ts` (988) + `notifications-db.ts` (445). In-process bus, persistence, kinds, actionable items, workspace scoping, dedupe.
      — done 2026-10-27 (background agent): `claudius-core::notification_bus` ports `notification-bus.ts`, and `notifications_db.rs` the inbox half of `notifications-db.ts` (no routes, no SSE).
      - Ported:
        - `record` in TS's order: subagent skip; cwd → workspace through a workspaces.json map cached on its mtime and read the way `listWorkspaces` reads it; `mapEventToKind` with every odd-typed field read as the JS reads it and V8's TypeError messages; `isKindEnabled`; the S24 mute with the clock read lazily; `INSERT OR IGNORE` dedupe; the `notification` fan-out except an idle / error row for an unwatched session.
        - The status sync (also for filtered events, not with the master switch off), the cold-cache prime, and the per-workspace coalesced `state` flush (versions one past the last sent or answered, read through the cached rw handle, else the ro one, else nothing).
        - `list` / `listAcrossWorkspaces` / the mark-read family / the request-id and orphan sweeps / `getWorkspaceState` / `getAllWorkspaceStates`, and `subscribe` (an mpsc receiver; dropping it unsubscribes, and a closed receiver is pruned).
        - Injectable clock, id source and timers (`Timers::Manual` + `run_timers` for tests; `Auto` = 1 ms later on the caller's tokio runtime or a thread). `NotificationBus::global()` is the process's bus.
        - API for G01b: `list`, `list_across_workspaces`, `mark_read`, `mark_all_read`, `mark_read_by_kind`, `mark_read_by_session`, `get_workspace_state`, `get_all_workspace_states`, `record_session_event` (dev-emit). For G01c: `subscribe()` + `StreamEvent::to_json()`.
      - Found: dedupe still uses up an id and schedules the status-sync state; the mute check caches a read-only handle; a `null` workspaces.json entry fails `getAllWorkspaceStates` only after the other entries have been counted (versions bumped); TS has no retention or pruning beyond db.ts's one-shot abort cleanup.
      - Also fixed in db.rs: open errors no longer carry rusqlite's appended path (`unable to open database file`, as better-sqlite3 throws it). This applies to every open.
      - Differences:
        - numbers bound into TEXT columns print with rusqlite's SQLite 3.50.2, which for some REALs gives fewer digits than better-sqlite3's 3.53.2 (golden odd #7/#11/#143);
        - a `firstLine` cut through a surrogate pair stores U+FFFD where TS stores 3 WTF-8 bytes (odd #81/#143);
        - workspace entries whose `id` isn't a string are skipped;
        - `getAllWorkspaceStates` keys follow workspace order;
        - NaN `createdAt` ties in the cross-workspace sort;
        - a failing flush is logged instead of thrown out of a timer;
        - calls are synchronous (S31 should keep them off the hot path);
        - no HMR singleton migration.
      - Golden: `rust/scripts/notification-bus-golden.mjs` (node@22, real migrations, Date.now / randomUUID / setTimeout stubbed, stable over 2 recordings; re-record leaves the fixture unchanged): 15 scenarios, 699 steps (answer, every subscriber's events, row dumps, cached handles, clock and id reads per step) + 272 pure calls; 695/699 match, 4 listed.
      - Tests: `notification_bus_golden.rs` (7: scenarios, pure, auto timers, drop/reset, closed receiver, state order, NaN cursor), 4 unit tests in `notification_bus`, 1 in `db`.
      - Mutation 91/91: the first pass killed 81/90 (1 didn't compile). New golden steps or tests killed 8 of the 9 survivors. The 9th (the `\r` branch of `firstLine`) was equivalent, since JS `trim` drops that `\r`, so the branch was removed and its replacement mutant is killed. Flake 0/20. Clone gate 357.
      - No e2e: nothing calls the bus yet. `/api/notifications/*` still proxies to the TS app (G01b, G01c) and no Rust session feeds a bus (S31), so `notifications.spec.ts`, `notifications-multi-tab.spec.ts` and `cc-parity-2.1.283-notification-expand.spec.ts` can't exercise it. The bus is covered by the TS-recorded golden on the real DB layer.
      - Its workspaces.json cwd map has its own reader (mtime-cached), separate from D01's store reader; consolidate under I14 if they drift.
      - Merged from the parallel clone.
  - [x] **G01b** routes `notifications` GET, `counts`, `[id]/read`, `read-all`, `read-by-kind`, `read-by-session`, `dev-emit`.
      — done 2026-10-28 (background agent): `claudius-server::notifications` ports `app/api/notifications/route.ts` (GET), `counts`, `[id]/read`, `read-all`, `read-by-kind`, `read-by-session` and `dev-emit` over `NotificationBus::global()`.
      - Ported:
        - The workspace comes from `?workspace=` / `body.workspaceId` when truthy, else the active workspace (cookie, then the store's hint; D01's `read_active_cookie` + `resolve_active_raw`). Neither: 400 `no workspace` (the list answers `{items: []}`). Not in the store: 404 `unknown workspace` (new `workspaces::get_raw_value`, `===` on any JSON type).
        - Bodies are `req.json().catch(() => ({}))` read with `body.x`, so a `null` body is the empty 500.
        - `kind` / `sessionId` are validated before the workspace: `?.trim()`, a non-string throws, `kind` must be one of the 6 kinds (case-sensitive).
        - `dev-emit`: 404 `dev-only endpoint` first when dev routes are off; then `cwd` / `sessionId` / `event` must be truthy; then `resolveTrustedCwd`; `hasSubscribers` only when it is a boolean; answers `{ok, counts: {id: totalUnread}}`.
        - JSON is `JSON.stringify` text; errors are logged under `[api/notifications…]`.
      - Found:
        - `getAllWorkspaceStates` (counts, dev-emit, the stream seed) puts its keys in the order the reads settle: workspaces with a cached read-only handle (or a non-string `rootPath`) first, in order; then the ones that wait on `fs.mkdir` (no handle yet, only a read-write one, `rootPath: ""`). The route keeps that order; the second group stays in workspace order.
        - `workspace=all` ignores `before`. A fractional `limit` is a 500 (`datatype mismatch`) on one workspace but `[]` across workspaces. `workspace` is exact (`ALL` and `wks+…` are 404, `%61ll` is all) and the first one wins. `unreadOnly` only counts as `1`.
        - Cookies: a repeated cookie takes the last value, a value is URI-decoded, an unknown cookie falls back to the hint.
        - A non-string or blank `cwd` in dev-emit means the first trusted root (the server's cwd), so the answer is 200 and no row is written.
        - Store failures: a malformed store makes the list throw but counts answer `{}`; a `null` store throws; a version-2 store reads as empty.
        - A `null` entry: counts and anything past that entry throw, and the stream seeds nothing.
        - A non-string `rootPath`: the list is `[]` but the marks throw (`absPath.replace is not a function`).
        - TS's dev-emit races its states against the bus's flush. Rust's flush runs 1 ms later; under load it can run first, and that step's `state` event is then one version lower. The replay accepts that case; it never happened in 21 runs.
      - Differences (none in the golden; listed in the module docs, pinned by `rust_side_edges`):
        - A workspace stored under a number id is found, but the bus can't address it: list `[]`, `changed: 0`.
        - dev-emit stores a non-string `sessionId` as `String(v)`.
        - Lone surrogates in dev-emit's `sessionId` / event and read-by-session's `sessionId` become U+FFFD; TS stores WTF-8 bytes, which read back as 3 U+FFFD.
        - A body number past the f64 range is `null`, not `Infinity`.
        - dev-emit with a `null` store entry: TS's trusted-cwd check throws first (500). Here the trusted roots skip the entry, so a string `cwd` gets 400 `unknown cwd`; a non-string `cwd` reaches the bus, whose states fail after bumping the other workspaces' versions (also 500).
      - Golden: `rust/scripts/notifications-routes-golden.mjs` (node@22, the real handlers run in Next's `AppRouteRouteModule`, real bus, DB and migrations, temp HOME; Date.now, randomUUID, the bus's setTimeout and the stream's setInterval stubbed; stable over 2 recordings, re-record unchanged). 275 steps, 241 requests, 90 stream chunks, row dumps of 5 cwds.
      - Tests: `claudius-server/tests/notifications_routes.rs`:
        - `replays_the_ts_golden` runs on the real binary and matches every status, type, body, stream chunk and row dump. Recorded ids and clocks map to the server's; a recorded time must fall inside its request. `prod` steps go to a second binary with `CLAUDIUS_DEV=0`. Ten wrong methods get 405.
        - `rust_side_edges` pins the listed differences.
      - Mutation 73/74:
        - 74 mutants: 71 in notifications.rs, 1 in lib.rs, 2 in workspaces.rs. The first pass killed 71.
        - A `rootPath: ""` golden step and a fixed lone-surrogate test killed 2 of the 3 survivors. A full re-run on the final tests gave 73/74.
        - The last one is equivalent: passing `before` to `list_across_workspaces`, which drops it itself.
      - Flake 0/20. Clone gate 510.
      - No e2e: the user's running app holds `.next-e2e`. `notifications.spec.ts`, `notifications-multi-tab.spec.ts`, `cc-parity-2.1.283-notification-expand.spec.ts` and `cc-parity-2.1.207-blocked-session-peek.spec.ts` call `dev-emit`, `read-all`, `read-by-kind` and the list, so they would now reach Rust. The `notifications` › bus spec still needs S31. Merged from the parallel clone (rebased onto main by the merge loop).
  - [x] **G01c** the `notifications/stream` SSE.
      — done 2026-10-28 (background agent): `GET /api/notifications/stream` in `claudius-server::notifications`.
      - Ported:
        - `: connected\n\n` comes first, even with no workspaces. That is what `electron/smoke.ts`'s 10 s first-event check waits for.
        - Then one `data: {"type":"state",…}\n\n` per workspace, in G01b's settle order. Each bumps that workspace's version. A failing store seeds nothing.
        - Then each bus event as its own chunk, `data: <JSON.stringify>\n\n`.
        - `: ping\n\n` every 15 s, the first 15 s after connect. Missed ticks are delayed, not burst.
        - Headers: `text/event-stream`, `no-cache, no-transform`, `Connection: keep-alive`, `X-Accel-Buffering: no`.
        - The stream never ends on its own. A client disconnect drops the body and with it the bus subscription (TS: the abort listener's clearInterval + unsubscribe).
        - Seeding and subscribing both happen in the handler, before the response.
      - Differences:
        - TS subscribes only after an async seed, so events in that gap are lost there; none are lost here.
        - A subscription the bus drops (only `reset_for_tests`) keeps pinging.
        - A toast-able row with a lone surrogate carries U+FFFD in its `notification` event (G01b).
      - Tests: `notifications_routes.rs`:
        - `replays_the_ts_golden`: a monitor stream open for the whole replay, plus 6 short-lived streams, compared chunk by chunk (89 chunks, decoded from HTTP chunked framing).
        - `heartbeat_follows_the_ts_interval`: the fixture's 15000 ms and `: ping\n\n`; no early ping, no catch-up after a stall, pings continue after the bus drops the subscription, dropping the body unsubscribes.
        - `a_closed_stream_unsubscribes`: in-process `axum::serve`; each open stream adds one subscriber and closing the socket removes it.
      - Mutation and flake are shared with G01b.
      - No e2e: the user's running app holds `.next-e2e`. The `notifications*` specs, `notification-background-ask-user-question-pipeline` (e2e-live) and `electron/smoke.ts` would exercise the stream on Rust. Merged from the parallel clone (rebased onto main by the merge loop).

  Accept: http tests + the `notifications-*` e2e specs.
- [x] **G02** Accounts. (All parts done: G02a–G02c; session pinning is S30.)
  - [x] **G02a** `accounts-store.ts` (784) + `account-profile.ts` (261).
      — done 2026-10-27 (background agent): `claudius-core` gains four modules:
        - `accounts.rs`: accounts-store.ts, the validation half of lib/shared/accounts.ts, and token-expiry.ts `shouldWarnTokenExpiring`.
        - `account_profile.rs`: account-profile.ts.
        - `claude_global_config.rs`: claude-global-config.ts.
        - `node_fs.rs`: Node `path.posix.join`/`normalize`, the `fs.mkdir` recursive walk, and `CODE: description, syscall 'path' -> 'dest'` messages.
      API for S30/G02c:
        - `AccountsStore::{new(dir, home), from_env}`, with an injectable clock and random bytes.
        - On the store: `read_raw`, `read_public`, `add_account(&NewAccount)` (raw body values), `set_auto_rotate`, `update_account_metadata`, `rotate_to_next_profile`, `set_active_account`, `delete_account`, `get_active_profile`, `get_profile_by_id`, `build_env_for_profile(_from)`.
        - `AccountProfile::{expires_at, to_public, get}`.
        - `ProfileInfoResolver` holds the 5-min cache (G02c keeps one in AppState) and sits over a `ProfileFetch` boundary.
        - Errors are `AccountsError(js message)`.
      Behaviours recorded from the TS:
        - writes: `JSON.stringify(state,null,2)` (no newline) → `<file>.<pid>.<12hex>.tmp` → rename → chmod 0600; the dir is `mkdir -p` 0777. A symlinked accounts.json is replaced and a looser mode tightened.
        - reads keep a BOM (a parse error) and decode bad UTF-8 as U+FFFD. Missing or dangling → empty. Other failures throw Node's message (EISDIR read without the path; EACCES/ENOTDIR/ELOOP at open; EACCES at the failing mkdir level).
        - read contents: `null` → "Cannot read properties of null (reading 'profiles')". Shape-checked profiles keep foreign keys in order; top-level foreign keys drop on write. A dangling active id reads as null; autoRotate is only `=== true`.
        - add: `.trim` TypeErrors for non-strings; check order label → kind → bedrock/secret; truthy metadata; a numeric expiresAt (NaN/Infinity written as null). The first profile (or one after an empty or dangling pointer) becomes active.
        - rotate: null below 2 profiles, with no active one, or with a same-id peer. It writes before `toPublic`, so a broken Bedrock peer rotates, then throws.
        - delete: an unknown id writes nothing; active falls to the first left; the profile dir is `rm -rf`'d.
        - metadata: truthy and `!==` (equal objects rewrite, numbers compare by value), on every profile with the id.
        - env:
          - the 10 auth vars are scrubbed and the credential set;
          - applyBedrockEnv: USE_BEDROCK=1; drop USE_MANTLE; clear the 5 AWS creds unless ambient; AWS_REGION drops AWS_DEFAULT_REGION; model/prefix/baseUrl set or removed;
          - CLAUDE_CONFIG_DIR is the provisioned `<dir>/profiles/<id>` (0700), a symlink mirror of ~/.claude except .credentials.json, which holds the oauth token (tmp+rename, 0600) or is removed;
          - the account triple is set only when all three are truthy;
          - values are spawn's `String(v)`.
        - profile lookup: status notes (401/403/5xx/other), `fetch failed`, `res.json()` parse messages (two BOMs stripped, lossy), the null-body TypeError, org_type → plan, success-only caching, metadata backfill, `errored` = no email and no plan, and the guess note when the profile has no accountUuid.
        - global config: whitelisted string fields plus boolean hasExtraUsageEnabled, in fixed order; an array → {}; a 30 s cache that also caches null; an empty override is ignored.
      Differences (each listed in the test's KNOWN with its reason):
        - A lone-surrogate `\ud800` reads and writes as U+FFFD, and a 4-unit preview that cuts a surrogate pair shows U+FFFD.
        - Nesting past 128 levels doesn't load (serde).
        - `1e400` in the profile body reads as null (the stored email is kept, no backfill).
        - Deliberate: ids not strictly inside `<dir>/profiles/` (`""`, `.`, `..`, `../x`, …) are never provisioned ("profile id escapes the profiles directory"), and deleting one leaves the disk alone. TS `rm -rf`s every profile dir (`""`) or the whole store with accounts.json (`..`).
        - One process-wide write lock (TS can lose concurrent updates).
        - The backfill runs before returning (TS fires and forgets).
        - mkdir stops with ENOENT where Node's walk spins forever (relative path, deleted cwd).
      Gap: no HTTPS client. G02c must supply a TLS `ProfileFetch`; the workspace's hyper client has none.
      Tests: `tests/accounts_golden.rs` replays 106 cases (477 steps) recorded by `rust/scripts/accounts-golden.mjs` from the real TS under a temp HOME, with a scripted fetch and a pinned clock and randomBytes. After every step it checks the result or thrown message, the fetches, and the whole world tree.
        - Also 210 pure cases: normalize 98, describe 26, toPublic 19, kind 11, region 23, bedrockEnv 5, accountsDir 9, expiry 19.
        - Of the 477 steps, 454 match exactly, 12 match with listed rewrites, and 11 are replayed with their own expectations.
        - Plus a containment test (11 escaping id shapes and a nested id), a secret-redaction check, and node_fs tests verified against node 22.
      Mutation 140/147. The 7 survivors are equivalent or unreachable:
        - tmp cleanup after an accounts.json rename failure, which can't follow a successful read without root or immutable flags;
        - mirroring .credentials.json, which is replaced or removed right after;
        - the `bedrock ?? {auth:"ambient"}` default, which the shape check rules out;
        - a mkdir parent failing with EROFS/ENOSPC;
        - ENOENT for a slash-less path (the same as Node's stat);
        - the deleted-cwd loop guard;
        - write_file's mode before rename+chmod.
      Flake 20/20 (throttled). Clone gate 357/358; the one failure was `bash_golden`'s 16 MiB truncation case timing out at load ~100, and it passed 2/2 alone.
      No e2e: nothing calls the modules until G02c (routes) and S30 (pinning). `cc-parity-2.1.275-status-account`, `cc-parity-2.1.204-token-expiring-notice` and `session-account-attribution` stub accounts in the browser, and `voice-dictation` copies the user's real accounts.json (it skips without one). Merged from the parallel clone; main-tree gate green (444 tests, with G02a, D04, G07a and D06 merged together).
  - [x] **G02b** `account-oauth.ts` (292) + `accounts/oauth`.
      — done 2026-10-28 (background agent): two new `claudius-core` modules and one route module:
        - `account_oauth.rs`: account-oauth.ts (`OAuthFlows::start` / `exchange_code` / `pending_count`, the pending-flow map with its 10-minute sweep) and the route handler's logic (`post_route`), over G02a's `AccountsStore`.
        - `fetch.rs`: the global `fetch` as a boundary (`Fetch`, `Request`, `Response` with `ok` / `text()` / `json()`) and `HttpsClient`, the workspace's one outbound HTTP(S) client, set up to answer like node 22's undici. It also implements G02a's `ProfileFetch`.
        - `claudius-server::accounts_oauth`: `POST /api/accounts/oauth` (process-wide flows, `JsonBody`, Next's empty 500 on a throw). With the dev routes on, `CLAUDIUS_DEV_FETCH_BASE=<url>` sends outbound requests to `<url>/<host>/<path>` (the tests' local fake).
      New dependency: `reqwest` 0.13 (default features off, `rustls-no-provider`: HTTP/1.1, no compression, charset or system proxy) on `rustls` 0.23 with `ring` (no OpenSSL, no cmake) and `rustls-platform-verifier` (the OS trust store). `hyper` becomes a direct `claudius-core` dep for the raw reason phrase. Cargo.lock gains 43 entries, mostly platform-only (Windows, Android, wasm).
      Randomness and clock are injectable (`with_random`, `with_clock`). Production draws from the OS CSPRNG (`getrandom`); a failing source fails the start (empty 500, no flow kept). Tokens, codes and verifiers never reach a log or a `Debug` print.
      Behaviours recorded from the TS:
        - start: 32, 24 and 8 random bytes in that order (verifier, state, `oauth_<16 hex>`), base64url unpadded, S256 challenge. The authorize URL keeps TS's query order and URLSearchParams encoding. Extra body fields are ignored.
        - flows: a flow is kept exactly 10 min (gone at +1 ms) and swept on every start and exchange. An exchange consumes its flow before the code is checked, so any failure needs a new start.
        - body: a parse failure (BOMs, bad UTF-8 read lossily) → 400 `invalid JSON`. `null` → V8's TypeError, Next's empty 500. Anything without an exact `"start"` / `"complete"` action → 400 `unknown action`. Duplicate keys: last wins; `__proto__` is an own key.
        - complete: flowId, code and label must be truthy (400 `flowId, code, label required`). A non-string flowId is unknown. A non-string code → `rawCode.trim is not a function`. The code is JS-trimmed. `a#b` splits at every `#` and uses the first two parts; an empty part → `expected code#state format…`; a foreign state → `OAuth state mismatch — …`. A bare code uses the stored state.
        - the token request: POST, `Content-Type: application/json`, body keys in TS order with `expires_in: 31536000`.
          - 401 → "Invalid authorization code. …".
          - Other non-2xx → `token exchange failed (<status>): <text || statusText>`. A body read failure counts as ""; a blank body is kept.
          - A 2xx body: `res.json()`'s V8 message or `terminated`; `null` → TypeError; a falsy `access_token` → `token exchange returned no access_token`; a non-string token fails in `addAccount`.
          - Redirects: 307/308 keep the POST, 301/302/303 become a body-less GET, 20 are followed. The 21st is `fetch failed`, as is every network failure.
        - result: raw response values pass through (any type). `expiresAt` = now at the exchange + `expires_in`·1000 for any number. `organization_type` → Claude Max/Pro/Team/Enterprise, or nothing.
        - storing:
          - The label is `trim()`, or `Claude (<String(email)>)` for a truthy email, else `Claude`.
          - A non-string label fails with `body.label.trim is not a function` after the token was minted, and nothing is stored.
          - Store errors (unparseable or directory accounts.json, read-only dir, a broken Bedrock peer after the write) → 400 with Node's message.
          - The answer is `{state, emailAddress: email ?? null}`.
        - undici on the wire:
          - `statusText` is the reason as sent (`""` when none).
          - Bodies: two BOMs dropped, lossy UTF-8, chunked and HTTP/1.0 handled; a cut body is `terminated`.
          - Default headers (`accept: */*`, `accept-language: *`, `sec-fetch-mode: cors`, `user-agent: node`) go after the caller's.
          - Proxies only with `NODE_USE_ENV_PROXY=1` (https tunnels with `CONNECT`).
          - Timeouts: 10 s to connect, 300 s of silence.
      Differences (each listed in the tests with its reason):
        - A lone-surrogate escape in the pasted code reaches the token endpoint as U+FFFD (TS sends `\ud800`).
        - `expires_in: 1e400` reads as null, so no `expiresAt` is stored (TS stores `null` for Infinity).
        - A request body nested past 128 levels is a 400 `invalid JSON` (V8 parses it and starts a flow).
        - On the wire: no `connection: keep-alive`; `accept-encoding: identity` and nothing decoded (undici asks for `gzip, deflate`, plus `br` over HTTPS); header names in lower case (undici keeps `Content-Type`).
        - Not recorded:
          - Certificates are checked against the OS trust store (Node: its bundled Mozilla list plus `NODE_EXTRA_CA_CERTS`).
          - reqwest also reads `ALL_PROXY`, fails a `CONNECT` the proxy drops (undici retries) and sends a proxied plain-http request in absolute form (undici tunnels it).
          - The fetch spec's bad-port list isn't mirrored (no caller fetches such a URL).
      Gaps:
        - The route drops no profile-info cache entry after a sign-in (`post_route(…, None, …)`): the Rust server keeps no `ProfileInfoResolver` yet. G02c must keep one in AppState and pass it in (TS `invalidateProfileCache`; the seam is tested).
        - `accounts_oauth::https_client` hands out a `&'static HttpsClient`, but the resolver takes an `Arc<dyn ProfileFetch>`. G02c should move the shared client into AppState as an `Arc`, keeping the dev-base switch.
        - Pending flows live in process memory, as in TS: a restart drops them.
      Tests:
        - `tests/account_oauth_golden.rs`: replays 84 cases (358 steps: 313 route requests, 122 fetches).
          - Recorded by `rust/scripts/account-oauth-golden.mjs` from the real TS on node 22.23.3: temp HOME, `randomBytes` and `Date` pinned, undici's real fetch sent to a local raw-TCP fake.
          - Each step checks the answer or throw, every fetch, the random-draw sizes, the pending-flow count and the whole world tree.
          - 355 steps match exactly; 3 are the listed differences.
          - Plus: PKCE pairing of every recorded verifier and challenge, the constants, a failing CSPRNG, the OS source's freshness, `Debug` redaction, and the cache-invalidation seam.
        - `claudius-server/tests/accounts_oauth.rs`:
          - Replays the 79 post-only cases (303 requests) on the real binary. Its client is pointed at a local fake that serves the recorded responses byte for byte.
          - Compares the 161 requests on the wire (method, path, body, header lines in order minus 3 listed ones).
          - The binary's own random values and clock are checked (shape, S256 pairing, time window), then stand in for the recorded ones.
          - Plus `NODE_USE_ENV_PROXY=1` tunnelling through a proxy.
        - `tests/fetch_client.rs` (8): default headers and their order, caller overrides, failures in undici's words, method normalisation, the base rewrite, the proxy switch, the `ProfileFetch` adapter, and the read timeout (with a 300 ms stand-in: `fetch failed` before the headers, `terminated` after).
        - Unit tests: base64url against node and RFC 7636, the client builder settings, the dev-base switch.
      Mutation 152/155. The 3 survivors are equivalent:
        - `parts.len() < 2`: a string containing `#` always splits into at least 2 parts.
        - `"Claude "` for `"Claude"`: `addAccount` trims the label.
        - Dropping `retry(never())`: reqwest's default only retries HTTP/2 and HTTP/3 NACKs, which are compiled out without those features.
      Flake 20/20 (throttled). Clone gate 464/464.
      No e2e: no spec calls `/api/accounts/oauth`. Its callers are `WelcomeSplash`'s Sign in and the Usage page's add-account flow, and a real flow needs Anthropic's consent page and a live code. `cc-parity-2.1.275-status-account`, `cc-parity-2.1.204-token-expiring-notice` and `voice-dictation` reach accounts only through browser stubs or a copied `accounts.json`. The user's running app holds `.next-e2e`.
      Merged from the parallel clone (rebased onto main by the merge loop).
  - [x] **G02c** routes `accounts` (GET/POST/PATCH/DELETE; live sessions), `accounts/profile`, `account`.
      — done 2026-10-28 (background agent): one route module and one new `claudius-core` module:
        - `claudius-server::accounts`: `GET`/`POST`/`PATCH`/`DELETE /api/accounts`, `GET /api/accounts/profile`, `GET /api/account`. The logic is public (`get_accounts`, `post_accounts`, `patch_accounts`, `delete_accounts`, `get_profile`, `get_account`, each returning a `RouteAnswer`). Each handler builds `AccountsStore::from_env()` per request, as TS reads `accountsDir()` per call. A throw is Next's empty 500, logged as `[api/accounts|accounts/profile|account] <store error text>`.
        - `claudius_core::account_drift`: `AccountPin` (session.ts `accountProfileId` / `accountProfileLabel` / `accountDriftFromActive` and `refreshAccountDrift`'s compare-and-event) and `SessionManager::notify_active_account_changed` (returns how many sessions were asked).
        - session.rs gains the `account_pin` field plus `account_pin()`, `set_account_pin()` (the seam S30 will set) and `refresh_account_drift(store)`.
      G02b gaps closed:
        - `AppState::new(mgr, proxy, dev_routes)` holds `https: Arc<HttpsClient>` (`accounts_oauth::https_client(dev_routes)`, still honouring `CLAUDIUS_DEV_FETCH_BASE`) and ONE `profile_info: Arc<ProfileInfoResolver>` over it.
        - The OAuth sign-in passes `Some(&app.profile_info)` to `post_route`.
        - `claude_global_config::global_shared()` is the `Arc` behind `global()`, so the resolver and the splash share one 30 s cache.
      Behaviours recorded from the TS:
        - GET: `readAccountsPublic()`. Profiles that fail the shape check drop out, an active id that isn't found becomes null, and a non-boolean auto-rotate becomes false. A missing store gives `{profiles: [], activeProfileId: null, autoRotateOnRateLimit: false}`. Every store error throws: V8 parse text, EISDIR / EACCES / ENOTDIR, a `null` file (TypeError), or a Bedrock peer whose `toPublic` refuses (`cfg.accessKeyId.slice is not a function`).
        - POST:
          - A body that doesn't parse is a 400 `invalid JSON` (one or two BOMs are stripped; bad UTF-8 is read lossily). A `null` body throws.
          - `!label || !kind` → 400 `label, kind required`. Arrays, scalars and a `__proto__`-only body end up here.
          - A kind other than exactly `"bedrock"` with a falsy secret → 400 `label, kind, secret required`.
          - Then `addAccount`'s own messages and Node errors → 400 with the message.
          - `bedrock` is passed only for kind `bedrock`.
          - If `toPublic` fails after the write, it's a 400 and the profile stays.
          - The new id leaves the profile cache. The answer is `{state, profileId}`; the first profile becomes active.
        - PATCH:
          - A `null` body throws (`reading 'activeProfileId'`). It needs a truthy `activeProfileId` or a boolean auto-rotate.
          - Auto-rotate is written first, then the switch. A non-string id reads the store, then fails with `profile not found`.
          - Then every live session refreshes its drift, then the public state is returned.
          - A store error is a 400, and anything already written stays.
        - DELETE: `?id` is required (400 `id required`), using URLSearchParams semantics (first value, `+` and percent-decoding). An unknown id changes nothing; every profile holding the id is removed and the active pointer hands over. The id leaves the cache. A store error throws.
        - profile:
          - Uses `id`, else the active id (an empty one gives `{info: null}`). A store error throws.
          - `refresh` must be exactly `"1"` (the first value) to skip the cache.
          - An unknown id gives `{info: null}`. Lookups that fail are not cached. A Bedrock config that `describeBedrockConfig` refuses throws.
        - account:
          - 400 `sessionId required`; 404 `session not found` (live sessions only, no resume); 500 `no active query`.
          - An initialize the CLI refuses → 500 with its message. An initialize answered `null` → 500 `Cannot read properties of null (reading 'account')`. No `account` key → empty 500 (`NextResponse.json(undefined)`).
          - Otherwise the `account` value as sent. A CLI that exited after initialize still answers.
        - drift:
          - Only a pin with a non-empty id and label reports.
          - The drift is the active profile unless it is the pinned one; a store that fails to read counts as no active profile.
          - `account_changed` `{type, account: {id, label, driftFromActive?}}` goes out only when the drift's id or label changed.
      Live sessions: nothing pins a session yet, so in production a switch changes no session (as TS for a session started without an account). Left for S30: `resolveAccountProfile` (pin plus `buildEnvForProfile` at start, the `ready` event's `account`, `mergeSessionState`), `moveToActiveAccount`, `GET/POST /:id/account`, `noteAccountAutoRotateObservation`, `activeProfileExpiresAt` and `session-accounts.ts`.
      Differences: none recorded. Not recorded:
        - A lone-surrogate escape in a body reads as U+FFFD, and a body nested past 128 levels is a 400 `invalid JSON` (as G02a/G02b).
        - TS refreshes sessions with `Promise.all`; Rust does them in turn (same events).
        - The resolver's store dir is fixed at startup; the routes read it per request.
        - The wire differences are as in G02b.
      Tests: `rust/scripts/accounts-routes-golden.mjs` drives the real three route modules over the real accounts-store, account-profile and claude-global-config (node 22.23.3, temp HOME, `randomBytes` and `Date` pinned, undici sent to a local raw-TCP fake). `GET /api/account` runs on bare `Session.prototype` hosts with a real SDK `query()` against the fake CLI. PATCH and notify run on pinned hosts in the real `sessionManager`. Two runs must match; the file is ASCII-only, and a re-record leaves the fixture unchanged. `claudius-server/tests/accounts_routes.rs`:
        - 34 cases (302 requests, 25 profile fetches) on the real binary, a fresh server and world per case, with the HTTPS client on the fake via `CLAUDIUS_DEV_FETCH_BASE`. It checks status, type and body byte for byte; every profile request (headers minus host / connection / accept-encoding); and the world tree after each step (new ids and `createdAt` window-checked, then substituted). It also checks that no secret appears in the server's debug log and that each of the 40 throws is logged under its route tag.
        - 14 `account` groups (24 requests) on the binary: a session on the scripted fake CLI, one with no CLI, one exited.
        - 3 drift scenarios (25 steps) in process: real sessions in a `SessionManager`, pinned through `set_account_pin`. Each step compares the answer or count, each session's `account_changed` events and pin, and the store.
        - `a_post_drops_the_new_id_from_the_profile_cache`: a pinned store random, so POST's invalidation is visible.
        - Unit: `account_drift` (2), `claude_global_config::global_is_the_shared_reader`.
      Mutation 52/56; the 4 survivors are equivalent:
        - `bedrock` passed for a non-Bedrock kind: `addAccount` ignores it.
        - `is_set` forced true, and the session's early return removed: both only skip a side-effect-free store read, and `refresh` re-checks the pin.
        - The sign-in's `Some(resolver)` → `None`: an OAuth id is fresh OS randomness, never cached; the core seam is G02b-tested.
        Not run: a resolver over a client without the dev base, because it would call the real api.anthropic.com. The wire-count assertions cover it.
      Flake: 20/20 throttled runs green.
      No e2e: the user's app holds `.next-e2e`, and no spec asserts these routes.
        - Every page with `WorkspaceSwitcher`, and `WelcomeSplash`, fires `GET /api/accounts` unasserted.
        - `cc-parity-2.1.284-rate-limit-options` lands on `/usage`, which fetches all three routes, unasserted.
        - `cc-parity-2.1.275-status-account` (a stubbed `driftFromActive` on the stream), `cc-parity-2.1.204-token-expiring-notice` and `session-account-attribution` stub accounts in the browser.
        - `voice-dictation` copies the real `accounts.json`.
        - No spec drives POST / PATCH / DELETE or a live `account_changed`.
      Clone gate green: 588 tests.
      Merged from the parallel clone (rebased onto main by the merge loop; G01b's new `notifications_routes.rs` switched to `AppState::new`).
- [x] **G03** MCP config: `lib/server/mcp.ts` (208) + routes `mcp` GET/POST, `mcp/[name]` DELETE, `mcp/[name]/toggle`, `mcp/[name]/reconnect` (fan out to live sessions). deps: S15
  — done 2026-10-27 (background agent): `claudius-core::mcp_config` ports `lib/server/mcp.ts` (`listConfigured`, `upsertServer`, `removeServer`, `findConfigWhitespaceWarnings`); `claudius-server::mcp_config` mounts `GET/POST /api/mcp`, `DELETE /api/mcp/:name`, `POST /api/mcp/:name/{toggle,reconnect}`. There is no fan-out: each TS route looks up one session by id (`sessionManager.get`), so Rust uses `app.mgr.get` plus the S15a controls and a new `Session::mcp_server_status_reply` (a small self-contained session.rs hunk).
  Behaviors found and mirrored:
    - `name in servers` also matches Object.prototype names (Array.prototype names for an array), so `DELETE /api/mcp/toString` rewrites the file and answers ok.
    - Deleting an array index leaves a `null` hole; deleting `length` is a 500.
    - A string `mcpServers` spreads into one entry per UTF-16 unit.
    - An empty or whitespace-only `.mcp.json` counts as missing, but an empty settings file is a 500.
    - A primitive `.mcp.json` makes upsert a 500; an array is rewritten unchanged with a 200.
    - A `null` settings file is a 500 on GET, POST and DELETE.
    - The POST key is `String(name)`: arrays are joined, `1e400` becomes `"Infinity"`, an object with its own `toString` is a 500. A `1e400` config passes the truthiness check and is written as `null`.
    - Validation order: POST checks scope, then name/config, then cwd; DELETE checks cwd, then scope.
    - toggle matches only a string `sessionId`, and `enabled` is read by truthiness.
    - In the GET body, `status` is `null` without a session, and left out when the CLI reply has no `mcpServers`; a `null` reply puts V8's TypeError in `statusError`.
    - Whitespace warnings use JS `\s` and throw where V8 throws.
    - A trusted root that doesn't exist is created (`mkdir -p`) by both writers.
  Shared changes:
    - `settings::write_settings` writes JS `JSON.stringify` text (number text, key order) for every caller.
    - `resolve_trusted_cwd`'s empty-input check uses JS `trim`.
    - Body SyntaxErrors and thrown TypeErrors are logged with V8's text.
  Recorder: `rust/scripts/mcp-config-golden.mjs` (node@22, temp roots, ASCII-only, two identical recordings) records:
    - 81 warning configs (43 flagged, 12 throws);
    - node 22's prototype names;
    - 15 groups, 423 requests through the real route handlers, with a real SDK query on the fake CLI for the live, error, 11 status-shape and no-query groups.
  Tests:
    - `claudius-core/tests/mcp_config_golden.rs` (2): the warnings and thrown text word for word, and the prototype lists. Plus 5 unit tests.
    - `claudius-server/tests/mcp_config.rs` replays every group on the real binary. Per request it checks the status, content type and body byte for byte, V8's error text in the server log, every watched path (kind, mode, bytes, symlink target), the `mcp_*` wire and the next turn's `mcp-delta` reminder. After each group it checks the final tree.
  416/423 match; the 7 others are in 6 listed GAPS sections: lone surrogates (4) and nesting past 128 levels (2).
  Other differences:
    - A malformed or non-UTF-8 percent-escape in `:name` is decoded by axum, where Next answers its DecodeError 400 (as on the other `[param]` routes).
    - `resolve_trusted_cwd` has no 5 s per-root `git worktree list` cache (pre-existing).
    - The handlers do synchronous fs I/O.
    - Not recordable: a CLI success reply without `response` leaves `status` out, where the SDK would put a TypeError in `statusError`.
  Found, not fixed:
    - settings.rs 131/155/184 use `Map::remove` (`swap_remove` under `preserve_order`), which reorders keys where TS `delete` keeps their order.
    - trusted_cwd.rs 106/116/177 (workspace roots, additionalDirectories, `project_config_root_for`) still use Rust `trim` where TS uses JS `trim`; not recorded.
  Mutation 99/105; the 6 survivors are equivalent:
    - `flag` without its null filter: `String(null)` has no edge whitespace.
    - url flagged without `in`: `url` isn't a prototype name, and primitives already threw at the `in`.
    - record without its truthy filter: the entries of a falsy JSON value are empty.
    - the mcp.json dedupe without its scope check: only user entries are listed at that point.
    - GET looking up an empty sessionId: no session has id "".
    - toggle's Infinity stand-in `"Infinity"` instead of `true`: both are truthy and neither is a session id.
  Flake 0/20. Clone gate 353; main-tree gate with G03 merged: 375 passed, 0 failed.
  No e2e. `mcp-integration` › "config round-trips through POST/GET /api/mcp" and `cc-parity-2.1.218-mcp-whitespace-warning` call the real routes and would cover them on Rust. The other `/mcp` specs (`cc-parity-2.1.284-mcp-reconnect-all`, `cc-parity-2.1.268-mcp-needs-auth-badge`, `sdk-update-0.3.274-mcp-source-badge`, `sdk-update-0.3.280-mcp-tool-ui-badge`) stub `/api/mcp` in the browser. Merged from the parallel clone.
- [x] **G04** Plugins: `plugins.ts` (412) + routes `plugins` GET/POST, `plugins/available`, `plugins/reload` (live sessions: `getPluginLoadErrors`, `reloadPlugins`). deps: A01
  — done 2026-10-28 (background agent): ported `plugins.ts` → `claudius-core/src/plugins.rs`, with the `lib/shared` helpers it runs on (`marketplace-settings.ts`, `plugin-ref-lint.ts` `lintMarketplaceName`, `plugin-metadata.ts`, `plugin-config.ts`, `parse-init.ts`'s `plugin_errors` reader, `reload-plugins.ts` `isForceReload`, `settings-load-error.ts` `pluginSettingsWriteBlockedMessage`), and the routes `plugins` GET/POST, `plugins/available` GET, `plugins/reload` POST → `claudius-server/src/plugins.rs`. Session (small hunks): `plugin_load_errors`, set from every `system/init` (newest wins, an init without errors clears them), and `Session::reload_plugins(hold)` over `QueryHandle::reload_plugins` (`no active query` without a CLI).
    - Behaviors found:
      - Enable writes `enabledPlugins[String(pluginId)] = true`. Disable deletes the key, and the last key drops `enabledPlugins`. Any truthy pluginId is a key: `5`, `1.5`, `true`, `[1,[2,null]]` → `1,2,`, `{}` → `[object Object]`, `1e400` → `Infinity`. An own-`toString` object is a V8 TypeError (empty 500). `__proto__` adds nothing unless it is already an own key. The key is computed after the file is read.
      - Listing, per scope: a file that doesn't parse is listed empty with `parseError`. A `null` file is a 500 (`reading 'enabledPlugins'`). A string, number or bool file is the `in` TypeError (`in abc`, `in ` for `""`, `in Infinity`). An array file lists empty. `additionalMarketplaces` / `allowedMarketplaces` are used only when the canonical key is absent, and every write moves the alias to the canonical key.
      - GET with `sessionId` sends `reload_plugins` with `hold_on_cache_impact: true` to that one session only. `pluginErrors` is read before the reload and dropped only when `error_count === 0` (`"0"` keeps it). `installed` is the reply's `plugins`, enriched from each plugin's `plugin.json`, with the manifest dir confined to the plugin path. A `null` reply is an empty 500. A failure fills `installedError`. An unknown session, an untrusted cwd or a listAll failure sends nothing.
      - Reload: `force` is the first `?force=`, and only `1` / `true` (case-sensitive) drop `hold_on_cache_impact`. The reply passes through as JSON (`"str"`, `[1,2]`, `5`, `null`). A failure is 500 `{error}` (`no active query`, `Query closed before response received`, the CLI's message, `""`). Otherwise 400 `sessionId required` (empty too) or 404 `session not found`.
      - POST order: body parse (empty 500) → scope → cwd → kind/op checks → write. A scope file that doesn't load is a 422 naming it. Infinity is truthy for pluginId / enabled / source, and `index: 1e400` counts as a number (writes print it as `null`). Add-extra refusals come in TS order: name required → lint (curly-quoted messages) → legacy array → source kind → already exists.
      - Available: lists only directory entries under `homedir()/.claude/plugins/marketplaces`. ENOENT gives `[]`; any other readdir error (ENOTDIR, EACCES) is an empty 500. Missing metadata falls back to the plugin dir's `plugin.json`. Install counts: later rows win, and Infinity sorts first but prints `null`. Sort is installs descending (missing counts as -1), then `localeCompare`.
    - Differences, none of them in the fixture:
      - A lone surrogate (in a file or the body) becomes U+FFFD.
      - Nesting past 128 levels: a settings file lists with `parseError` and a write gets the 422; such a body is the empty 500. V8 reads both.
      - A top-level `-1e400` file's TypeError says `Infinity` (log text only).
      - An astral character in a string settings file spreads as two U+FFFD (shared `settings::spread`, as in G03).
      - A string spelled NUL+`js:Infinity` reads as Infinity (as G05).
      - Not recordable: a CLI reply without `response` is `{}` (GET 200, reload `{}`) where TS gets `undefined` (GET 500).
    - Tests:
      - `rust/scripts/plugins-golden.mjs` drives the real TS under node 22: temp HOME / CLAUDE_CONFIG_DIR, real `new Session().start()` against the fake CLI. Two runs identical, fixture stable on re-record, ASCII-only, eslint clean.
      - `claudius-core/tests/plugins_golden.rs` (11 tests) replays 437 module cases, including 16 `listAvailable` homes and 23 `enrichInstalled` lists.
      - `claudius-server/tests/plugins.rs` (7 tests) replays 274 requests on the real binary in 6 groups: listing 46, writes 186, available 6, two live sessions 30 (23 `reload_plugins` lines on the wire), no query 3, exited CLI 3. It checks status, content type and body, V8 errors as logged, every watched path's change, the wire, and the final tree. All match.
    - Mutation: 129/130 killed, 0 unviable. The one survivor is equivalent: `crate::js_num(n)` → `json!(n)` for `installs`, which prints the same through `js::stringify`, non-finite included.
    - Flake 0/20 (core golden, server routes, `--lib plugins::`). Clone gate: 526 passed, 0 failed.
    - No e2e: the user's app holds `.next-e2e`. Every plugins spec stubs the routes in the browser: `cc-parity-2.1.295-plugin-settings-invalid`, `cc-parity-2.1.295-marketplace-name`, `cc-parity-2.1.296-marketplace-reserved-name`, `cc-parity-2.1.295-plugin-option-constructor`, `cc-parity-2.1.275-plugin-install-marketplace`, `sdk-update-0.3.214-plugin-version`, `sdk-update-0.3.283-plugin-load-errors` (`/api/plugins`, `/api/plugins/available`) and `sdk-update-0.3.268-reload-plugins-hold` (`/api/plugins/reload`). Only `site-screenshots` (`/plugins`) would reach the Rust routes unmocked. Merged from the parallel clone (rebased onto main by the merge loop).
- [x] **G05** Agents: `agents.ts` (165), `db-agents.ts` (187), routes `agents` GET/PUT, `agents/[name]` DELETE, `agents/db`, plus `loadDbAgentsForOptions` in session start.
  — done 2026-10-27 (background agent): ported `agents.ts` → `claudius-core/src/agents.rs`, `db-agents.ts` → `db_agents.rs`, the parse half of `yaml` 2.9.0 → `yaml/`, and the routes `agents` GET/PUT, `agents/[name]` DELETE, `agents/db` GET/PUT/DELETE → `claudius-server/src/agents.rs`. `localeCompare` is D04's ICU4X `collate.rs` (G05's own table was dropped on merge; both agents tests pass against D04's).
    - `agents.rs`:
      - scopes, `agentsDir`/`agentPath` with the inline containment check at each fs sink;
      - `listAgents`: scandir's strcmp order, then a stable `localeCompare` sort;
      - `readAgent`, `deleteAgent`, `parseFrontmatter` (BOM, CRLF);
      - `writeAgent` in TS check order: name regex on `String(name)`, `:` in the frontmatter name, `name.length`, the frontmatter name's length, the path; Node's recursive-mkdir walk and its `CODE: desc, syscall 'path'` text.
    - `db_agents.rs`: name rules, `coerceAgentDefinition` in TS field order, list (read-only open) / upsert / delete on `db_agents`, `loadDbAgentsForOptions`.
    - `yaml/`: lexer, CST parser, composer with core / yaml-1.1 schemas, `toJS`, and the flow stringifier that names object-valued map keys.
    - Saving or deleting a file agent calls `reload_plugins` on every live session in the cwd and answers `reloadedSessions`. Session start puts the DB agents into `Options.agents` (2-line `session.rs` hunk).
    - Mirrored behaviours:
      - `name: 1e400` saves `Infinity.md` and `["x"]` saves `x.md`; `writeAgent(null)` throws V8's TypeError (the route returns 400 `name required` first).
      - A non-WAL `.claudius.db` lists `[]` (the read-only open's `journal_mode=WAL` fails) until a write migrates it.
      - A foreign `db_agents` table without a key fails the upsert with SQLite's `ON CONFLICT clause does not match…` (400).
      - A cyclic frontmatter (`&x [*x]`) gives an empty 500 on the listing and the read.
      - PUT `agents/db` reloads nothing (DB agents reach a session only at start); integer-like names come first in `Options.agents`.
    - Differences:
      - yaml nesting past 1000 levels fails the parse (V8 runs out of stack somewhere past ~700–1700 levels and yaml reports that); a lone surrogate becomes U+FFFD; a `Date` map key is named in UTC; values nested past 2000 levels fail `JSON.stringify`.
      - Bodies nested past 128 levels fail in serde (PUT `/api/agents` → empty 500, PUT `agents/db` → 400) where V8 parses them.
      - A string spelled exactly NUL+`js:Infinity` / `js:-Infinity` reads as ±Infinity (the sentinel that keeps `1e400`).
    - Tests:
      - `tests/agents_golden.rs` replays `rust/scripts/agents-golden.mjs` (node 22, type stripping, temp HOME/CLAUDE_CONFIG_DIR, TZ=UTC, recorded twice, identical): 2 107 `YAML.parse` sources (hand corpus + two seeded fuzz corpora: error and warning codes plus the `JSON.stringify` result), 998 names / 2 500 pairs of `localeCompare`, 57 frontmatter splits, 128 file steps plus the tree, 83 `coerceAgentDefinition` inputs, 33 DB steps plus rows, and 4 session starts (the `agents` in the `initialize` request on the fake CLI).
      - `claudius-server/tests/agents_routes.rs` replays the route handlers' 147 steps (145 requests) on the real binary (status and body byte for byte, then files and rows), and 10 steps with two live sessions (the `reload_plugins` control requests on the wire).
      - All recorded cases match.
    - Mutation 92/97 (A05, Y05, Y12 killed by added recorder cases). The 5 survivors are equivalent or unreachable:
      - an array name's `.length` never reaches the cap;
      - the mkdir walk's non-dir-parent arm needs a race;
      - yaml's flow-indicator early break is redone on the next character;
      - `\L` for U+2028 is dead in the package too (`JSON.stringify` never writes ` `);
      - the document-marker quote at `implicitKey && indent == step` can't happen when keys are stringified from indent 0.
    - Flake 20/20. Clone gate 358 (before the rebase onto main).
    - No e2e: the user's app holds `.next-e2e`. Specs that would cover it: `workspace-cwd-binding` (GET `/api/agents?cwd`), `cc-parity-2.1.218-agent-name-colon` (PUT with a `:` name), `sdk-update-0.3.271-omit-claude-md` and `sdk-update-0.3.296-auto-compact-window` (Agents page listing), `site-screenshots` (agents page); none calls `agents/db` or DELETE.
    - `agents.rs`'s path helpers and mkdir walk overlap `node_path.rs` (D04) and `node_fs.rs` / `node_err.rs` (G02a / D10a): fold them in under I14.
    - Merged from the parallel clone (rebased onto main by the merge loop: D04's `collate.rs` kept).
- [x] **G06** Models: `GET /api/models` (curation, settings, live `supportedModels`) and `GET /api/models/probe` (212).
  — done 2026-10-28 (background agent): new `claudius_core::models`: `model-picker-curation.ts` `applyModelPickerCuration`, the models route's `STATIC_FALLBACK`, the session model route's `ALWAYS_SHOWN_ALIASES` + `listAlreadyCoversAlias` (as `session_model_list`), and the probe route's `PROBE_CANDIDATES` / `probeOne` / `GET` (as `probe_one` / `probe_all`). Routes `GET /api/models` + `GET /api/models/probe` → `claudius-server/src/models.rs` (one `.merge` line). `GET /api/sessions/:id/model` now uses the same core code; its private curation copy and 2 unit tests moved to `claudius_core::models`. No `Session` change: the routes read `Session::query_handle()` → `QueryHandle::supported_models()` / `initialization_result()` (the SDK's `supportedModels()` is the `initialize` reply's `models`). No HTTPS client is needed: the probe's only outside call is the `claude` CLI it spawns per model (the sessions' `--claude-bin`), so the CLI is the boundary and the tests run the fake CLI.
    - Behaviors (recorded from the TS):
      - `modelPicker` is read per request from `homedir()/.claude/settings.json` (not `$CLAUDE_CONFIG_DIR`). A file that doesn't load (missing, a directory, unreadable, malformed, BOM, trailing garbage, a `null` / number / string / array file, a dangling symlink) is `undefined`. Bytes are read as lossy UTF-8; a `1e400` literal reads as a stand-in, because the curation never prints numbers.
      - `GET /api/models`: the oldest live session whose `supportedModels()` is a non-empty array and whose curation doesn't throw answers `source: "session"`. A failing, empty, non-array or curation-throwing session is skipped. Otherwise the curated static list answers `source: "fallback"`. A curation throw on the fallback is Next's empty 500, logged `[api/models] GET failed: TypeError: …`. A CLI that exited after `initialize` still answers. SDK rows re-serialize by JS rules (number text, key order, unicode).
      - Curation throws V8's TypeError word for word: for an array picker or non-array `entries` (`picker?.entries?.filter is not a function`), a `null` entry, a truthy non-string `id` (`e.id.trim is not a function`), a non-nullish non-string `label`, and, when appending, a `null` model row. It trims like JS `trim`; only `mode === "replace"` replaces; appending dedupes by string `value`.
      - `GET /:id/model` now matches the TS where it used to differ. `[...sdkModels]` spreads a string by code point, and a missing or non-iterable list is a 503 `sdkModels is not iterable`. The alias scan reads each row's `value` and `displayName` (`(m.displayName ?? "").toLowerCase is not a function`; `null` rows throw). A curation throw is a 503 with the TypeError message. Before, it used Rust `trim`, skipped non-strings, read a missing list as `[]`, and never threw.
      - Probe: 12 pinned candidates run at once and answer in candidate order. Each is a single-turn query (`maxTurns: 1`, `persistSession: false`, `permissionMode: "default"`, `--settings {"advisorModel": <model>}`) with a 20 s budget. The first `assistant` message decides; a truthy `error` fails with its raw value. An `is_error` result fails with `error` ?? `api_error_<String(status)>` ?? `subtype` ?? `unknown_error`, keeping raw JSON values (giving e.g. `api_error_4,0,4`, `api_error_[object Object]`, `api_error_1e+21`). Any other result is ok when `subtype` is falsy or `"success"`. A stream that ends without a verdict is ok. Failures carry the SDK's text: process exits and signals (`Claude Code process exited with code 2. stderr: …`, `… terminated by signal SIGKILL`), a missing binary ("Claude Code native binary not found at …"), and `timed out`. Each probe's CLI is stopped once it answers (TS aborts it in `finally`).
    - Differences:
      - A lone-surrogate escape in settings.json reads as U+FFFD, where TS echoes `\ud800`.
      - A settings.json nested past 128 levels doesn't load in serde_json (no curation); V8 parses it.
      - Probe: an error `result` without an `errors` array makes the SDK's reader throw (`Cannot read properties of undefined (reading 'map')`), while Rust reports its `subtype`. This is the existing SDK-host lenient-reader gap; the CLI never sends that shape.
      - The SDK sets `NoDefaultCurrentDirectoryInExePath=1` on its own `process.env` when it loads (only Windows reads it), so its CLIs inherit it; Rust doesn't set it.
      - Not recorded: TS picks the first session in the order `create()` published them (after `start()`), Rust by `created_at`. The user settings path follows `CLAUDIUS_STATE_HOME` (TS: `os.homedir()`), as `settings.rs` already does.
    - Tests: `rust/scripts/models-golden.mjs` (node 22.23.3, SDK 0.3.299) runs the real handlers, with the real SDK `query()` against the fake CLI through a shim that only adds `pathToClaudeCodeExecutable`. Two runs are byte-identical, the file is ASCII and eslint is clean. It writes `claudius-core/tests/fixtures/models_golden.json`.
      - `claudius-core/tests/models_golden.rs`: 378 curations (6 lists × 63 pickers: 200 results, 178 TypeErrors) and the constants.
      - `claudius-server/tests/models.rs`, on the real binary:
        - 81 fallback requests, each with its own settings.json (text, raw bytes, a dir, unreadable, symlinks, `1e400`, `__proto__`, nesting): 79 match and 2 are listed differences; the log line is checked too.
        - 6 scenarios with 17 live fake-CLI sessions: 21 `GET /api/models` and 55 `GET /api/sessions/:id/model` requests, all matching.
        - 8 probe cases × 12 candidates: 96 results (1 listed difference) and 84 CLI wire logs of argv, env delta and stdin (1 listed env key). Two 20 s timeouts run at once, and no CLI is left once the probe answers.
      - 3 unit tests in `models::tests`.
    - Mutation: 73/75 killed. The 75 mutants ran one at a time on the scoped test binaries, with a checksum restore after each. The other 2 are equivalent:
      - `r01` showed the server's own `json_parse_error` pre-check was redundant (`js::json_parse` runs it first), so the check was deleted.
      - `p25` (the `probe threw unexpectedly` text) is reached only if a probe task panics, just as TS reaches it only if `probeOne`, which catches everything, rejects.
      All sources were restored (sha256 match).
    - Gate (clone): fmt, clippy `-D warnings`, 450 passed, 0 failed. Flake 0/20 on the three G06 test binaries (throttled). Route coverage `--check` is clean.
    - No e2e: the user's running app holds `.next-e2e`. `cc-parity-2.1.245-model-picker-setting` writes `modelPicker` through `/api/settings/full`, then calls the real `GET /api/models`, so it would cover the curation on Rust; both servers run with `HOME=E2E_HOME`, so they read the same file. `cc-parity-2.1.295-advisor-unavailable` mocks `/api/models`. `sdk-update-0.3.170-fable-model`, `model-picker`, `advisor-picker` and `cc-parity-2.1.299-bare-model-picker` mock `/api/sessions/:id/model`. No spec calls `/api/models/probe`; only `ModelPicker.tsx` does. Merged from the parallel clone (rebased onto main by the merge loop).
- [~] **G07** Scheduler.
  - [x] **G07a** `scheduler-store.ts` (228) + `scheduler.ts` (306), booted from `main.rs` (TS boots it in `instrumentation.ts`).
      — done 2026-10-27 (background agent): new `claudius_core::scheduler_store` (`scheduler-store.ts`) and `claudius_core::scheduler` (`scheduler.ts`). `main.rs` boots the scheduler only with `--scheduler` or `CLAUDIUS_SCHEDULER=1|true|yes|on`. It is opt-in because Next boots its own scheduler (in `instrumentation.ts` and on every schedule route) on the same `~/.claude/claudius/schedule/jobs.json`, so two would run every job twice. On SIGTERM the server stops the scheduler before ending sessions.
      Store:
        - Jobs and runs stay JSON values, so foreign fields, types and key order survive a rewrite.
        - `jobs.json` is `JSON.stringify(…, null, 2)` plus a newline, written through a `jobs.json.<pid>.<now>.tmp` rename. Every read-modify-write is under one lock.
        - TS's own throws (`JSON.parse`, a read off a `null` entry, `path.join` of a non-string id) and Node's fs errors keep their exact wording.
      Scheduler: time comes from an injectable `Clock` (`TokioClock` on the paused clock in tests), timers run on tokio, run ids come from `SchedulerConfig::run_id`, and the bus is an `on_run_finished` hook (unset until G01).
      Behaviors found and mirrored:
        - Arming:
          - `arm` disarms first, then sets `nextRunAt` from `nextFireAfter(cron, lastRunAt)`. A job stored as disabled gets the patch but no timer.
          - Delays are capped at 24 h, with Node's 1 ms clamp below 1 ms and past 2^31-1.
          - A wake up to 250 ms early fires; one earlier than that re-arms.
          - A fired timer stays in the map until disarmed or re-armed.
          - At wake the job is read as stored; a disabled one neither fires nor re-arms.
        - Missed slots are never caught up: a stale `nextRunAt` and a `lastRunAt` in the future are ignored. A daily 1:30 job fires once on the fall-back day, and one booted in the repeated hour after its run waits until the next day. A `lastRunAt` that isn't a number is no anchor, so that job repeats at 1:30 EST.
        - A falsy cron (`undefined`, `null`, `""`) means every minute (cron-parser's default). `5` and `"  "` get no timer.
        - One run per job: a fire while the job's run is in flight records `{id, jobId, startedAt, endedAt, status: "skipped", note: "previous_run_in_progress"}` and re-arms. It doesn't patch the job or notify the bus.
        - The run:
          - First a `running` record with an empty transcript, then `lastRunAt` / `lastStatus: "running"`, then the live buffer with `ready`.
          - Each SDK message is `{type: "sdk", message}`.
          - Results sum `total_cost_usd` and the `usage` tokens. A truthy non-`success` subtype makes the run `error` with that note; a thrown error adds an `error` event.
          - The finished record replaces the running one in place, in TS key order, with zero values left out.
          - The job is patched (not rewritten from the copy read at start), so edits and deletes made during the run are kept.
          - The bus gets `{type: "run_finished", status, costUsd?, note?}`, then the job re-arms.
        - Live runs: subscribers get a replay; a finished run replays without registering; an unknown run gets `run_not_live`; buffers linger 5 s; `isRunLive` / `isRunAttached`.
        - Foreign ids (`5`, `null`, `undefined`) match with `===`. A non-string id throws TypeError at `path.join` after the job was marked in flight, so it stays in flight for the life of the process (TS parity). A falsy job found by id is no job for `runNow`.
        - Store edges:
          - Past 200 lines, a run file rotates its overflow into `runs.archive.jsonl`.
          - `listRuns` is `slice(-limit)`, newest first: 0 or NaN gives all, a negative limit drops from the start, fractions truncate, and a string is coerced. It skips unparseable lines.
          - `updateRun` drops blank lines, and a run without an id replaces every id-less line.
          - Patching a string job spreads its characters, and an `undefined` patch value drops the key in place.
          - `saveJob(null)` into an empty list stores `null`.
          - A `null` jobs.json throws reading `jobs`, and a non-array `jobs` reads as `[]`.
      Differences:
        - A job id whose run files `path.join` would put outside the schedule root (`../../x`) is refused: `appendRun` throws, `updateRun` is a no-op, `listRuns` gives `[]`. TS reads and writes there.
        - A lone-surrogate escape reads, and is written, as U+FFFD.
        - A non-string `cwd` is no cwd (Node throws on spawn); a non-string `prompt` is sent as its `String()`; a non-number cost or token count counts as 0.
        - An `arm` that fails outside a caller is logged (`[scheduler] arm failed`), and a failed boot doesn't stop the server.
        - `shutdown()` is Rust-only: it stops the timers, ends in-flight runs (recorded as `error` / "Operation aborted") and waits up to 5 s.
        - The scheduler is off by default, where TS always boots it.
      The fake CLI gained a `$wait_file` step.
      Recorder: `rust/scripts/scheduler-golden.mjs` runs the real TS under node@22 (`--experimental-transform-types`, a resolve hook, a virtual clock and timer queue, a temp HOME, `TZ=America/New_York`). It records 14 scenarios: 235 steps and 152 snapshots, SDK 0.3.299. The two recordings in each run are byte-identical, and the fixture is unchanged on re-record.
      Tests:
        - `claudius-core/tests/scheduler_golden.rs` replays every step on tokio's paused clock against the fake CLI. It compares results, every file, timers, in-flight jobs, live buffers, bus calls, subscriber events, and the CLI's argv and stdin. Rust-side tests cover the 250 ms early wake on a late clock, and shutdown.
        - 16 lib unit tests.
        - `claudius-server/tests/scheduler_boot.rs` (5): off by default and for other values; on via the env and via the flag; runs use `--claude-bin`; SIGTERM ends a run in flight.
      Mutation 117/121. The 4 survivors are equivalent or have no reader yet:
        - the temp file name, which is renamed away at once;
        - the bus note's truthiness filter (every note is a truthy subtype or a non-empty error message);
        - `close()` after the stream ended;
        - `set_enabled`, which nothing reads until G07b.
      Flake 0/60 (20 rounds × 3 binaries, 25 tests) at load 13–23, and 0/60 earlier at load 80–125. Clone gate 370.
      No e2e: the only spec that touches the schedule API, `cc-parity-2.1.221-schedule-run-attached`, mocks `/api/schedule` and `/api/schedule/:id/runs` in the browser. The routes are G07b and still served by Next, and the Rust scheduler is off in the parity config.
      Merged from the parallel clone; main-tree gate green (444 tests, with G02a, D04, G07a and D06 merged together).
  - [x] **G07b** routes `schedule` GET/POST, `[id]` GET/PATCH/DELETE, `run-now`, `runs`.
      — done 2026-10-28 (background agent): new `claudius_server::schedule` ports `app/api/schedule/route.ts` (GET, POST), `[id]/route.ts` (GET, PATCH, DELETE), `[id]/run-now/route.ts` (POST) and `[id]/runs/route.ts` (GET) over G07a's `scheduler()` and its store, with `cron::validate_cron` and `trusted_cwd::resolve_trusted_cwd`.
      Coexistence: Next boots its own scheduler unconditionally (`instrumentation.ts`, and `await scheduler.boot()` in every schedule route) on the same `jobs.json`, and these routes are where jobs get armed, re-armed, disarmed and run. If Rust answered them while Next's scheduler runs, a created job would get no timer that fires, an edit would leave Next's timer on the old cron, a run-now would run beside Next's run of the same job instead of recording `skipped`, and every run would read `attached: false`. So Rust answers them only when it runs the scheduler itself (`--scheduler` / `CLAUDIUS_SCHEDULER=1`, `scheduler::enabled()`). Otherwise each request is forwarded to Next unchanged; with no Next, it gets the proxy's 404. `session-loops` (+ `cancel`) and `runs/[runId]/stream` (G07c) always go to Next. `session-loops` is mounted explicitly so that `{id}` doesn't take it. Default behaviour is unchanged.
      Behaviors found and mirrored:
        - Bodies are a bare `await req.json()`. Empty or invalid is Next's empty 500 (V8's `SyntaxError` logged). Any JSON value is accepted, and one or two BOMs are stripped. A number past f64 (`1e400`) is a truthy number for the checks and `null` where stored.
        - POST checks, in order:
          - a nullish or blank `name` is 400 `name required` (a non-string throws);
          - a falsy `cron` is `cron required`, checked before the prompt;
          - a nullish or blank `prompt` is `prompt required` (a non-string throws);
          - a truthy non-string `cron` throws in `validateCron`'s `input.trim()`;
          - then `validateCron`'s message;
          - then `unknown cwd` unless the cwd is registered (no string: the process cwd).
        - POST's job: a v4 id, the trimmed `name` and `cron`, the raw `prompt`, and `model` only when truthy, stored as given (`5`, `true`, `[1,"a"]`). Then the resolved `cwd`, `enabled` unless exactly `false` (`"false"` and `0` count as enabled), and `createdAt` = `updatedAt`. The job is saved and armed when enabled. The 201 body is the job without the `nextRunAt` that arming wrote to the file. A cron that validates but has no slot (`0 0 * * L`) is saved with no timer.
        - GET `/:id`: the job, or 404 `{"error":"not found"}`. The `[id]` segment is percent-decoded, as Next decodes it.
        - PATCH:
          - a `null` body throws (`body.cron` has no `?.`); `[]`, `"str"` and `5` patch only `updatedAt` and re-arm;
          - patch keys in order: `updatedAt`; a string `cron` (validated, trimmed); string `name` / `prompt` (raw, and a blank name is allowed); a boolean `enabled` (`1` and `"yes"` are ignored); `model` (`null` or `""` drops it, another string sets it, other types are ignored); a string `cwd` (resolved, or 400 `unknown cwd`);
          - new keys land after the stored ones, and foreign fields (`id`, `createdAt`, `nextRunAt`, extras) are ignored;
          - the 400s come before the 404;
          - the result is armed if `enabled` is truthy (a stored `1` counts), else disarmed. A new cron with no slot drops the old timer but keeps the stale `nextRunAt`.
        - DELETE disarms first (even for a missing job or a broken store), then deletes the job and its runs file: `{"ok":true}`, or 404.
        - run-now runs the job whether or not it's enabled, without re-arming, and answers 202 `{runId}` only once the run has ended (TS awaits it despite its "fire async" comment), or 404. A second run-now while one is in flight records `skipped` and gets its own 202. A rename during the run is kept; after a delete during the run, nothing is written back. A client that disconnects doesn't cut the run short: the run is its own task, as TS's promise is.
        - runs is `Number(limit || "50") || 50`, then `slice(-limit)`, newest first:
          - `""`, `0`, `-0` and `abc` give 50; a negative limit drops from the start; `Infinity` gives all and `-Infinity` none;
          - `0x3`, `0b11`, `1e1`, ` 2 `, `+1` and `1%2E5e0` are coerced, and the first `limit` wins;
          - a `running` run gets `attached` (a stored `attached` is overwritten in place), and other runs are untouched;
          - a `null` line inside the window throws, one outside it doesn't;
          - a missing job gives `{"runs":[]}`, and a runs file that is a directory gives the EISDIR 500.
        - With a broken store, every route except `runs` throws the store's error as the empty 500 (the JSON.parse text, `Cannot read properties of null (reading 'id')`, EISDIR). `{"jobs":5}` reads as `[]`.
        - A boot that throws does so once (the empty 500) and then counts as booted, so a job written later isn't armed until a route arms it.
      Differences:
        - Rust answers only with `--scheduler` (see above).
        - Not recorded, from `json_parse`: a lone-surrogate escape in a stored field becomes U+FFFD, and a body nested past 127 levels gets the empty 500 where V8 reads it.
        - A throw is logged as one `[api/<route>] <Error>: <message>` line at error level; Next prints the stack.
        - `scheduler.rs` gained two Rust-only debug lines, `[scheduler] armed <key> at <now> due <due> fire <fireAt>` and `[scheduler] disarmed <key> at <now>`. The replay reads them to rebuild the timers.
      Recorder: `rust/scripts/schedule-routes-golden.mjs` drives the real route handlers on the real `scheduler.ts` / `scheduler-store.ts` under node@22. It uses `--experimental-transform-types`, resolve and load hooks, a virtual clock and timer queue, counted UUIDs, the real SDK `query()` against the fake CLI, a temp HOME and CLAUDE_CONFIG_DIR, `TZ=America/New_York`, and registered and unregistered workspace dirs. 5 groups (create and read; patch and delete; run-now and runs; a broken store; boot fails): 227 steps, 211 requests, SDK 0.3.299. The two recordings in each run are byte-identical, and the fixture (`claudius-core/tests/fixtures/schedule_routes_golden.json`) is unchanged on re-record. The .mjs is ASCII-only and passes lint.
      Tests:
        - `claudius-server/tests/schedule_routes.rs` (5):
          - `the_routes_replay_the_ts_handlers` replays every group on the real binary (`CLAUDIUS_SCHEDULER=1`, the fake CLI). After each step it compares status, content type and body text, every file under `~/.claude/claudius`, each world dir's CLI argv and stdin, and the timers. Recorded times must fall within the step's real time window, each placeholder id maps to one v4 UUID, and `nextRunAt` must be the same cron slot counted from now.
          - Without `--scheduler`, all 10 schedule requests reach a stub Next byte for byte, and nothing is written or armed.
          - With it, Rust answers the 7 requests it owns, and G07c's 3 still go to Next.
          - With neither, the proxy's 404.
          - A run-now whose client disconnects during the run still ends, so the next run-now isn't `skipped`.
        - `claudius-server/tests/schedule_attached.rs` (1): the router on a real socket, with the scheduler running the fake CLI. A running run reads `attached: true` while subscribed in process and `false` while unwatched; `?limit` doesn't change that, and an ended run has no `attached`. It also covers the routes' own `boot()` throwing once and then counting as booted.
        - 3 lib unit tests (`run_limit`, `with_attached`, `trimmed`).
      Mutation 69/71 (`schedule.rs` plus the two new log lines in `scheduler.rs`, restored by checksum). The first pass left 5 survivors. New recorder cases killed 3 of them: a lone surrogate in a field nothing reads, a PATCH adding keys to a bare job, and PATCH `enabled: 1`. The 2 left are equivalent:
        - arming a just-created disabled job is a no-op: a fresh id has no timer, and `arm` returns before patching a disabled job;
        - after `save_job` succeeds, `arm` can only fail if the store breaks between two calls in the same request.
      Flake 0/180 (20 rounds × 9 tests, throttled) at load 12–16. Clone gate 453.
      No e2e: the only spec that touches the schedule API, `cc-parity-2.1.221-schedule-run-attached`, mocks `/api/schedule` and `/api/schedule/:id/runs` in the browser. `playwright.rust.config.ts` also runs the binary without `--scheduler`, so every schedule request goes to Next anyway, and the user's running app holds `.next-e2e`.
      Open decision (handing the scheduler to Rust): Next has no switch to skip its scheduler, so `--scheduler` beside a Next upstream still runs two schedulers on one `jobs.json` (G07a's hazard). Making Rust the owner needs a TS change, such as an env var that skips `scheduler.boot()` in `instrumentation.ts` and in the schedule routes, set wherever the Rust binary runs with `--scheduler`. It also needs G07c; until then the run stream (still Next's) finds no live run, and every run reads `attached: false`. Merged from the parallel clone (rebased onto main by the merge loop).
  - [x] **G07c** the `runs/[runId]/stream` SSE, and `schedule/session-loops` (+ `cancel`), which needs S11.
    — done 2026-11-01 (merge loop): new `claudius_server::schedule_live` serving `GET /api/schedule/[id]/runs/[runId]/stream` (the run SSE over `scheduler().subscribe_run`), `GET /api/schedule/session-loops` and `POST …/cancel` (over `session_loops`). Like G07b, the run stream is answered by Rust only with `--scheduler`. Golden: `rust/scripts/schedule-stream-golden.mjs` → `claudius-server/tests/schedule_stream.rs` (+ `schedule_routes` / `schedule_attached` updates). Merged 2026-11-01 from its 2026-10-29 clone. Its agent was cut off by the session limit during mutation testing, before it could report; the one mutant it left applied was restored by checksum. Mutation unfinished, flake not re-run (speed). E2E deferred to the section-exit parity runs (S34 / D28).
  - [~] **G07d** **Decided 2026-10-29: the user OK'd the TS switch.** Hand the scheduler to Rust. Next boots its scheduler unconditionally (`instrumentation.ts` and `await scheduler.boot()` in every schedule route), with no switch, so `--scheduler` beside a Next upstream runs two schedulers on one `jobs.json`. Proposed: a TS-side env var that skips Next's `scheduler.boot()` (instrumentation and the routes), set wherever the Rust binary runs with `--scheduler`; then make `--scheduler` the default. This edits TS outside `rust/`, so it needs the user's OK. deps: G07c, R01
    Decision (user, 2026-10-29): add a TS-side env var (e.g. `CLAUDIUS_RUST_SCHEDULER=1`) checked in `instrumentation.ts` and in the schedule routes' `scheduler.boot()` calls, set by the Rust binary when it runs with `--scheduler`; then make `--scheduler` the default. TS edits outside `rust/` are approved for this task only.
    — TS half done 2026-11-01 (merge loop). One check in `lib/server/scheduler.ts` covers every caller, since `instrumentation.ts` and all five schedule routes go through `boot()` / `arm()`:
      - `rustOwnsScheduler()` reads `CLAUDIUS_RUST_SCHEDULER` (`1` / `true` / `yes` / `on`, trimmed, any case). When it is on, `boot()` returns a resolved promise without reading or arming anything, and `arm()` disarms and returns without setting a timer. So Next still serves the schedule routes and reads the store; it just never fires a job.
      - Set for Next wherever it runs beside the Rust binary: `playwright.rust.config.ts`'s Next `webServer` env, and `rust/scripts/live-smoke.sh`.
      - `tests/unit/scheduler-rust-owner.test.ts` pins both directions (four truthy spellings arm nothing; unset / "" / `0` / `false` arm as before).
      - Rust half (making the scheduler the default, with `--no-scheduler` / `CLAUDIUS_SCHEDULER=0` to opt out) is **R01**'s, together with the scheduler's TS drift. The docs that still say "off by default" are updated when that lands.
- [x] **G08** Memory: `auto-memory.ts` (468) + `memory/auto` (live sessions: `notifyMemoryUpdate`); `rules.ts` (184) + `memory/rules`.
  — done 2026-10-28 (background agent): new `auto_memory.rs` + `rules.rs` (claudius-core), `Session::notify_memory_update` (one method block in `session.rs`; closes S21's "Gap: memory-update (G08)"), and `claudius_server::memory` serving GET/POST/PATCH/DELETE `/api/memory/auto` and `/api/memory/rules`. Ported every export of `auto-memory.ts` and `rules.ts`, session.ts `MemoryUpdate` / `memoryUpdateReminderBody` / `notifyMemoryUpdate`, and both route files with the fan-out to `sessionsByCwd(cwd)`. Behaviors found (TS, mirrored): the memory dir is `homedir()/.claude/projects/<encodeProjectDir(cwd)>/memory`, under HOME and not `CLAUDE_CONFIG_DIR`. `encodeProjectDir` dashes each UTF-16 unit outside `[A-Za-z0-9]` (an emoji is `--`) and never hashes, so a root whose encoded name passes 255 bytes gets Next's empty 500 (`ENAMETOOLONG`) on list, create and read. A registered root containing NUL works for memory but rules refuse it (400 `null byte in path`). A missing or empty `cwd` falls back to the server's cwd. Names must match `^[\w.\-]+\.md$` (ASCII; `..md` and `-rf.md` pass), checked before any fs call; `%2F` / `%00` are decoded first and refused (read → 404, write/patch/delete → 400 `invalid filename`). Listing: strcmp readdir order, case-sensitive `.md`, `stat` through symlinks (dangling and looping links skipped), stable sort on Node's f64 `mtimeMs` (negative before 1970). Create is exclusive (`wx`): an existing file, a directory or any symlink, even dangling, is 409. The front matter goes through `yamlScalar` plus an ISO `modified` stamp. The index line is idempotent on the `(<file>)` substring anywhere in a line. It is refused with 413 above 20 000 loaded bytes (exactly 20 000 is allowed; a leading front-matter block and terminated `<!-- -->` don't count), and that 413 rolls the file back. An index that can't be read (a directory) throws only after the file was written, patched or unlinked: empty 500, change kept, no reminder. Patch keeps `name`; fields are raw JSON values: `??` keeps `0` / `false` / `""`, and a truthy non-member `type` is 400. Everything else is coerced with `String()` / `+` (arrays joined; `{toString: 1}` gives V8's `Cannot convert object to primitive value`). A non-string description with no risky character throws `value.trim is not a function` (empty 500, nothing written). `parsed` echoes the raw values. The first index line naming the file is rewritten when `description !== parsed.description`, so a `null` description rewrites it with the old text. `parseMemoryFrontmatter`: in `^key:\s*(.*)$/m`, `\s*` crosses line ends (`name:   \ndescription: d` gives the name `description: d`), `\r` / U+2028 / U+2029 end lines, CRLF fences don't parse, and a quoted value is `JSON.parse`d back only when that gives a string. Rules: the scope defaults to `project`, and a bad scope is 400 before the cwd check. Project scope needs a trusted cwd, and `assertAbsoluteUserPath` failures are 400 with their message. The name check comes before the directory (a bad name beats a bad cwd) except for list. PATCH needs an existing target (`fs.access` through symlinks; dangling → 404). Every write creates the directory first, even an edit that then 404s. The reminder is sent only for writes that land, to sessions whose cwd equals the request's exactly; a session in another workspace that Read the same file gets nothing. Its stale clause lists the session's Read paths, in first-read order, that equal a changed path, with no normalization. Path safety: the name rule refuses `..`, absolute names, `/`, `\`, `%2F` and NUL before any disk access. Each fs call also has the inline `resolve` + `startsWith(base + "/")` check; given the name rule it never fires. Symlinks inside the dirs are followed as in TS (and as in D04 / G05); see PORT_PLAN "Mirrored TS bugs". Differences: a lone-surrogate escape in a PATCH body reads as U+FFFD, so the response echoes the character where TS writes `\ud83d` (file and index bytes are the same; 1 of 249 requests). The dirs hang off `paths::home_dir()` (`CLAUDIUS_STATE_HOME` moves them). TS's debug-only reminder kind isn't kept (S21). Tests: `rust/scripts/memory-golden.mjs` (node 22.23.3, temp HOME + decoy config dir, pinned clock, umask 022; two runs identical; re-record unchanged) writes `tests/fixtures/memory_golden.json`. `tests/memory_golden.rs` replays 244 pure cases, 14 `notifyMemoryUpdate` cases (through the queue and on live fake-CLI sessions whose next turn carries the reminder), and 14 module scenarios (293 calls, the tree checked after each). `claudius-server/tests/memory.rs` replays 249 requests in 11 groups on the real binary, with 3 live fake-CLI sessions whose turns must carry exactly TS's reminders: 248 byte-identical, 1 listed. Plus 2 unit tests. Mutation 156/158 (checksum restore, one mutant at a time). The 8 first-pass survivors led to new recorded cases: the index at exactly 20 000 / 20 001 bytes, mtimes before 1970, `abmd` / `a.xmd`, 48 files on three tied mtimes (kills `sort_unstable`), and a `null` description against a hand-edited index line. 2 are equivalent: dropping `ends_with('"')` before `JSON.parse` (after JS trim, a JSON string text must end in `"`), and returning the raw cwd from `assert_absolute_user_path` (its only use is a `path.join`, which normalizes the same way; checked in node on 15 odd absolute paths). Containment-check mutants weren't counted (unreachable by construction). Flake 0/20. No e2e: the user's running app holds `.next-e2e`. `cc-parity-2.1.214-memory-modified` (real list, create and file read through the Memory page) would cover `memory/auto` on Rust. `cc-parity-2.1.277-memory-agents-fallback`, `cc-parity-2.1.206-doctor-claude-md` and `cc-parity-2.1.283-prompt-audit` open the Memory page, which loads both listings, without asserting them. No spec drives rules CRUD or the memory-update reminder. Merged from the parallel clone (rebased onto main by the merge loop).
- [x] **G09** Workspace relocation: `workspace-relocate.ts` (331) + `workspaces/[id]/move-sessions` (live sessions).
  — done 2026-10-28 (background agent): new `claudius_core::workspace_relocate` (`list_workspace_session_ids`, `relocate_workspace_sessions`, `RelocateResult`, `SessionKey`) and `claudius_server::move_sessions` serving GET/POST `/api/workspaces/[id]/move-sessions` (two lib.rs lines). It reuses `paths::encode_project_dir`, `db::open_db` / `close_db`, `node_fs`, `node_path`, the store's `get_raw` / `list_raw` / `update_raw`, `SessionManager::sessions_by_cwd` / `remove` and D01's `assert_absolute_user_path` (no new copy). `encode_project_dir` now dashes a lone-surrogate stand-in once (was twice). Node's `fs.cp` (recursive, `force: false`, `errorOnExist: false`: checkPaths, checkParentPaths, onDir / onFile / onLink, opendir order) and `fs.rm` (recursive + force: rimraf) are ported inside the module, `SystemError` wording included. Behaviors found (TS, mirrored): the folder is `homedir()/.claude/projects/<encodeProjectDir(root)>` (HOME, not `CLAUDE_CONFIG_DIR`). `<uuid>.jsonl` names match case-insensitively (the id is kept as written) and are processed in readdir order. A name that already exists in the new folder (`lstat`, so a dangling link counts) fails with "a transcript with this id already exists in the new folder". Otherwise the transcript is `rename`d and its sidecar `<id>` (file, dir or link) follows: renamed when the name is free, merged into a directory that's there (existing files win, new files and dirs get the source mode, links re-pointed at absolute targets), then the source is rimraf'd. Then the SDK's `{"type":"relocated","sessionId","relocatedCwd"}` stamp is appended on its own line (a `\n` first unless the file ends in one; an empty file gets none). A symlinked transcript moves as a link and its target gets the stamp. A directory named `<uuid>.jsonl` moves, then fails `EISDIR: illegal operation on a directory, read`; a dangling one moves, then fails `ENOENT … open`. A sidecar or stamp failure leaves the transcript moved but reported in `failed`. cp errors: DIR_TO_NON_DIR, NON_DIR_TO_DIR, EINVAL "subdirectory of self" (the same link on both sides) and "src and dest cannot be the same" (a hard link), SYMLINK_TO_SUBDIRECTORY, FIFO, `EEXIST … symlink` over a file. `assets/` moves after the transcripts ("assets: …") and the database after that ("database: …", joined with "; "). Database merge: the source is migrated, then `ATTACH`, then one transaction with deferred FKs (a source that lists `asset_uses` before `assets` merges; a dangling FK rolls everything back: "FOREIGN KEY constraint failed", old DB and folder kept). `INSERT OR IGNORE` runs over the shared columns: the destination's rows win, and a source row missing a NOT NULL column is dropped. A lone INTEGER PK is left out, judged by JS `toUpperCase`, so a dotless `ınteger` counts and its rows land with NULL keys. `schema_meta` is skipped, and so is anything matching `NOT LIKE 'sqlite_%'`, which includes `sqliteXfoo`. Every `cwd` column is re-keyed with `UPDATE OR IGNORE` + DELETE of the leftovers. A `.claudius.db` directory → "database: unable to open database file"; a corrupt destination → "file is not a database"; an unwritable folder → "attempt to write a readonly database". The old file and its `-wal` / `-shm` are unlinked only on commit. The old folder is `rmdir`ed only when empty. Two roots in one folder (`/a/b-c`, `/a/b/c`) get stamps + re-key only. `from === to` returns at once; `""` → PathInjectionError "project dir escapes base". It throws only on readdir (ENOTDIR / EACCES / ENAMETOOLONG; ENOENT is empty) or mkdir (EEXIST on a file / EACCES / ENAMETOOLONG). The list is transcript ids, then the read-only `sessions.id` rows `WHERE cwd = root` (a non-WAL, corrupt or table-less DB adds nothing), with JS Set semantics: `5` and `5.0` once, 2^53+1 reads as 2^53, `"5"` separate, NULL once, each BLOB its own Buffer `{"type":"Buffer","data":[…]}`. better-sqlite3 binds a lone surrogate as its 3-byte sequence (`ED A0 80`, read back as three U+FFFD); roots are bound the same way (`JsText`). Route: GET gives `count` (any failure or a non-string root → 0), `busy` (non-idle live sessions) and `sharedWith` (strict `===` on raw store values: equal numbers, bools and null share, objects never; a nameless entry is `null`; a `null` entry anywhere → empty 500), and omits `rootPath` when it's missing. POST: 404 before the body; "invalid body" (malformed, empty, `null`, trailing text); "missing target root" (non-string `to`, incl. `1e400`; the last duplicate key wins); the `assertAbsoluteUserPath` messages; `stat` follows links ("rootPath does not exist" for missing or dangling, "rootPath not a directory" for a file or a link to one); a normalized `to` equal to the root → `{workspace, moved: 0, failed: []}` with nothing touched. Running and needs_input sessions count toward the 409 "N chat(s) … still working …"; idle ones in the root are ended (other roots kept). A throw → 500 "Moving sessions failed: …" (non-string roots: "absPath.replace is not a function" / "Cannot read properties of null|undefined (reading 'replace')"). A store write failure is an empty 500 after the move already happened. A14's list names this route as echoing V8's JSON.parse message, but it answers a fixed "invalid body". Path safety: every fs sink keeps the TS's inline `resolve` + `startsWith(base + "/")` (folder, per-file destination, `moveDirMerging` destination, stamp file); none added or dropped. Differences: the folder hangs off `paths::home_dir()` (`CLAUDIUS_STATE_HOME` moves it). When several children of one folder fail to delete, which error Node reports is a race (measured: usually the first in scandir order, which Rust always reports after trying all; the recorder keeps one failing child). `close_db` only drops the cache entry (a holder keeps a connection to the unlinked source; TS closes the shared handle). Not recorded: concurrent relocations, copied files' timestamps / xattrs, sockets and devices in a sidecar. Tests: `rust/scripts/workspace-relocate-golden.mjs` (node 22.23.3; the real module, db.ts, `upsertSession`, session-manager and the route; temp HOME + decoy config dir, pinned clock, umask 022; two runs identical; re-record unchanged) writes `tests/fixtures/workspace_relocate_golden.json`. `tests/workspace_relocate_golden.rs` replays 16 scenarios (69 calls, 162 setup ops): the result or throw as JSON text, and every changed path (kind, mode, text / bytes, link target, `.claudius.db` dumped with cell types). `claudius-server/tests/workspace_relocate.rs` replays 99 requests in 9 groups on the real binary, with `updatedAt` mapped to the recorded clock within the request window. In 3 groups, 9 live fake-CLI sessions stand in for the recorder's stubs (idle; running = a `script:` turn held open; needs_input = a pending `tool:` permission). The test checks the busy counts, the 409s, which sessions end, their `sessions` rows (time columns masked), and that `GET /api/sessions` doesn't touch the tree. All match. Plus 3 unit tests. Mutation 79/81 (checksum restore, one at a time, scoped). The first pass's `defer_foreign_keys` survivor led to the child-before-parent case. 2 are equivalent: the per-file destination containment (a readdir name matching the UUID regex can't leave the folder) and the chmod after `std::fs::copy` (which already copies the permission bits). Flake 0/60 (20 rounds × 3 test binaries, throttled, load 12–28). Clone gate 618. No e2e: the user's running app holds `.next-e2e`. `workspace-move-sessions` is the only spec that calls the route (root change on the workspace page → move prompt with "1 session" → Move → the root and listing checks) and would cover it on Rust. Merged from the parallel clone (rebased onto main by the merge loop).
- [x] **G10** Feedback: `feedback-store.ts` + `POST/GET /api/feedback`. deps: S26
  — done 2026-11-04 (background agent, merged by the loop): new `claudius_core::feedback_store` (`insertFeedback` / `listFeedback` on `db.rs`) and `claudius_core::feedback_refusal` (`lib/shared/feedback-refusal.ts`, CC 2.1.309), with `claudius_server::feedback` serving `GET`/`POST /api/feedback`.
    - Found and fixed a stale S26: `Session::submit_feedback` returned `bool` and dropped the refusal reason the banner shows. It now returns `{forwarded, reason?}` like `submitFeedback`, so the S26 fixture was re-recorded (that field plus SDK 0.3.312 metadata; nothing else moved).
    - Mirrored: `req.json().catch(() => null)` read only through `body?.x` (a non-object body is 400 `empty feedback`); `rating` exactly `up` / `down`; a JS-trimmed comment; `surface` a string else `claudius`; `attachTranscript === true`; the 400 before the session lookup; 409 `session-unavailable` (nothing stored) for an id that isn't live; the verdict tag (`[+1] ` / `[-1] `) trimmed into the forwarded description; the row written whatever the CLI said (a failed write is swallowed and the answer still says `stored: true`); the reason only when `!forwarded`; and GET's `Number(limit)` rule (100 unless finite and above 0, capped at 500) bound as that JS number, so a fractional limit is Next's empty 500, like a missing table.
    - Deliberate differences: a body nested past 128 levels reads as `null` (serde_json), so 400 instead of 409; a lone-surrogate comment reaches the CLI as U+FFFD where TS forwards `\ud800` (the stored row is the same either way); OPTIONS is axum's 405 (Next: 204).
    - SDK 0.3.312's new `submitSurveyFeedback` has no TS caller, so `claudius_agent` is untouched (R09 owns it).
    - Tests: `rust/scripts/feedback-golden.mjs` (two runs byte-identical, ASCII-only, lint clean) records 104 refusal values, 41 store steps and 6 route groups (175 steps, 163 requests: validation, 23 scripted CLI replies, DB shapes including foreign rows / no table / typeless / pre-015, a 520-row bulk read, an exited CLI, a session with no query). `claudius-core/tests/feedback_golden.rs` replays the refusals and the store; `claudius-server/tests/feedback.rs` replays all 163 requests on the real binary byte for byte and checks PUT/PATCH/DELETE are 405. Mutation: skipped (speed). Flake 3/3.
    - No e2e: `cc-parity-2.1.309-feedback-refusal` is the only spec on this route and it stubs `**/api/feedback` with `page.route`, so it never reaches the Rust handler.
- [x] **G11** Peer source: `peer-source.ts` (357) + `sessions/peer-source`.
  — done 2026-10-28 (background agent): new `claudius_core::peer_source` (`resolvePeerSource` as `Resolver` with its module cache, `defaultRoots`, and the route's workspace pick `workspace_for_cwd`), new `claudius_core::jsonl_lines` (`jsonlLines` as a streaming iterator), and `claudius_server::peer_source` serving `GET /api/sessions/peer-source`; the proxy line in `sessions.rs` is gone (one `pub mod` + one `.merge` in lib.rs). `hostedHere` now comes from the Rust session manager (while proxied, Next's empty manager made it `false` for every session). On reuse: every existing Rust JSONL reader (`sdk_cost_state`, `transcript`, `usage_seed`, `asset_ingest`, `sessions_store`) is an inline whole-file `split('\n')`, not a callable, and peer-source needs a stream (it stops reading at the hit; a 512 MiB budget; V8's per-line limit ends a file only at that line), so the shared semantics moved into `jsonl_lines.rs`; the inline readers are untouched. Behaviors found (TS, mirrored): the roots are `homedir()/.claude` (not `$CLAUDE_CONFIG_DIR`) for `sessions/` and `projects/`, plus each `<accountsDir>/profiles/*/sessions` that `lstat` says is a real directory (a symlinked, file or missing `sessions` is skipped); a profile's `projects/` is never scanned. Registry: the `<pid>.json` fast path needs a safe integer pid > 0 (`pid=0` is a plain miss, 200 `{source: null}`, not a 400) and a record `pid === q.pid`; then, for a `uds:` address, every `^\d+\.json$` record (strcmp order, main dir first) whose `messagingSocketPath` is the socket. The address is `decodeURIComponent`ed with a raw fallback after `searchParams` already decoded it (so `%25E2%2582` decodes twice); an empty socket counts as none. A record counts when its pid is a safe integer, its sessionId is `^[A-Za-z0-9_-]{1,128}$`, a string socket path doesn't contradict the address, and a numeric `startedAt` isn't past `at + 5000`; a rejected main-dir record falls through to a profile's. `live` is `process.kill(pid, 0)`: EPERM counts (pid 1), pid 0 is alive, a pid outside int32 (2147483648, INT_MIN−1) is dead. Transcripts: `*.jsonl` (case-sensitive; `a-jsonl`, `.JSONL` skipped) one level under `projects/`, `stat` through symlinks (a link outside the window whose target is inside counts; dangling skipped), `mtimeMs >= at - 300000` (everything without `at`, pre-1970 included), stable sort oldest first; before each file the 5 s clock budget and the 512 MiB byte budget (sizes summed before the file, so the first file of any size is read). Lines split on `\n` only, one `\r` stripped, U+2028/U+2029/lone `\r` don't split, invalid UTF-8 is U+FFFD the same whether or not a 64 KiB chunk boundary cuts the sequence, and a line past V8's string limit ends that file. Matching runs raw `includes` prefilters first (the msgId text; `"SendMessage"` with its quotes), then the structural check: `toolUseResult.msg_id === msgId`, else a `tool_use` named `SendMessage` whose JS-trimmed `input.message` starts with the trimmed snippet (≥ 16 UTF-16 units, only with `at`, only on lines that don't contain the msgId). So an escaped msg_id / tool name / `cwd` key is missed, a mention of the id elsewhere never matches, and an uppercase msgId passes the UUID check but never matches. The cwd is the file's first record containing `"cwd":"` with a non-empty string cwd, else the hit's own. The route cuts `snippet` at 200 UTF-16 units, so a cut through an emoji leaves a lone high surrogate that still prefixes another astral character (a decoy matches). Cache: key `JSON.stringify([claudeDir, msgId, pid, from, snippet, at])` of the parsed values (`pid=099999300` shares `pid=99999300`'s entry); misses 30 s, transcript hits forever, registry hits never; 500 entries, the oldest inserted evicted on every lookup that reaches the disk, even when the answer isn't stored. Route: `searchParams.get` (first pair wins), `pid` `^\d{1,10}$` and `at` `^\d{1,16}$` (else ignored), empty strings ignored; with no pid / msgId / from / snippet left (`at` alone too) 400 `{"error":"from, pid, msgId or snippet required"}`. The workspace is looked up only for a source with a cwd: `listWorkspaces().catch(() => [])` (missing / malformed / `null` / version-2 store → none), the deepest `rootPath` equal to the cwd or a prefix of it plus `/` (an empty rootPath matches every absolute cwd; a trailing `/` isn't doubled), `id ?? null`; a `null` entry or a non-string `rootPath` throws a TypeError → Next's empty 500, logged as `[api/sessions/peer-source] TypeError: …`. Path safety: each fs call has TS's `resolve` + inline `starts_with(base + "/")` check exactly where TS has one (pid file, registry listing, project dir, transcript file); none added, none dropped. Differences: a registry record or transcript line nested past 1 000 levels is skipped (the `JSON.parse` port's depth limit), and a workspaces.json past 128 levels reads as no workspaces, where V8 parses both; OPTIONS is axum's 405 (Next: 204); `homedir()` is `paths::home_dir()`, so `CLAUDIUS_STATE_HOME` moves `claudeDir` (as in D20); off unix `live` is always false. Tests: `rust/scripts/peer-source-golden.mjs` (node 22.23.3, `--experimental-transform-types`, temp HOME + CLAUDE_CONFIG_DIR, `sessionManager.get` stubbed to one id, a virtual `Date.now` in the module part; two runs byte-identical; ASCII-only; eslint clean) writes `claudius-core/tests/fixtures/peer_source_golden.json`: 29 `jsonlLines` byte strings, 7 module groups (48 `resolvePeerSource` calls on copies with shrunk bounds: miss TTL / kept hits, eviction at CACHE_MAX 3, time budget, byte budgets 100 / 101, mtime window and order, gates and prefilters) with each answer and its `Date.now` reads, and 174 route requests + 498 cache fills over one world (main + 7 profile registries incl. symlinked / file / dangling, transcripts with huge lines, CRLF, chunk-cut characters, astral text around the 200-unit cut, a mode-000 file and folder, 14 workspaces.json shapes). `claudius-core/tests/peer_source_golden.rs` (3 tests) replays the bounds, lines and module calls; `claudius-server/tests/peer_source.rs` (2 tests) replays the 174 requests on the real binary byte for byte (status, content type, body), starts the stubbed session on the fake CLI for `hostedHere: true`, checks the 7 throws are logged, and checks POST 405 / HEAD 200; 3 mode-000 steps are skipped when run as root. Plus 8 unit tests. Mutation 93/100 (100 mutants over the three new source files, checksum restore, one at a time, scoped tests): the first pass killed 79 (+1 malformed mutant, fixed and killed on re-run); the 13 other survivors were killed by the new "gates and prefilters" group, two 16/17-digit `at` requests and an end-of-file unit test. 7 are equivalent: the two containment checks in the transcript scan (readdir names never hold `/`, `.` or `..`); the socket prefilter and the socket passed to `accept_record` after it (each repeats the other); `is_safe_integer` on the fast-path pid (the record needs `pid === q.pid`, and `accept_record` rejects a non-safe pid); `break` vs `?` on a read error (both end in `None`); and the byte-length fast path before the UTF-16 count (units ≤ bytes). Flake 0/20. Clone gate 626. No e2e: the user's running app holds `.next-e2e`. The only specs that touch the route, `cc-parity-2.1.247-peer-message-collapse` and `chat-screenshots`, stub `**/api/sessions/peer-source*` with `page.route`, so they would not reach the Rust handler either; no spec drives the real lookup (`PeerMessageHeader`'s link needs a live peer message from another CLI). The client half (`peerSourceTarget`, `peerSourceQuery`) is unchanged and unit-tested in `tests/unit/peer-source.test.ts`. Merged from the parallel clone (rebased onto main by the merge loop).
- [ ] **G12** Boot tasks in `main.rs`: the customizations upgrade check + workspace reconcile (`customizations-startup.ts`) and the updater scheduler boot. deps: D14, D27
- [ ] **G13** Section exit: re-run I04. No `proxied-degraded` failures remain.

## 5. Disk-only routes (until Next serves only pages)

**Workspaces and files**
- [x] **D01** `workspaces-store.ts` (525) at full parity. Routes:
  - `workspaces` GET/POST
  - `[id]` GET/PATCH/DELETE
  - `select` (the `claudius.workspace` cookie)
  - `reorder`
  - `icon` GET/POST
  - `roots`
  — done 2026-10-27 (background agent): `workspaces-store.ts` on raw JSON values (`claudius_core::workspaces`, with `js_string` for lone surrogates / JS string ops; paths through D04's `node_path`), plus `active-workspace.ts`'s cookie + hint resolution, and the 10 route pairs in `claudius_server::workspaces`: `workspaces` GET/POST, `[id]` GET/PATCH/DELETE, `select`, `reorder`, `icon` GET/POST, `roots`. For `roots` only the `listWorkspaceRoots` slice is ported; `workspace-roots.ts` itself is D02. The typed wrappers keep the session and git callers; D06's "store from another version" is now at parity (404).
    Behaviours mirrored:
      - A `null` store file throws on every route. A store that isn't `{version: 1, workspaces: [..]}` reads as empty, and the next write replaces it after a backup.
      - A `null` entry throws V8's `Cannot read properties of null (reading 'id')`: in `find` only before the match, in DELETE's `filter` always.
      - Ids compare with strict `===`.
      - create: `icon ?? letterIcon` (a null icon gets the letter icon); defaults are `{permissionMode: "auto", ...input}`.
      - PATCH spreads the body over the entry, then pins `id` / `updatedAt`. navOrder must be an array of at most 64 strings, each 1–64 UTF-16 units. rootPath is trimmed and resolved in place. A null body is a 500.
      - DELETE moves activeId to `next[0]?.id`, or drops it in place. It unlinks `<id>.*` icons, and clears the cookie only when the request's cookie is that id.
      - reorder errors: `ids length does not match`, `unknown id <String(id)>` (a duplicate counts as unknown).
      - Backups: `.bak.<ISO>` before each write. Rotation keeps the last 10 in UTF-16 sort order, foreign names included (a directory can't be unlinked and stays).
      - Writes go to a tmp file plus rename, so a symlinked store gets replaced by a file.
      - Next's cookie parser: split on `/; */`; a bare name means "true"; values are URI-decoded and undecodable pairs skipped; the last value wins at the first position. Set-Cookie carries `Expires` (now + 1y) and `Max-Age`; select also deletes `claudius.customization`.
      - icon POST: Node's legacy base64 decoder, the `Buffer.from(value)` shapes, the 2 MiB cap, and the PNG/JPEG/WebP sniff (the RIFF/WEBP check masks with `& 0x7F`). icon GET serves the first `<id>.*` in readdir order; the MIME lookup also hits Object.prototype names.
      - roots: a non-string rootPath throws. `defaults.additionalDirectories` may be an array, or a string walked by code point (anything else throws "not iterable"). Project `permissions.additionalDirectories` counts only as an array. Blank entries are skipped, the list is deduped, and ids are `extra:<n>`.
    Differences:
      - An icon id that leaves the icon dir (`..%2Fescape`) is refused with a 500 and nothing written; TS writes `.claudius/escape.png`.
      - `1e400` reads as null, not Infinity, so `rootPath: 1e400` is a 400 "rootPath required" where TS 500s.
      - A genuine U+10F800–U+10FFFF char reads as a lone surrogate.
      - JSON nested past 128 levels isn't parsed.
      - An array-like icon `data` with length > 2 MiB is answered 400 without allocating.
      - create reads the clock once; TS reads `Date.now()` three times.
      - A process-wide store mutex.
      - Next decodes dot segments in paths; axum doesn't.
      - On 405s axum adds an Allow header and also answers OPTIONS with 405.
      - `assertHomeIntegrity` is not ported (Node-only).
      - `sessions.rs` keeps its own first-wins, undecoded `cookie()`.
      - Through the typed `get`, a non-string `rootPath` reads as "" (git runs in the server's cwd); TS's `execFile` throws.
    Tests: `claudius-server/tests/workspaces.rs` replays 623 steps recorded from the real route handlers inside Next's `AppRouteRouteModule`, on the real binary. That is 425 requests, 186 fs seeds and 12 backup dumps. Per step it checks status, type, body, Set-Cookie, the store bytes, the backups, the icon files and the `.claudius` listing. Random ids are mapped by position. 423 match; 2 are the listed differences. It also replays 440 base64 decodes, 33 `Buffer.from` shapes and 32 Cookie headers, plus a 405 check. `claudius-core/tests/workspaces_golden.rs` covers 360 letter icons, 27 `path.resolve`s and 37 URI component pairs.
    Mutation: 61/68 killed. The 7 survivors are equivalent: object-spread key order; the `n == 1` guard in decodeURIComponent; reorder position vs rposition and the unreachable "missing ids"; the NUL and `startsWith(primary + "/")` checks in the project-settings read; the empty-cookie filter.
    Flake: 20/20 green. Clone gate 461 after the rebase onto main.
    No e2e: the user's running app holds `.next-e2e`. These specs drive the ported routes: workspace-cwd-binding, workspace-route-memory, sidenav-reorder, workspace-context-menu, app-functionality, global-setup.ts + the workspace.ts helper, settings-backup, cc-parity-2.1.248-restricted-mode, files-empty-state, workspace-move-sessions.
    Merged from the parallel clone.
- [x] **D02** `workspace-roots.ts`, `workspaces/[id]/reveal` (open in Finder), `workspaces/[id]/shell` (`shell.ts`: open a terminal).
  — done 2026-11-01 (merge loop): new `claudius_core::{workspace_roots, reveal, shell}` (`listWorkspaceRoots` / `resolveWorkspaceRoot`, `revealOnHost` (`open -R` / `xdg-open` / `explorer`, spawned and not awaited), `execShellCommand` (one `/bin/bash -c` per request, no terminal)) and `claudius_server::workspace_roots` serving `GET …/roots` (moved off D01's slice), `POST …/reveal`, `POST …/shell`. Golden: `rust/scripts/workspace-roots-golden.mjs` → `tests/shell_golden.rs`, `claudius-server/tests/workspace_roots.rs`. Merged 2026-11-01 from its 2026-10-29 clone. Its agent was cut off by the session limit during mutation testing, before it could report; the one mutant it left applied was restored by checksum. Mutation unfinished, flake not re-run (speed). E2E deferred to the section-exit parity runs (S34 / D28).
- [~] **D03** Files API (`workspaces/[id]/files`, 693 lines). Path containment inline at every fs sink (`paths::within`).
  — done 2026-11-01 (merge loop): D03a + D03b: new `claudius_core::workspace_files` (path rules, `listDir`, the filename and content searches, the `?serve=1` image types) and `claudius_core::text_encoding` (`lib/shared/text-encoding.ts`: UTF-8 / UTF-8 BOM / UTF-16LE detect, decode and re-encode), plus `claudius_server::workspace_files` serving `GET/POST/PUT/PATCH/DELETE /api/workspaces/:id/files` with containment at every fs sink. Node's `fs.rm({recursive, force})` moved to `node_fs::rm_recursive` (G09's private rimraf; D12 and D19 use it too, plus `node_fs::rm_force`). Golden: `rust/scripts/workspace-files-golden.mjs` → `tests/workspace_files_golden.rs`, `claudius-server/tests/workspace_files.rs`. D03c (`files/preview`) is still open. Merged 2026-11-01 from its 2026-10-29 clone. Its agent was cut off by the session limit during mutation testing, before it could report; the one mutant it left applied was restored by checksum. Mutation unfinished, flake not re-run (speed). E2E deferred to the section-exit parity runs (S34 / D28).
  - [x] **D03a:** list / read
  - [x] **D03b:** create / write / rename / delete (POST/PUT/PATCH/DELETE)
  - [x] **D03c:** `files/preview/[...path]`
      — done 2026-11-04 (background agent, merged by the loop): new `claudius_core::files_preview` behind `claudius_server::files_preview`, GET only, over D02's `resolve_workspace_root(id, None)`, so a `cust_…` id resolves to the mirror as in TS. It includes the current TS hardening (fac9bb4c, b5dfd5ee): one `O_RDONLY|O_NONBLOCK` handle, `fstat` through it, regular files only (404 `not a file` for a directory, FIFO or device) and 413 over 128 MB.
        - Mirrored: lexical containment with symlinks followed (T08a), a root of `/` refusing everything, a top-level `..foo` / `...` refused, and the content type taken from the raw path's last `.`-piece — including `constructor` giving `function Object() { [native code] }` and `__proto__` giving `[object Object]`, and a `listWorkspaceRoots` TypeError as an empty 500. Params follow Next's matcher (per-segment `decodeURIComponent`, one `_NEXTSEP_` stripped); anything Next doesn't hand the handler unchanged is forwarded.
        - **Deliberate difference, and a live TS bug (see T08b): an empty file is served as an empty body.** The TS passes `content.buffer` to `Blob`, which is the whole 64 KiB scratch buffer Node's `readFile` read into, so it serves uninitialized memory.
        - Tests: `rust/scripts/files-preview-golden.mjs` → `claudius-server/tests/files_preview.rs` (138 requests, serve plus permissions), plus core unit tests. Mutation: skipped (speed). Flake 3/3.
        - No e2e: no spec loads the preview iframe (`FilePreview` / `Markdown`); `sdk-update-0.3.272-staged-write` only asserts the collapsed label is absent.
- [x] **D04** `fs/dirs` (229) + `fs/list` (`fs-list.ts`).
  — done 2026-10-27 (background agent): `GET/POST /api/fs/dirs` and `GET /api/fs/list` in `claudius_server::fs_routes`, on four new claudius-core modules:
    - `fs_list.rs`: `lib/server/fs-list.ts` (the BFS walk, scoring and node's `readdir` order);
    - `tcc_protected.rs`: `lib/shared/tcc-protected.ts`, server half;
    - `node_path.rs`: node's `path.posix` (`resolve` / `normalize` / `join` / `relative` / `dirname` / `isAbsolute`);
    - `collate.rs`: `localeCompare` as ICU4X root collation (`icu_collator` 2).
  Containment is mirrored and re-checked inline at every `stat` / `readdir` / `mkdir` sink.
  Behaviors found and mirrored:
    - Containment is lexical (`resolve` + `startsWith(root + "/")`) and the fs calls follow symlinks, so a symlink inside the root lists, and creates in, a folder outside it.
    - `..`, absolute paths outside the root, a prefix sibling (`<root>x`) and a `..foo` parent are 403s. `~` is a literal folder name (no home expansion).
    - `CLAUDIUS_FS_ROOT` is JS-trimmed and resolved against the cwd; blank means home; `=/` makes everything below `/` a 403.
    - The TCC gate (`needsAck` unless `ack` is exactly `1`) and the `Library/Containers` / `Group Containers` 403 compare exact strings, so on a case-folding disk `desktop` / `Library/containers` skip both. POST has neither check. Entries are tagged `protected`, never stat'ed.
    - Picker entries: directories only (symlinks and fifos dropped), no dot-names or HIDDEN names, `localeCompare` order, stable (ignorable-only differences keep readdir's byte order), `parent: null` at `/` and at the root.
    - POST:
      - invalid JSON → 400; a `null` body or a non-string `parent` / `name` (including `1e400`) → Next's empty 500;
      - `name` is JS-trimmed (U+FEFF trimmed, U+0085 kept); `/`, `\`, NUL, `.`, `..` → 400;
      - EEXIST → 409 (also inside an immutable folder); EACCES / EPERM → 403 (`chflags uchg` gives EPERM); ENAMETOOLONG → empty 500.
    - fs/list:
      - trusted cwd only: the first `cwd` param wins, JS-trimmed; workspace roots and extra dirs are JS-trimmed too, which fixed `trusted_cwd.rs`;
      - `Number(limit) || 200` with JS `slice` (negative counts back, ±0.5 → 0, Infinity);
      - a 5 000-entry cap and depth 6; symlinks are never listed or followed; no descent from unprotected space into a TCC folder;
      - a match is kept only if its score is > 0 (600-unit paths);
      - a directory never gets the basename bonus (its relPath ends in `/`);
      - the sort is stable on ties.
  Differences:
    - Entry order is root/en collation, where TS follows the server's ICU locale.
    - A lone-surrogate name answers `�` (the same folder is made).
    - A POST body nested past 127 levels is a 400.
    - `CLAUDIUS_STATE_HOME` moves FS_ROOT's default and fs-list's HOME.
    - Posix paths only.
    - FS_ROOT is read at the first request.
    - Not recordable: readdir errors other than EACCES (empty 500, like TS) and fs/list's unreachable `catch`.
  `trusted_cwd.rs`: JS `trim` at all four sites. The workspace `rootPath` (~106) and `additionalDirectories` (~116) sites were real parity bugs: under Rust `trim` a U+FEFF root became trusted and a U+0085 root didn't, the reverse of TS. Golden steps now cover both. The `project_config_root_for` site (~177) is the same mechanical change and is untested; the input check (~152) is the same hunk as G03's.
  Tests: `rust/scripts/fs-list-golden.mjs` records from the real TS route handlers (node 22.23.3 / ICU 78.3, temp HOME and CLAUDE_CONFIG_DIR; two runs byte-identical):
    - 1 500 collation pairs + 4 tie sorts, 1 213 `path.posix` calls and 534 tcc cases;
    - 15 scenarios × 298 steps per platform (120 dirs GET, 89 POST, 89 list), covering escapes, symlinks in and out, dangling links, a fifo, unicode and case / NFD twins, unreadable / read-only / no-exec / immutable folders, 5 200 files, depth 7, score edges and ties.
  Replay:
    - `claudius-core/tests/fs_list_golden.rs` replays the helpers and the fs/list 200s.
    - `claudius-server/tests/fs_routes.rs` rebuilds each tree and replays every step on the real binary (host platform) and in process (darwin + linux). It checks status, content type, body and the tree afterwards: 297/298 match, with 1 listed difference. Plus 405s for the methods TS doesn't export.
  12 new tests.
  Mutation: 94/96 killed over the 6 touched source files. The 2 survivors are equivalent: `resolve` skipping empty segments, and GET's first containment check (the inline sink check repeats it). The first pass's other 4 survivors led to the score-0, ties and immutable-folder cases.
  Flake 20/20 (throttled). Clone gate 357.
  No e2e: `cc-parity-2.1.280-at-mention-filename-ranking` and `composer-picker-key-select` reach the real `GET /api/fs/list` through the composer's `@` picker and would cover it on Rust; no spec drives `DirectoryPicker` (`fs/dirs`).
  Merged from the parallel clone; main-tree gate green (444 tests, with G02a, D04, G07a and D06 merged together).
- [x] **D05** `worktrees` GET (`worktrees.ts`) and `sessions/fork` (uses A04 + `fork-worktrees.ts`). deps: A04
  — done 2026-11-01 (background agent, merged by the loop): `GET /api/worktrees` and `POST /api/sessions/fork` are served by Rust (`claudius_server::worktrees`; the sessions.rs proxy line is gone). They run over the new `claudius_core::{worktrees, fork_worktrees, session_fork}` and A04's fork. `sessions_store::fork` is split into `fork_source` / `fork_text` / `write_fork`, with the same behaviour.
    - Mirrored:
      - `parsePorcelain`: key order, `trimEnd`, `refs/heads/` dropped once, the flag lines; `[]` whenever git fails.
      - The fork route's empty 500 for a non-JSON body, and its 400 for a falsy id.
      - SDK 0.3.312 `forkSession`'s throws for raw body values, in its order.
      - `1e400` reads as plus or minus Infinity, and lone surrogates are escaped on output.
      - `createForkWorktree`: the bare / no-commits / git-stderr reasons, the dirty flag, the resolve + `startsWith` barrier, and the index as JS reads and writes it.
    - Mirrored TS bugs: see PORT_PLAN.
    - Tests:
      - `rust/scripts/worktrees-fork-golden.mjs` (two runs byte-identical) records `worktrees_fork_golden.json`.
      - `claudius-core/tests/worktrees_golden.rs` replays 20 porcelain texts, 21 reasons and 10 slugs.
      - `claudius-server/tests/worktrees_fork.rs` replays 224 steps on real git and the real binary: 111 requests, 41 fork transcripts, 19 snapshots.
      - Mutation: skipped (speed). Flake 3/3.
    - No e2e: `cc-parity-2.1.295-fork-trailing-bubble` stubs the fork route with `page.route`, and no spec calls `/api/worktrees`.

**Git** (`lib/server/git.ts`, 1253 lines; every route lives under `workspaces/[id]/git/`)
- [x] **D06** git core exec wrapper + `status`, `diff`, `show`.
  — done 2026-10-27 (background agent): `claudius_core::git` ports `lib/server/git.ts`'s exec wrapper and the readers behind `GET /api/workspaces/:id/git/{status,diff,show}` (`claudius_server::git`).
  The wrapper, `git(args, cwd, GitOpts{input, timeout_ms})`, is TS `git()` over `execFile`:
    - The env is inherited as is: TS sets no LANG/LC_ALL/pager, and stdout is a pipe, so git never pages. Stdin stays open until exit unless `input` is written.
    - Reads are 64 KiB chunks decoded as lossy UTF-8.
    - Past the 16 MiB maxBuffer (decoded bytes per stream; the crossing chunk is kept whole) or the 15 s timeout, both pipes close and git gets SIGTERM.
    - Exits read `exited N` / `killed by SIG…`; a signal Node has no name for (SIGEMT on macOS) reads as exit 0.
    - A NUL in an argument or the cwd throws Node's own messages: the `util.inspect` quoting, the 76-unit split and the 128-unit cut.
    - Spawn errors read `spawn git ENOENT`.
    - D07–D09 can reuse `git()` / `GitOpts` / `HOOK_TIMEOUT_MS`.
  Also ported:
    - `isGitInstalled`, and `getRepoRoot` (execFileP: 1 MiB buffer, exit 0 only, JS `trim`);
    - `parsePorcelainV1Z`, and `parseBranchHeader` (its two regexes written out by hand);
    - `getStatus`, `getDiff` + `diffNoIndex` (`--` before the path) and `gitShow`;
    - the three route handlers, including the `cust_…` customization lookup (`getCustomization` + `customizationSrcDir`).
  Behaviours found and mirrored:
    - A branch with `.` or NBSP in its name reads as detached (`head` gets a short sha). A BOM-ended branch loses the BOM, a NEL is kept, and a U+2028 name in an empty repo gives neither `branch` nor `head`.
    - A repo root ending in whitespace is trimmed, so git runs elsewhere: `spawn git ENOENT`, or the trimmed twin repo.
    - `--no-index` untracked diffs read any path, absolute or `../` outside the repo. A repo's `diff.external` runs.
    - `--no-index` exit 1 counts as success, so a missing file or a directory gives a 200 with an empty diff; an unreadable file gives a 500 with git's stderr.
    - `\r` / U+2028 / U+2029 before "Binary files " sets `binary`.
    - A NUL in a diff path or show ref is a 500 with Node's TypeError text; a NUL in a show path is the 400 `invalid path`.
    - A corrupt index is a 500 git-failed. With git missing, status gives git-missing and diff/show give not-a-repo. A broken workspaces.json is Next's empty 500.
    - Customization index: a `null` entry before the match means not found; `version: 1.0` is accepted; a BOM gives 404; `custom` (no underscore) is looked up as a workspace.
    - A >16 MiB untracked diff gives `git diff --no-index exited null`.
    - An empty rootPath runs git in the server's cwd.
    - `ref=` shows the index, and a missing blob gives `{"content":""}`.
  Differences:
    - Deliberate (security): a show ref starting with `-` is refused with `git show exited 128: fatal: unrecognized argument: <ref>:<path>`. TS hands it to git as an option: `--output=<f>` writes `<f>:<path>` (recorded), `--format=%s` prints HEAD, and `-Sx` answers 200. For an unknown option the body equals TS's.
    - (Fixed by D01: a `version !== 1` store reads as empty, 404 as in TS. A non-string `rootPath` now reads as "", so git runs in the server's cwd, where TS's `execFile` throws; not recorded.)
    - When a NUL message is cut at 128 units, Rust drops the lone half of a surrogate pair that Node keeps.
    - Next's extra env (`NODE_ENV`, `__NEXT_*`, `.env*`) isn't in git's env.
    - A cwd that is a file reads `spawn git ENOENT`, where libuv says `spawn ENOTDIR`. Only getRepoRoot sees such a cwd, and it swallows both.
  Tests:
    - `rust/scripts/git-golden.mjs` records the real TS (the parsers sliced out of git.ts, plus the real route modules) against real git 2.54, with the env, author and dates pinned. Two runs are byte-identical.
    - `tests/git_golden.rs` replays 71 branch headers, 22 porcelain buffers, 32 binary and 32 missing-blob texts, and 30 NUL-argument messages.
    - `claudius-server/tests/git_routes.rs` rebuilds every repo from the 484 recorded steps and replays the 237 requests on the real binary. Status, content type and body are compared byte for byte, except large bodies (length + FNV-1a + head) and the two overflow cuts (head + length range, signal normalized). 234 match and 3 are listed differences.
    - The same test checks 405 for the other methods, and that `--output=<abs>`, `--output=pwned`, `-o`, `--textconv` and `-Sx` never reach git (no file is created).
    - 12 unit tests cover the wrapper and parsers, and 1 covers `path.join` normalization.
  Mutation: 104/107 hand mutants killed (86 core, 21 server), in a separate APFS clone, with every file restored and checksum-verified. The first round killed 96; tests were added for the 8 survivors, each behaviour checked against node 22 / TS first. The 3 left are equivalent:
    - an empty `--show-toplevel` kept as a root (git ≥ 2.25 exits 128 instead; probed);
    - dropping the `## HEAD (no branch)` early return (the general pattern rejects that line too);
    - `diffNoIndex`'s `exited <code>` wording for a non-0/1 exit with empty stderr (git always prints a fatal line first).
  Flake: 20 runs × 4 test binaries, throttled, 80/80. Clone gate 364.
  No e2e: `cc-parity-2.1.222-diff-raw-content` would cover it end to end (it waits on real `git/status` + `git/diff` responses), and `workspace-route-memory` / `site-screenshots` open `/git` (status). `cc-parity-2.1.260-diff-panel` stubs both routes with `page.route`, so it never reaches the backend.
  Merged from the parallel clone; main-tree gate green (444 tests, with G02a, D04, G07a and D06 merged together).
- [x] **D07** `branches`, `branch-compare`, `branch-delete`, `branch-rename`, `checkout`.
  — done 2026-10-28 (background agent): `claudius_core::git` gains git.ts's branch commands on D06's `git()` / `GitOpts` / `HOOK_TIMEOUT_MS`: `isValidRefName`, `listBranches` (+ its for-each-ref parse), `checkoutBranch` (+ the `refExists` probes), `renameBranch`, `deleteLocalBranch`, `deleteRemoteBranch`, `compareBranches`, `diffBranchAgainstWorktree`. The new `claudius_server::git_branches` serves `GET …/git/branches`, `GET …/git/branch-compare`, `POST …/git/branch-delete`, `POST …/git/branch-rename` and `POST …/git/checkout`, reusing D06's workspace lookup, `json_text` and `error` (a `cust_…` id is looked up as a workspace, as in TS).
  Option injection: TS already refuses every name or ref that starts with `-` (`isValidRefName` → "invalid branch name" / "invalid start point"; `origin/-x` → "could not derive local branch name" on checkout and "invalid remote or branch name" on a remote delete). Every argv slot that holds input starts with a checked name or with `refs/`. Rust keeps the same checks and adds no `--`, because one would change `diff <name>` when the name is also a path. A branch really named `-dash` is listed, but no route can act on it. The replay asserts that no input ever reaches git as an option.
  Behaviours found and mirrored:
    - `isValidRefName` uses JS `\s`: NBSP / U+2028 / BOM / U+3000 are refused, but NEL and other controls pass (a NEL name reaches git). The limit is 255 UTF-16 units. A NUL passes, then fails in `execFile` with Node's `args[N]` TypeError.
    - List: newest commit first. git 2.54 shortens `refs/remotes/origin/HEAD` to `origin` (and the slashed remote's HEAD to `team/a`), so TS's `<remote>/HEAD` filter never fires. Ambiguous names list as `heads/dup` / `remotes/rem/main`; a gone upstream is kept; a CRLF line's `*\r` isn't current; stderr on success is ignored. A failure is a 500 carrying the `git for-each-ref exited N: …` message (not the output). Not-a-repo (bare, plain dir, file, missing dir, no git) is a 200 `{branches: []}`. An empty rootPath lists the server cwd's repo.
    - Compare: names aren't trimmed, and a blank `head` / `base` isn't treated as missing ("invalid branch name"). `mode` is only exactly `diff`: the first value wins and `DIFF` means log. The `log --oneline` lists are JS-trimmed (a trailing U+3000 + BOM go, a NEL stays) and read from stdout only, so an ambiguity warning on stderr is dropped. No merge base is a 400 with git's fatal. In diff mode, a path-only name diffs that path, a ref-and-file name is git's ambiguity error, and `diff.external` runs.
    - Checkout: the name is JS-trimmed, the start point isn't. A non-null, non-string startPoint is a 400 before the name is checked. `""` is "invalid start point" even without `create`, and `create` must be `=== true`. A local branch is probed first, then a remote one: `origin/x` → `switch x` if that local exists, else `switch --track origin/x`; a slashed remote gets git's own local name. `origin`, `heads/dup`, `remotes/rem/main`, an unborn `main`, and a probe killed at 15 s or broken by a corrupt packed-refs all read "unknown branch: …". `origin/HEAD` → git's "'HEAD' is not a valid branch name". The output is stdout then stderr, JS-trimmed (a hook's NEL-ended output is kept). Dirty-tree, untracked-file and other-worktree refusals are forwarded verbatim; dirty or staged changes carry over.
    - Rename: `branch -m` (no `-M`). git prints nothing on success, which reads "Renamed 'o' → 'n'". Renaming onto an existing name, into a D/F conflict, or from an unknown branch is git's error. The current branch (HEAD moves), a branch with an upstream (its config moves) and another worktree's branch all rename.
    - Delete: `-d`, or `-D` only with `force === true`. git refuses unmerged and checked-out branches. The "merged to upstream" warning is part of the output, and a remote ref name used locally gets "Did you forget --remote?". `remote === true` splits at the first `/` and runs `push <remote> --delete <branch>` under the 10 min hook timeout: `./x` deletes a local branch, `./main` is refused with git's `remote:` lines, a slashed remote is misparsed, and a `.lock` remote is refused. Pre-push hook output is forwarded, and `force` is ignored.
    - Bodies: `null` throws (Next's empty 500); malformed or non-object bodies read as no name. Up to two BOMs are stripped (three is malformed), the last duplicate key wins, and invalid UTF-8 becomes U+FFFD. Not-a-repo (400 `not-a-repo`) comes before name validation. A broken workspaces.json is Next's empty 500 on all five routes.
  Differences (3 of 307 recorded requests, listed in the test):
    - A lone-surrogate escape in a name echoes as U+FFFD in "unknown branch: …", where TS writes `\ud800`. git sees U+FFFD from both.
    - With a lone surrogate in the body, the `1e400` stand-in is lost, so `startPoint: 1e400` reads as no start point ("unknown branch") instead of "startPoint must be a string".
    - A body nested past serde's 128 levels reads as malformed ("name (string) required"); V8 parses any depth.
    - D06's notes on git's env, NUL-message cuts and `spawn ENOTDIR` apply unchanged.
  Tests:
    - `rust/scripts/git-branches-golden.mjs` records the five real route modules and git.ts against real git 2.54, in D06's pinned env (author and per-commit dates). Every call goes through a logging `git` wrapper whose one-shot markers can return canned for-each-ref output, hold a call past the 15 s timeout, or let only the hook timeout finish a push. Two runs are byte-identical.
    - `tests/git_branches_golden.rs` replays 99 `isValidRefName` names, sliced out of git.ts.
    - `claudius-server/tests/git_branches.rs` rebuilds 13 repos from the 630 recorded steps and replays the 307 requests on the real binary (35 branches, 65 compare, 120 checkout, 40 rename, 47 delete; 9 sent at once for the timeouts). It checks status, content type and body; every git call (cwd + argv, in order; 528 calls); and, after each mutating request, the repo read back with real git (119 states: refs, HEAD, status, worktrees, branch config). 304 match byte for byte and 3 are listed differences. It also checks that no input reaches git as an option, and 405 for the other methods.
  Mutation: 159/165 hand mutants killed (115 core, 41 server, 9 helpers), with every file restored and checksum-verified. The first round left e05 (dropping the remote-name check) alive, and S37 (trimming `head`) had no case yet; golden cases were added for both. A fake-git marker race found along the way was fixed in the wrapper. The 6 left are equivalent:
    - skipping empty for-each-ref lines (an empty line has an empty refname, which the next check already skips);
    - the start point's `!is_empty()` filter (`""` is already "invalid start point");
    - `local_name.is_empty() ||` (`is_valid_ref_name("")` is false);
    - `!branch.is_empty()` in the remote split (an empty branch means a trailing `/`, already refused);
    - `lines().count()` vs `split('\n').count()` on JS-trimmed lists (never `\n`-ended);
    - passing the trimmed name to the core (every core command JS-trims it again).
  Flake: 20 runs × 2 test binaries, throttled, 40/40. Clone gate 446.
  No e2e: no spec reaches these routes. The Git page fetches `git/branches` only when the branch switcher (`BranchSwitcher`) opens, and checkout / rename / delete / compare are its menu actions, which no spec drives. `cc-parity-2.1.222-diff-raw-content`, `workspace-route-memory` and `site-screenshots` open `/git` but only hit `git/status` / `git/diff`; `cc-parity-2.1.260-diff-panel` stubs `git/status`. The user's running app holds `.next-e2e`. Merged from the parallel clone (rebased onto main by the merge loop).
- [ ] **D08** `stage`, `commit`, `commit-draft` (`commit-drafts.ts`), `commit-message` (`commit-message.ts`, a one-shot `query()`). deps: A08
- [x] **D09** `merge`, `rebase`, `pull-merge`, `remote`, `remote-host`, `pr-status` (`pr-status.ts`, `gh`).
  — done 2026-11-01 (merge loop): new `claudius_core::pr_status` (`pr-status.ts`, `lib/shared/pr-badge.ts`, `lib/shared/git-host.ts`; `gh` through `exec_file`) and the git.rs merge / rebase / pull-merge / remote ops, served by `claudius_server::git_sync` (`POST merge`, `rebase`, `pull-merge`, `remote`; `GET remote-host`, `pr-status`). Golden: `rust/scripts/git-sync-golden.mjs` → `tests/pr_status_golden.rs`, `claudius-server/tests/git_sync.rs`. Merged 2026-11-01 from its 2026-10-29 clone. Its agent was cut off by the session limit during mutation testing, before it could report; the one mutant it left applied was restored by checksum. Mutation unfinished, flake not re-run (speed). E2E deferred to the section-exit parity runs (S34 / D28).

**Settings and config**
- [x] **D10a** Settings error text parity in `settings::read_settings` / `write_settings` (found by S05; shared by every settings reader and writer):
  - TS throws `SettingsParseError(path, sanitizeJsonParseReason(<V8 JSON.parse message>))`. Rust uses serde's wording for the reason. Port V8's `JSON.parse` `SyntaxError` messages (oracle: record `JSON.parse` failures on malformed inputs under node 22) plus `sanitizeJsonParseReason` (lib/shared/settings-load-error.ts).
  - Node fs errors read `EACCES: permission denied, open '<path>'`; Rust's `io::Error` displays `Permission denied (os error 13)` without the syscall or path.
  - A settings file that parses to a non-object: TS spreads it (`{...[1]}` → `{"0": 1}`, a string by characters), Rust reads it as `{}`.
  - Found by S22: a settings.json that isn't valid UTF-8 errors in Rust and reads as `{}`, dropping every user setting; TS decodes it lossily and keeps them. A `null` settings.json reads as `{}`, where TS `start()` throws reading `spinnerTipsEnabled` off it. A number past f64 (`1e400`) anywhere in it also gives `{}` (JS reads Infinity).

  Accept: a golden test over malformed files and unwritable paths, the reasons matching TS byte for byte.
  — done 2026-10-27 (background agent): settings read/write errors match the TS byte for byte.
    - Parse failure: `SettingsParseError` "<path> doesn't load: <reason>". The reason is V8's message (`js::json_parse_error_utf16`) through `sanitizeJsonParseReason` (new `settings_load_error.rs`, UTF-16 exact).
    - fs failure: Node's `uvException` text from a new shared `claudius_core::node_err`:
      - `NodeError {code, errno, syscall, path, dest, message}`, plus `fs::{read_file, write_file, lstat, chmod, rename, mkdir_recursive}`.
      - A directory fails at `read` with no path. `rename` carries `-> 'dest'`.
      - Recursive mkdir is Node's `MKDirpAsync`: it names the failing component (ENOTDIR mid-path, EEXIST at the end); EACCES/ENOSPC/ENOTDIR/EPERM fail at once.
      - The uv errno table is checked against node 22's `getSystemErrorMap` (85 names, plus "Unknown system error -N").
      - It overlaps G02a's `node_fs.rs` (not consolidated; I14). `node_err::tests::agrees_with_node_fs` pins the two to the same text for every errno `node_fs` names and for the mkdir walk.
    - `pathFor`'s `assertWithin`: `PathInjectionError` ("invalid base path", "null byte in path").
    - Reading:
      - Lossy UTF-8; a BOM is a parse error ("Unexpected token ' '") as in TS; any JSON value is a settings value.
      - `read_settings` = the JS spread (`{...[1]}` → `{"0":1}`, a string by UTF-16 unit, null/number/bool → `{}`).
      - `read_settings_js` = `None` for a literal `null` (callers raise TS's "Cannot read properties of null (reading 'k')").
      - `1e400` is a number, not `null`.
      - One `write_settings` (`JSON.stringify(next, null, 2) + "\n"`, as G03 also did).
    - Every caller checked against its TS caller:
      - `start()` throws on a null user file (TypeError, spinnerTipsEnabled). `SessionManager::create` → `CreateError::Threw{name,message}`, also for creates that joined it in flight. It ends the session and clears the in-flight entry. The create route's 500 is `{"error": …, "name": "TypeError"}`.
      - `setPermissionMode("auto")` throws (disableAutoMode) before any state change (`try_set_permission_mode`): the mode route and the create reconcile answer a bare 500; getOrResume logs FAILED and returns None.
      - `requestRecap` logs and broadcasts nothing.
      - persistModel, the advisor route and the advisor clear return the TS-logged error, including read errors Rust used to skip silently.
      - The feedback-survey rate drops the nudge only for a literal null, not 1e400.
      - setOutputStyle, the model route's `modelPicker` and advisor GET spread the value (unchanged).
      - G03's `mcp_config` keeps its own raw reader and writes through `write_settings`.
    - Bugs found and fixed:
      - serde_json `Map::remove` is `swap_remove` under preserve_order, so deleting `model`/`advisorModel` moved the last key into its place (G03 noted it as open). Now `shift_remove` (settings.rs ×3, and start()'s fable clear). This also covers S27e.
      - persistModel skipped clearing a non-string `model`.
    - Differences (PORT_PLAN):
      - A lone surrogate in a reason is dropped.
      - A lone-surrogate escape, or a string file spread through an astral char, becomes U+FFFD.
      - Nesting of 128+ levels is a SettingsParseError with serde's reason.
      - `typeof` sees 1e400 as null.
    - Tests:
      - `tests/settings_errors_golden.rs` replays `rust/scripts/settings-errors-golden.mjs` (node 22, real TS; recorded twice, byte-identical, and unchanged on re-record):
        - 85 errnos + 3 unknown; 55 raw fs.promises failures (4 in a macOS `chflags uchg` dir, EPERM); 44 + 459 sanitize cases;
        - 143 read, 42 write and 198 caller cases (9 callers × 22 file states). Each tree is rebuilt under a temp root and compared whole afterwards.
        - 370 match byte for byte; 13 are listed differences.
      - The create test pauses `start()` with a tracing gate, so the in-flight join is deterministic; then a fixed file creates afresh.
      - `claudius-server/tests/settings_errors.rs` (real binary): the create 500 TypeError; mode-auto 500 with the mode unchanged; the advisor route spreading null to `{}`; a fable start dropping `advisorModel` in place.
      - spinner_tips_golden: "settings null" (throws) and "settings invalid UTF-8" now match; "settings 1e400 priority" is listed as InfinityDropped.
      - feedback_survey_golden `submits_match` now holds the settings lock: it raced the `null` body (4/40 failures before, 0/40 after).
      - Units: node_err (4, including the node_fs cross-check), settings (2).
    - Mutation 76/82. 6 justified:
      - 1 equivalent: ENOTDIR off the fail-at-once list (the stat that follows gives the same ENOTDIR).
      - 2 unreachable for absolute, resolved paths (MKDirp's `/x` and no-separator guards).
      - 2 need a read-only filesystem or a concurrent creator (MKDirp's mid-stack branches).
      - 1 no-op today: `end()` after a start that throws before spawning anything (kept to mirror TS).
    - Flake: 20/20 green (golden, spinner, feedback, units, server test). Clone gate 457 after the rebase onto main.
    - No e2e: the user's app holds `.next-e2e`. No spec seeds a malformed, null or unwritable settings.json: `cc-parity-2.1.295-plugin-settings-invalid` stubs `/api/plugins` in the browser. The happy paths through the changed code are `cc-parity-2.1.269-output-style-command`, `cc-parity-2.1.260-advisor-command`, `advisor-picker`, `sdk-update-0.3.197-sonnet-5-advisor` and `cc-parity-2.1.245-model-picker-setting`.
    - Merged from the parallel clone.
- [x] **D10** `settings` GET, `settings/full`, `permissions`, `auto-mode`, `additional-dirs`, `skill-overrides`.
  — done 2026-11-01 (merge loop): new `claudius_server::settings_routes` serving `GET /api/settings`, `GET/PUT settings/full`, `GET/POST settings/permissions`, `GET/POST/DELETE settings/auto-mode`, `POST settings/additional-dirs`, `GET/POST settings/skill-overrides` over `claudius_core::settings` (new readers/writers there). Golden: `rust/scripts/settings-routes-golden.mjs` → `claudius-server/tests/settings_routes.rs`. Merge fix: the body helper's error is boxed (clippy `result_large_err`). Merged 2026-11-01 from its 2026-10-29 clone. Its agent was cut off by the session limit during mutation testing, before it could report; the one mutant it left applied was restored by checksum. Mutation unfinished, flake not re-run (speed). E2E deferred to the section-exit parity runs (S34 / D28).
- [ ] **D11** `settings/export` (`settings-export.ts`) + `settings/import`, `import/[id]`, `import/[id]/resolve` (`settings-import.ts`, 639).
- [x] **D12** `skills` (+ `[name]`), `hooks` (+ `disabled`), `keybindings`, `claudemd`.
  — done 2026-11-01 (merge loop): new `claudius_core::{skills, skill_names, hooks, keybindings, claudemd, safe_path}` (`skills.ts`, `lib/shared/skill-names.ts` on ICU 78 properties via `icu_properties`, `invisible-unicode.ts`, `hooks.ts`, `keybindings.ts`, `claudemd.ts` with the AGENTS.md fallback and `@import` resolution, `assertWithin`) and `claudius_server::skills_hooks` serving `skills` (+ `[name]`), `hooks` (+ `disabled`), `keybindings`, `claudemd`. Golden: `rust/scripts/skills-hooks-golden.mjs` → `tests/skills_hooks_golden.rs`, `claudius-server/tests/skills_hooks.rs`. D22 now uses these modules (its own copies were dropped at merge). Merged 2026-11-01 from its 2026-10-29 clone. Its agent was cut off by the session limit during mutation testing, before it could report; the one mutant it left applied was restored by checksum. Mutation unfinished, flake not re-run (speed). E2E deferred to the section-exit parity runs (S34 / D28).

**Customizations**
- [x] **D13** `customizations-store.ts` (314) + `customizations` GET/POST, `[id]` GET/PATCH/DELETE, `select`, `publishes`, `diff`.
  — done 2026-11-01 (merge loop): new `claudius_core::customizations` (`customizations-store.ts`, `computeDiff` + `customization-hash.ts` (sha1 via `ring`); now the one customization read side: `active_cwd`, `trusted_cwd`, the git routes and D02/D03 use it) and `claudius_core::runtime_dir` (`runtime-dir.ts`), served by `claudius_server::customizations`: `GET /api/customizations` (its POST is `bootstrapCustomization`, D14, and still falls through to Next), `[id]` GET/PATCH/DELETE, `select`, `publishes`, `diff`. Golden: `rust/scripts/customizations-golden.mjs` (176 calls) → `tests/customizations_golden.rs`, `claudius-server/tests/customizations.rs`. Merge fix: the golden's call count (the agent had re-recorded with the single-active-publish steps). Merged 2026-11-01 from its 2026-10-29 clone. Its agent was cut off by the session limit during mutation testing, before it could report; the one mutant it left applied was restored by checksum. Mutation unfinished, flake not re-run (speed). E2E deferred to the section-exit parity runs (S34 / D28).
- [ ] **D14** Bootstrap / build-app / publish / publishes revert / sync / description / auto-fix (`customization-*.ts`, ~1.4k lines) + `customizations-startup.ts`.
- [ ] **D15** `preview-server.ts` (572) + `[id]/preview` (+ `restart`).
- [x] **D16** `customize-settings`, `customize/runtime` (`runtime-dir.ts`).
  — done 2026-11-04 (background agent, merged by the loop): new `claudius_core::{customize_settings, customize_runtime}` behind `claudius_server::customize`, serving `GET`/`PUT /api/customize-settings` and `GET /api/customize/runtime`. `isRunningInsideCustomizationMirror` is ported self-contained, so D14 still owns the rest of `customizations-startup.ts`, and the read/write is `pub` for D11.
    - Mirrored: GET's `{autoFixPrompt, defaults}` key order; a blank (JS `trim`, so U+0085 is not blank) or non-string stored prompt falling back to the default; extra file keys dropped on write; PUT's uncaught `await req.json()`, so an empty, malformed or BOM body — and a `null` body (`Cannot read properties of null (reading 'autoFixPrompt')`) — is Next's empty 500, while a non-string prompt is 400 and a blank one saves; lone-surrogate escapes round-tripping; mode 0600 kept, new dirs 0755 and files 0644, symlinks written through; `runtime` naming `basename(dirname(live))` and looking the name up only when that dir starts with the root (a string prefix, so `..` inside the root still counts as a preview).
    - Tests: `rust/scripts/customize-golden.mjs` → `claudius-server/tests/customize.rs` (119 requests; each step checks the file text, the whole `.claude` tree with modes, and the logged throw messages), plus core unit tests. Mutation: skipped (speed). Flake 3/3.
    - No e2e: no spec opens `/customize/settings`, and `CustomizationBanner` fires `customize/runtime` on every page without asserting it.

**Assets, cost, limits**
- [x] **D17** `asset-store.ts`, `asset-list.ts`, `asset-ingest.ts` + `assets`, `assets/[hash]`, `assets/[hash]/uses`; `local-image` (139; path safety).
  — done 2026-10-28 (background agent): ported `asset-store.ts`, `asset-list.ts` and `asset-ingest.ts` to `claudius-core` (`asset_store.rs`, `asset_list.rs`, `asset_ingest.rs`), npm `image-size` 2.0.2 to `image_size.rs`, and the four route files to `claudius-server/src/assets.rs` (`GET /api/assets`, `GET`/`DELETE /api/assets/[hash]`, `GET /api/assets/[hash]/uses`, `GET /api/local-image`; one `.merge`). TS calls `recordSendUses` from the `input` route, not `sendInput`, and so does Rust now: `POST /input` runs `asset_ingest::record_send_uses` off the request for a prompt with images, sent now or queued (one 9-line hunk in `sessions.rs`). That finishes S32's `/input` ingest bullet, and S29 no longer waits on D17. `js_date.rs` (S33) now converts local times with jiff: `chrono::Local` read `2026-11-01T02:00:00` in New York an hour early.
    - Mirrored TS behaviors: `EXT_BY_MEDIA` is a plain object, so the media types `constructor` / `__proto__` get the extensions `function Object() { [native code] }` / `[object Object]`, and `local-image` serves `x.constructor` / `x.__proto__` (`x.tostring` is a 415). The stored dimensions come from the bytes (the first-byte shortcut, then the validators in the package's order), never from the declared type. A fractional `limit` reaches SQLite as a REAL and fails (Next's empty 500). Account rows' `cwd` is the encoded folder name. Foreign TEXT / BLOB / NULL cells answer as better-sqlite3 hands them to JS, and BLOBs never match `q` (`SQLITE_LIKE_DOESNT_MATCH_BLOBS`). `GET /api/assets/:hash` sends the row's media type (normalized like `Headers`; a NUL / CR / LF or non-Latin-1 one is an empty 500) and `size_bytes` as given. `local-image` checks the type (415) before the root (403). Its roots are `os.tmpdir()` (`TMPDIR` / `TMP` / `TEMP`, a relative one resolved against the server's cwd, `/` matching nothing) and `/tmp`, each as spelled and as `realpathSync` gives it. A tmp symlink pointing out is a 403 "path escapes the temp directory"; a dangling or looping link is a 404; the first `path` param wins.
    - Differences: a store path that leaves `assets/` (a foreign row's hash with `..`) is refused, where TS reads or deletes outside the store (3 recorded steps). `image-size`: reads past a truncated image under 4 KiB, which TS takes from Node's 8 KiB Buffer pool, count as past the end; the package's three endless loops (zero-size HEIF `ispe`, JXL `jxlp`, ICNS entry; 5 recorded) give no dimensions. V8's legacy `Date.parse` forms are NaN, so the backfill uses the clock (7 recorded). Past 63 account rows the sort is a stable merge sort, V8's order unless a comparison is NaN. `input`'s typed `images` parse drops every image if one is malformed, and replaces a non-string `uuid`, where TS records the valid images (S29).
    - Tests: `assets_golden.rs` (5) replays 2 613 `imageSize` inputs, 337 base64 strings, 100 `Date.parse` strings under America/New_York, 22 `extFor` types and 202 store / list / ingest steps on the real DB layer. `claudius-server/tests/assets.rs` (3) replays 79 asset requests and 103 `local-image` requests in 11 temp-dir worlds on the real binary, plus images sent through `/input` (now and queued) landing in `assets` / `asset_uses` and the store. Recorder run twice with identical output, ASCII-only, lint-clean.
    - Mutation: run 1, 147 mutants: 114 killed, 31 survived (each fixed by a new golden case or by removing an EXIF read that can't change the result), 2 didn't compile. Run 2, 197 mutants (every run-1 mutant still applicable, a fresh sample of each file, every candidate on the new lines): 168 of the 185 that compiled are killed. That includes the first-byte-shortcut mutant, killed by two new "webp that is also an SVG" inputs. The 17 survivors: 13 equivalent (a slice clamp at x == len; DDS / GIF shortcut keys the validator walk reaches anyway; a PAM line starting with U+0081, which can't key width / height; 7 in js_date's 400-year shift, where any shift count lands in the zone's stable region, and an unreachable fallback; Vec capacity; `used > 1`, since the assets upsert always reports 1 change), plus 4 in `cfg(not(unix))` code that isn't compiled on macOS.
    - Flake: 20/20 green (`assets_golden` and `assets`, throttled). Clone gate: 460 tests, 0 failed.
    - No e2e: the user's app holds `.next-e2e`. `markdown-tmp-image` requests `/api/local-image` from the backend and would cover it on Rust. No spec opens the Files page's asset grid (`app/[workspaceId]/assets`: `FileGrid`, `FileDetail`, `useAssets`) or sends images through `/input` against a live backend. Merged from the parallel clone (rebased onto main by the merge loop, which also switched its own `readdir` / `mtimeMs` copies to D20's `node_fs::readdir` / `node_fs::mtime_ms`).
- [~] **D18** `cost-aggregate.ts` (454), `litellm-pricing.ts` (`cost/refresh-prices`), `cost`, `cost/loops`; `limits` (`limits-store.ts`). deps: S17
  - [x] **D18a** `limits` + `litellm-pricing.ts` + `model-pricing-override.ts` + `cost/refresh-prices`.
    — done 2026-11-04 (background agent, merged by the loop): new `claudius_core::{limits_store, litellm_pricing, model_pricing_override}` and `claudius_server::{limits, cost_prices}` serving `GET`/`PUT`/`POST /api/limits` and `GET`/`POST /api/cost/refresh-prices`.
      - **Drift check: none.** Re-recording the golden against the current TS produced a byte-identical fixture, so the limits / litellm / refresh-prices port was already current, including CC 2.1.300's 1h cache-write slice (348fb993, 162bef99, 6def0e6c) in `cost_from_usage` (1h priced at twice the tiered input rate). The real gap was the third file: `model-pricing-override.ts` was unported apart from `MODEL_PRICING_MULTIPLIER_MAX` and `resolveManagedModelPricing`, and it carries the 1h slice for contracted rates — so its pure layer is ported now and D18b can't drift.
      - Mirrored: `req.json()` quirks (two BOMs, `1e400` as Infinity, lone surrogates kept) and a `null` body as Next's empty 500; `readLimits` keeping a non-object `limits` / `overrides` (a string spreads per code unit); JS key order; the `${sessionId}` conversion (an own `toString` that throws is a 500); the local-date override key; the 200-event audit cap; the inline resolve + `startsWith` barrier; undici's `res.json()` and the 5 s abort; the `{...bundled, ...cache}` order; `Object.prototype` hits in both lookups (priced 0) and the UTF-16 length tie-break.
      - Override layer: `overrides` wins only with at least one key, and its single `cacheWrite` prices both lifetimes; a null entry throws; an own falsy key shadows the prototype; the exact branch needs a truthy entry while the substring loop does not; rate fields coerce; the multiplier counts only as a finite number above 0, clamped at 10.
      - Deliberate differences: one process lock around limits writes (TS has none); background refreshes run on tokio workers, so one can land between two back-to-back calls (same end state); the day key uses jiff's system zone; a string that is exactly NUL + `js:Infinity` reads as Infinity; JSON nested past 128 levels fails; a string or array `rates` mirrors its indices and `length` but not the prototype method names the TS prices at 0; until D18b, Next's in-memory price memo doesn't see a refresh made through Rust.
      - Tests: `rust/scripts/limits-pricing-golden.mjs` (two identical recordings) → `claudius-core/tests/limits_pricing_golden.rs` (150 day keys over 10 zones, the bundle, 24 cache cases, 531 lookups, 242 costs, 13 background steps over the real HTTPS client and a raw-TCP fake, 582 modelPricing cases) and `claudius-server/tests/limits_prices.rs` (139 `/api/limits` requests with file changes, 39 refresh-prices requests with upstream and cache), plus 13 unit tests. Sabotaged fixtures fail as expected. Mutation: skipped (speed). Flake 3/3.
      - D18b's API: `PricingCache::get_pricing_table`, `price_for_model`, `cost_from_usage`, `apply_model_pricing`, `claudius_server::cost_prices::pricing(&AppState)`.
      - No e2e: `cc-parity-2.1.214-tool-caps` and `cost-tile` mock `/api/limits`, the chat-surface specs GET it for real, and `cc-parity-2.1.271-model-pricing-multiplier` covers the override UI. No spec drives refresh-prices.
  - [ ] **D18b** `cost-aggregate.ts` + `cost`, `cost/loops`, `cost/overview` (`cost-overview.ts`, `lib/shared/cost-overview.ts`; TS commit 62dfae19 added the cross-project spend overview after the port's base). deps: D18a

**Sessions collection** (proxied today)
- [x] **D19** `sessions/all` (`session-accounts.ts`, sessions-db), `sessions/info/[id]`, `export/[id]`, `transcript/[id]`, `file/[id]` DELETE.
  — done 2026-11-01 (merge loop): new `claudius_core::sessions_all` (`GET /api/sessions/all`: the SDK listing plus DB-only rows, titles and account pins) and `claudius_core::session_file` (the SDK's transcript lookup behind `getSessionInfo` / `getSessionMessages`, and `deleteSession`), served by `claudius_server::sessions_collection`: `sessions/all`, `info/[id]`, `export/[id]`, `transcript/[id]`, `file/[id]` DELETE (their proxy lines in sessions.rs are gone). Golden: `rust/scripts/sessions-all-golden.mjs` → `claudius-server/tests/sessions_all.rs`. Merged 2026-11-01 from its 2026-10-29 clone. Its agent was cut off by the session limit during mutation testing, before it could report; the one mutant it left applied was restored by checksum. Mutation unfinished, flake not re-run (speed). E2E deferred to the section-exit parity runs (S34 / D28).
- [x] **D20** `sessions/search` (148). Escape the query; never compile it as a regex.
  — done 2026-10-27 (background agent): ported to `claudius-core/src/session_search.rs` (scan, match, snippet, `respond`) and `claudius-server/src/session_search.rs` (GET only; one `.merge`, its proxy line dropped from sessions.rs); shared helpers `node_fs::readdir` / `node_fs::mtime_ms` and `js::stringify_utf16` (moved from session_transcript). The query is never compiled: each UTF-16 unit is canonicalized as V8's non-`u` `i` flag does (its `toUpperCase` if that is one unit and doesn't take a non-ASCII unit to ASCII) and a KMP over canonical units finds the first match in linear time. So σ/ς/Σ, µ/μ/Μ, ǅ/ǆ/Ǆ, Cherokee ꭰ/Ꭰ and Georgian ა/Ა match each other; ß matches only ß (not ẞ); ı, ſ, Kelvin K and İ don't fold to ASCII; ΐ, ﬁ, astral letters and lone surrogates match only themselves; one-byte strings add Ÿ/ÿ. Behaviors found: `q` is matched untrimmed over the raw JSONL, keys included (`"type":"user"` hits every file, `SS` hits `message`); `q=%FF`, `%E2%82`, `%EF%BF%BD` all become U+FFFD; the snippet is ±60 UTF-16 units and can cut a surrogate pair (printed `\udxxx`), unescaped in pass order (`\n`/`\r`/`\t` → space, then `\"`, then `\\`, so a raw `\\n` becomes `\ `; `\uXXXX`, `\/`, `\b` stay raw), JS whitespace collapsed, `…` at cuts; `limit` 0/""/abc/NaN → 100, -1/-Infinity/1e-9 → 1, 2.5 → 2, "3." → 3, 0x2 → 2, 1e3/Infinity → 200; first `q`/`dir` pair wins (`dir=&dir=x` is 400), `DIR=` is 400; the 600 newest `*.jsonl` by mtimeMs (stat failure = 0, ties in raw-byte name order, ns-distinct mtimes equal as doubles tie, 1960 and 0 sort last but are scanned), cut before the id filter so invalid names take slots; `.jsonl.bak`/`.JSONL` take none; a folder that is 000, r-only or x-only, a file as base, a missing folder and a 300-char dir (ENAMETOOLONG) all give `[]`; a symlinked base works; a symlinked transcript is read outside the base; dangling links, dirs named `.jsonl` and mode-000 files are skipped; colliding encodings (`/tmp/😀 x` = `/tmp/😁 x`, `../../etc` = `.:/.\-etc`); a FIFO `<id>.jsonl` hangs both. Differences: past `limit` matches TS answers in read-completion order, Rust in scan order; a 32 768+-unit query is V8's "Regular expression too large" (unreachable behind node's 16 KiB request head), which Rust searches; `CLAUDIUS_STATE_HOME` moves the scanned home. Tests: 8 unit; `tests/session_search_golden.rs` (all 65 536 units' case classes in two- and one-byte strings, 1 942 match/snippet cases, 149 route steps through `respond`); `claudius-server/tests/session_search.rs` (the 149 steps on the binary byte for byte, ReDoS patterns over a 1 000 000-unit line, a 40 000-unit query, POST 405); golden from `rust/scripts/session-search-golden.mjs` (recorded twice, byte-identical). Mutation 72/82; the 10 survivors are equivalent (`unit <= 128` / `cu > 128` edges no Unicode unit reaches, the truncating cast, the unreachable `project_base` / stat / read containment checks for names without `/`, dropping `is_file()`, no early stop, 8 or 1 workers). Flake: 20/20 runs of the 13 tests. No e2e: no spec turns on the Sessions page's "Search in transcripts" box (the route's only caller, `app/[workspaceId]/sessions/page.tsx`); `session-account-attribution` opens the Sessions page without searching; and the user's app holds `.next-e2e`. Merged from the parallel clone (rebased onto main by the merge loop after batch 3).
- [x] **D21** `sessions/open-tabs` GET/PUT (`open-tabs-db.ts`, 199).
  — done 2026-10-27 (background agent): `claudius_core::open_tabs` (open-tabs-db.ts), `claudius_core::active_cwd` (`resolveActiveCwd` plus the raw workspaces/customizations store reads it needs, self-contained until D01 lands), `sessions_db::get_session_titles_by_cwd` (per-cwd probe in chunks of 500, the cross-workspace fan-out, the legacy `session-titles.json` shadow read) and `claudius_server::open_tabs` (GET/PUT, Next's `RequestCookies` parser). Behaviours found: the cwd is the customization cookie's `src` mirror (path.join, so `..` climbs), else the workspace cookie, else the store hint, else the process cwd; a non-string rootPath reads defaults and makes every write an empty 500; rootPath "" is a real cwd (projects/.claudius.db), and its title lookup fans out with `*:` keys. Reads are read-only: no DB is created, only the project dir. A falsy stored value ("", 0, 0.0, NULL) is no value, a number parses from its JS text, a BLOB from its UTF-8; a DB not in WAL mode reads empty until a write; a ui_state without a unique key reads its first row and every upsert is a 500. PUT checks and writes tabs, activeId, pinned, labelMaxWidth in that order, so a bad later field is a 400 after the earlier ones were saved. A `null` body is an empty 500; any other non-object body answers ok and writes nothing; `1e400` is a 400 for activeId and labelMaxWidth. Ids are deduped then capped at 200; the width is Math.round'ed, then clamped to [60, 600]. There is no lock: concurrent PUTs land in any order. Titles are trimmed and `__proto__` is dropped; anything that throws in the lookup (a number or BLOB title, a non-string or inherited legacy entry, a null workspace, a DB without `sessions`) leaves titles {}. Differences: a lone surrogate is stored and answered as U+FFFD where TS writes the `\ud800` escape; a body nested past 127 levels is a 400 where V8 parses it; rusqlite's "unable to open database file" carries the path (log only); not recorded: TS's handle cache is keyed `${mode}:${cwd}`, so a non-string rootPath whose String() names an already-open cwd reuses that handle; the no-workspace fallback is the Rust process's own cwd. Tests: `tests/open_tabs_golden.rs` replays 134 DB calls, 37 clamps, 49 title lookups and 57 resolveActiveCwd calls (2 known differences); `claudius-server/tests/open_tabs.rs` replays 282 requests plus 3 concurrent batches (18 requests) and 47 row/exists checks on the real binary, byte for byte (4 known differences), 46 Cookie headers, and the route's place beside `/:id/*` (session routes still reached, `open-tabs/notification-prefs` → 404, POST/PATCH/DELETE → 405); all recorded by `rust/scripts/open-tabs-golden.mjs` from the real route in Next's request scope (stable over 2 runs). Mutation 87/94; the 7 survivors are equivalent (Rust's `round` vs JS Math.round inside the clamp; `{v}` vs the JS number text for integers 60–600; ENOENT vs other read errors, and null vs empty store files, where every caller catches; a non-array `workspaces` that is read as empty anyway; the fan-out `break`, since probing with no missing ids issues no query). Flake 0/20. No e2e: the user's app holds `.next-e2e`; session-tabs-pin, session-tabs-overflow, session-tabs-new-button-position, session-tab-switch, notifications-multi-tab, chat-scroll-pin, transcript-find and markdown-tmp-image call the real GET/PUT and would cover it (most other specs stub the route with page.route). Merged from the parallel clone (rebased onto main by the merge loop after batch 3); `active_cwd.rs` and the server's cookie parser are still its own copies, now that D01 has landed (I14).

**Misc**
- [x] **D22** `doctor` (470) + `doctor/fix` + `prompt-audit.ts` (214) + `claude-global-config.ts`.
  — done 2026-11-01 (merge loop): new `claudius_core::{doctor, prompt_audit, slash_commands, telemetry_env}` (the doctor's checks in TS order and key order, `doctor/fix`, `lib/shared/prompt-audit.ts` + `lib/server/prompt-audit.ts`, the slash-command lookup table, the ignored-env keys) on D12's `skills` / `claudemd` / `skill_names` (unified at merge: the prompt-audit golden now compares thrown errors by name + message), served by `claudius_server::doctor` (`GET /api/doctor`, `POST /api/doctor/fix`). Golden: `rust/scripts/doctor-golden.mjs` → `tests/prompt_audit_golden.rs`, `claudius-server/tests/doctor.rs`. Merged 2026-11-01 from its 2026-10-29 clone. Its agent was cut off by the session limit during mutation testing, before it could report; the one mutant it left applied was restored by checksum. Mutation unfinished, flake not re-run (speed). E2E deferred to the section-exit parity runs (S34 / D28).
- [x] **D23** `docker/containers` (246).
  — done 2026-10-28 (background agent): `GET /api/docker/containers` ported at byte parity (claudius-core `docker.rs` + `exec_file.rs`, server `docker.rs`). `exec_file` is `promisify(execFile)` on git.rs's run (`spawn_run`; `git()` and its tests unchanged): inherited env, 64 KiB lossy-UTF-8 reads, per-stream maxBuffer with Node's cut (`maxBuffer - bytes before` UTF-16 units of the crossing chunk), timeout SIGTERM, `Command failed: <file> <args>\n<stderr>`, exit code / null code, `spawn docker ENOENT|EACCES`. The route exports GET only, so no user value ever reaches docker's argv.
  Behaviors (recorded from the real handler): always 200 `application/json`. Argv `docker ps --format {{json .}}` (2 s) and `docker stats --no-stream --format {{json .}}` (3.5 s) start together, each with 4 MiB maxBuffer, and the answer waits for both. `sampledAt` is taken before the runs. Missing docker, or a script whose interpreter is missing (ENOENT) → `docker-not-installed` "`docker` not found on PATH". Not executable / a directory → `unknown` "spawn docker EACCES". Stderr matching `Cannot connect to the Docker daemon|connect: no such file or directory|connection refused`, ASCII-case-insensitive (Kelvin K and long s don't fold), → `docker-daemon-down` with stderr's raw first line (it can be "", keeps `\r`, and is still line 1 when the match is on line 2); the same text on exit 0 is `ok`. Anything else → `unknown` with JS-trimmed stderr, else the error message; rows printed before a non-zero exit are dropped. ps killed at its timeout → unavailable, but a ps that exited while a grandchild holds stdout resolves at 2 s with its rows, and one that ignores SIGTERM and exits 0 later resolves `ok`. stats failing (exit, signal, timeout, maxBuffer) only nulls the usage fields. Over 4 MiB: `stdout|stderr maxBuffer length exceeded`, or the kept stderr when there is any. Lines are split on `\n`, JS-trimmed (BOM/NBSP/U+2028/U+3000; NEL isn't JS whitespace, so a NEL-edged line fails to parse), and parsed as `JSON.parse` does (UTF-16 strings, lone surrogates, ±Infinity, duplicate key keeps its first slot and last value, integer keys first). `null` rows are dropped; other non-object rows become empty containers; pass-through fields are any JSON type, re-stringified. The join is on the first 12 UTF-16 units (can split a surrogate pair); the last stats row wins; falsy and array IDs never join. TypeErrors become `unknown` with V8's text (`(r.ID ?? "").slice is not a function`, `s.ID.slice is not a function`, `s.split is not a function`, `Cannot convert object to primitive value`), the first in evaluation order winning (MemUsage, Status, CPUPerc, MemPerc, BlockIO, NetIO). health = leftmost of the three parenthesised forms, ASCII-case-insensitive, on `String(Status)`. Percent = first `-?\d+(\.\d+)?` if finite. Sizes: ASCII-letter unit after JS whitespace, unknown units ×1, IO sums treat an unreadable part as 0. Invalid UTF-8 becomes U+FFFD.
  Differences: (1) a `docker` with no shebang runs through /bin/sh (std's execvp ENOEXEC fallback), where Node throws `spawn ENOEXEC` synchronously (unknown, stats never started); recorded. (2) An NDJSON line nested past 1000 levels is skipped, where V8 parses it; recorded. Not recorded: a maxBuffer cut inside a surrogate pair drops the high half JS keeps; docker inherits the server's env (Next adds NODE_ENV/__NEXT_*/.env*).
  Tests: `rust/scripts/docker-golden.mjs` drives the real route handler under node 22 (temp HOME/CLAUDE_CONFIG_DIR, `Date.now` pinned, PATH = a temp bin dir holding only a recorded /bin/sh fake `docker` that writes its argv and plays scripted stdout/stderr/exit/signals/delays/floods). It records 114 cases: fleet 7, lines 4, ids 2, parse 3 (39 health, 45 percent, 49 size rows), throws 43, spawn 5, daemon 16, exit 14, timing-ps 8, timing-stats 5, buffer 7. Two recordings match byte for byte. `claudius-server/tests/docker.rs` replays them on the real binary with the same fake (status, content type, body bytes or sha256 over 64 KiB, each verb's argv or not-run, time bounds, `sampledAt` within the request). That is 112 byte for byte plus the 2 listed differences checked as recorded alternates. The non-timing groups and each timeout group run on their own server, and each server proves it is its own through its fake. Core unit tests: docker 3, exec_file 4. Mutation 170/172 over docker.rs, exec_file.rs, the git.rs changes and the server module. Survivors are equivalent: the `String(null)` arm is unreachable, and feeding a TypeError's fixed message in as stderr gives the same detail. The first pass's 4 survivors were killed by new recorded cases, and the 45 health/size/join mutants were rerun on the final fixture, 45/45. Flake: 20/20 throttled runs. Gate in clone: 455 tests.
  No e2e: the user's app holds `.next-e2e`, and no spec reaches the backend route. `customization-docker.spec.ts` (overview, cards, unavailable) fulfils `/api/docker/containers` with `page.route`, and `site-screenshots` only shows `app/docker/page.tsx` as a file name. Merged from the parallel clone (rebased onto main by the merge loop).
- [x] **D24** `community/prefs`, `community/admin/check`, `community/admin/[...path]` (upstream proxy to the chat server).
  — done 2026-11-04 (background agent, merged by the loop): `claudius_server::community` on new `claudius_core::community`.
    - prefs GET/PUT: the two user-settings keys, the TS's exact 400 wording, the 64-UTF-16-unit nick cap, `nick: ""` deleting, and the merge written back onto whatever `~/.claude/settings.json` holds — a string, number, boolean or `null` file throws V8's TypeError (Next's empty 500) exactly where the TS does, and an array file keeps the keys in memory only.
    - `admin/check` is `!!token && !!url`. `admin/[...path]` takes GET/POST/DELETE with `X-Admin-Token`, `Content-Type: application/json` only when there is a body, and the caller's query string dropped (a mirrored TS bug). 503 without a URL, 403 without a token, and an empty 500 for a dead upstream or an upstream 204/205/304/above 599 (what `new Response` refuses).
    - `?client=` and the version mirror `community-client.ts` / `version.ts` (release from `NEXT_PUBLIC_CLAUDIUS_RELEASE`, else the `v<version>.N` git tags, else 0).
    - Deliberate differences: the chat URL and release are read at runtime (Next inlines them at build), a non-ASCII token goes out UTF-8 (undici uses latin1), no `vary`, and every other method — plus any catch-all path Next would redirect or rewrite — falls through to Next.
    - Tests: `rust/scripts/community-golden.mjs` → `claudius-server/tests/community.rs`: 141 prefs steps (including modes, symlinks, EACCES, EISDIR), 19 env groups, 85 proxied requests against a local fake chat server with 77 upstream requests compared on the wire, 72 client ids, 8 release scenarios, and the fall-through matrix. Mutation: skipped (speed). Flake 3/3.
    - No e2e: `community-nav` and the `/community` shots in `site-screenshots` stub the chat server and set no admin token, so they only touch prefs and check, which the replay covers byte for byte.
- [ ] **D25** Voice: `voice-stream.ts` (430) + `voice/chunk`, `voice/close`, `voice/stream`.
- [x] **D26** `heartbeat`, `heartbeatz` (db check), `splash-examples` (+ `splash-examples-db.ts`, `splash-fallback-name.ts`), `redirect-to-workspace.ts`.
  - [x] **D26a** `heartbeat`, `heartbeatz` (db check), and the splash core modules (`splash-examples-db.ts`, `splash-fallback-name.ts`).
      — done 2026-10-27 (background agent): **D26a.** New `claudius_server::heartbeat` serves `GET`/`HEAD /api/heartbeat` and `GET /api/heartbeatz` (HEAD is GET without the body, and the check still runs). New `claudius_core::splash_examples` (`splash-examples-db.ts`) and `claudius_core::splash_fallback_name` (`splash-fallback-name.ts`), with the API D26b's route sits on: `get_splash_examples` → `SplashExamples::to_json`, `set_splash_examples(&[Value])`, `reset_splash_examples`, `get/set_splash_display_name`, `resolve_splash_fallback_name`, the constants, and `JsString`/`json_array` (UTF-16 strings, so a cap that cuts a surrogate pair round-trips byte for byte). `db.rs`:
        - the schema version is JS `Number(value)` (` 25 `, `25.0`, `0x19`, `25e0`, `Infinity`, a REAL or INTEGER count as up to date; `abc`, `''`, `-1`, `0` and NULL run every migration; `10` reruns from 011);
        - the cleanup flag is only the text `'1'`;
        - `open_path` makes the folder with Node's `mkdir` walk (`ENOTDIR`/`EEXIST`/`EACCES: …, mkdir '<path>'`);
        - errors read as better-sqlite3's message (new `db::sqlite_message`, without rusqlite's `: <path>` or ` in <sql> at offset N`).
      Behaviors found (Next 16.3.8 probed live in dev and prod):
        - Every app-route response carries `vary: rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch`, and none sends Cache-Control. `heartbeat`'s HEAD is the module's own empty 200 with no content type. OPTIONS is 204 with `Allow: GET, HEAD, OPTIONS`. POST/PUT/DELETE/PATCH get an empty 405, any other method an empty 400.
        - `heartbeatz` reports `openDb`'s rejection as `detail` and answers 503. Once it has passed, the cached handle keeps it `ok` even if the file becomes garbage, its folder goes, or `projects` becomes a file.
        - Splash examples: trimmed, then cut at 240 units (a lone `\ud83d` can survive), blanks dropped. The 12-chip cap counts only kept chips, and nothing is deduped. Reads trim, drop blanks and cap at 12 but don't re-cut lengths. A read-only open of a rollback-journal DB gives the defaults. A BLOB row reads as UTF-8, a number or NULL row as the defaults. With a keyless `ui_state` the first row wins and writes fail with SQLite's ON CONFLICT / no-such-column message.
        - Display name: 60 units; `""`/blank/null deletes the row; reset keeps the name.
        - Fallback name: with 2+ accounts, the active label (no active one gives null). Otherwise a non-empty `displayName` wins (a blank one gives null). Otherwise the single account's label. First word only, split on JS whitespace (NEL, MVS and ZWSP don't split; a BOM is trimmed). The 30 s global-config cache also holds failures.
      Differences:
        - TRACE: Next's 500 (`TypeError: 'TRACE' HTTP method is unsupported`) is 400 here.
        - Next's `rsc`-header 307 and trailing-slash 308 aren't mirrored.
        - HEAD may carry `content-length`.
        - heartbeatz probes the *Rust* process's cwd (the same DB as TS only when both start in the same folder).
        - `/api/heartbeat` now answers 200 from Rust even while Next is down (it used to be proxied).
        - The check runs on the blocking pool.
        - Other ported routes still don't send `vary`.
      Tests:
        - `tests/splash_examples_golden.rs` replays 478 DB steps and 50 fallback cases (59 calls), recorded by `rust/scripts/splash-examples-golden.mjs` from the real TS on the real DB layer.
        - `claudius-server/tests/heartbeat.rs` replays 69 steps (35 requests) on the real binary, recorded by `rust/scripts/heartbeat-golden.mjs` through Next's own `autoImplementMethods`/`isHTTPMethod`. It ends with a Rust-only check that removing the server's cwd changes nothing; node 22 caches `process.cwd()` at boot, which I checked by hand.
        - Five unit tests.
        - Fixtures are byte-identical on re-record, and migration ids are templated (`$LAST`), so a new migration needs no re-record.
      Mutation 71/74. Equivalent survivors:
        - `displayName` as a non-string: the global-config store keeps only string fields.
        - Formatting the openDb error with `{e:?}`: anyhow's Debug of a context-free error is its message.
        - TS's `SELECT 1 returned no row` guard: unreachable.
      Flake 0/20 for each of the three test targets.
      No e2e: no spec under `tests/e2e` calls `/api/heartbeat*`. What covers it is `tests/electron-packaged/mac-smoke.spec.ts` / `appimage-smoke.spec.ts` › "embedded server answers /api/heartbeat", `electron/smoke.ts` and `site/test/test-install-public.sh` (heartbeat, then heartbeatz). All of them run against the Next/Electron server, not the Rust front door, and the user's app holds `.next-e2e`. The splash UI (`lib/client/useSplashExamples.ts`) only calls the D26b route.
      Split off:
        - **D26b**: the `splash-examples` GET/PUT/DELETE route, which needs D21's `resolveActiveCwd`; it should sit on the API above.
        - `redirect-to-workspace.ts` is a page helper and goes to **N02**. Merged from the parallel clone (rebased onto main by the merge loop after batch 3; its `db.rs` open-error mapping supersedes G01a's `open_error`, same message).
  - [x] **D26b** The `splash-examples` GET/PUT/DELETE route (`app/api/splash-examples/route.ts`) on `claudius_core::splash_examples` and D21's `resolveActiveCwd` (`claudius_core::active_cwd`). deps: D21
    — done 2026-10-28 (background agent): **D26b.** New `claudius_server::splash_examples` serves `GET`/`PUT`/`DELETE /api/splash-examples` on D26a's `claudius_core::splash_examples` / `splash_fallback_name`, D21's `resolve_active_cwd` and D01's cookie parser (`workspaces::request_cookies`; no third copy). Like `heartbeat`, it mirrors what Next sends around the module: `vary` on every answer (thrown 500s included, a `map_response` layer), HEAD = GET without the body, OPTIONS 204 `Allow: DELETE, GET, HEAD, OPTIONS, PUT`, POST/PATCH an empty 405, any other method an empty 400 (`heartbeat::other_method`, now `pub(crate)`). The body is read with lone-surrogate escapes kept (`js_string::parse`) and a literal past f64 as `false` (it fails every check Infinity fails); `JsString::from(&str)` now reads `js_string` stand-ins as lone surrogates, so a `"\ud83d"` chip or name is stored and answered as the `\ud83d` escape, as in TS. Behaviors found: the cwd is the customization cookie's `src` mirror (`..` climbs), else the workspace cookie (last duplicate wins, a bad `%` escape is skipped, names are case-sensitive), else the store hint, else the process cwd; the query string is ignored. PUT: a malformed body (empty, `{"examples":undefined}`, a trailing comma, three BOMs) is 400 `invalid JSON` before anything is read; any other body resolves the cwd and reads the chips first (the read-only open makes the project dir), so `null` is the empty 500 after the dir exists, and `[]`, `7`, `"x"`, `true`, `1e400`, `{}` answer the current state. `examples` must be an array (`null`, `{length:1}`, `±1e400` → 400); it is saved (non-strings dropped, trimmed, cut at 240 units, 12 max, no dedupe) with `customized: true` before `displayName` is checked, so `{examples, displayName: 5}` saves the chips and answers 400. `displayName` must be a string or null (`0`, `false`, `[]`, `1e400` → 400); null, "" and blank delete the row. With a name the answer's `override` is the saved value; without one it is re-read. The answer's chips come from the read before any write, so in a DB outside WAL mode (the read-only open fails) a name write answers the defaults with `customized: false` and the next GET shows the stored chips. DELETE removes both rows and ignores any body; with a keyless `ui_state` it still answers 200 while upserts are 500s. A rootPath that isn't a string, or is missing: GET and `PUT {}` answer the defaults and every write is the empty 500 (a bad field is still the 400 first). A newer schema without `ui_state`, a garbage file or a directory at the DB path: defaults, writes 500. Fallback: the first word of `~/.claude.json`'s displayName unless there are 2+ accounts (then the active label; none or an unknown active id → null); a blank global name gives null even with one account; with no global file, the single account's label. Concurrent PUTs each answer their own list, and the row holds one of them. Differences: a body nested past 127 levels is a 400 here where V8 parses it (recorded and listed). Not recorded: TRACE is 400 (Next 500), Next's `rsc` 307 / trailing-slash 308 aren't mirrored, and HEAD may carry `content-length` (as for heartbeat); a lone surrogate in an `accounts.json` label or the global displayName reaches the fallback as U+FFFD (the stores' `json_parse`); a real U+10F800–U+10FFFF character in a body string reads as the lone surrogate its stand-in names (D01's convention); TS's handle cache is keyed `${mode}:${cwd}`, so a non-string rootPath whose `String()` names an open cwd reads and writes that DB, where Rust answers the defaults / 500; the no-workspace fallback is the Rust process's cwd; DELETE runs its two deletes in turn (TS starts both at once; they share one handle and table, so they fail together); PUT reads the chips once (TS twice, which only differs with a writer between the two reads); a throw logs `[api/splash-examples] <message>` at error where Next prints the stack. Tests: `claudius-server/tests/splash_examples_route.rs` replays 3 phases (each a fresh world and server: a global display name, no `~/.claude.json`, a blank one), 267 steps and 189 requests (including concurrent batches of 6 PUTs and of 5 GET/HEAD/OPTIONS) on the real binary: status, non-transport headers and body byte for byte, `ui_state` rows as hex, project dir / DB existence; 2 known differences (the deep body and the next dump). `cookies_parse_like_next` replays D21's 46 recorded `RequestCookies` headers through D01's parser. Plus a core unit test (`stand_ins_read_as_lone_surrogates`). Recorded by `rust/scripts/splash-examples-route-golden.mjs` inside Next's request scope, with Next's `autoImplementMethods` / `isHTTPMethod` / vary constants (stable over 2 runs, fixture byte-identical on re-record). Mutation 41/45; the 4 survivors are equivalent: `b.get` in place of `js_member` for either `body.examples` or `body.displayName` (a `null` body throws at whichever read comes first, and nothing is written between them); a `null` name passed as `""` (both delete the row and answer null); DELETE dropping the reset's error (same handle, same table, so both fail together). Flake 20/20. No e2e: the user's app holds `.next-e2e`. No spec under `tests/e2e` drives the splash editor or reads the greeting (no `splash-*` test id is used), so nothing calls PUT or DELETE. Every spec that opens an empty chat (e.g. `cc-parity-2.1.198-api-retry` and `cc-parity-2.1.233-spinner-tip-agents-removed`, which wait on the SplashScreen) fires the GET through `useSplashExamples`, where a failure only leaves the built-in chips and no name. Merged from the parallel clone (rebased onto main by the merge loop).
  - `redirect-to-workspace.ts` is a page helper: moved to N02.
- [x] **D29** `POST /api/heapdump` is a Node heap snapshot with no Rust equivalent. Answer 501 with an explanation; revisit if a Rust diagnostics dump is wanted.
  — done 2026-11-01 (merge loop): new `claudius_server::heapdump`. `POST /api/heapdump` answers 501 in the route's error shape, `{"ok":false,"error":…}`, saying the route writes a Node diagnostic report and the Rust backend has no Node runtime to report on. While Next runs, its own report is still `POST /api/heapdump` on Next's port. No UI calls the route. Unit test on the handler; `route_coverage` counts it as rust (143 rust · 1 proxied · 39 next-only).
- [ ] **D27** Updater (`lib/server/updater/*`, ~2.4k lines):
  - **D27a:** `settings`, `status`, `log`, `check` (`detect.ts`), `changelog`.
  - **D27b:** `apply` (868), `restart`, `scheduler`, `spawn-env`, `git`.

  This is tightly coupled to the Electron and dev self-update flows, so read `electron/ipc/updater.ts` first.
- [ ] **D28** Section exit: re-run I04 and I01. Every route row reads `rust`; `proxy.rs` only serves pages, assets and HMR.

## 5R. TS drift since the port's base (found 2026-11-01)

The port was built on the `rust-port` branch, cut from `860dd77c` (cc-parity/2.1.299, 2026-10-14). On 2026-10-31 it was squashed onto `main` (`ebff55b0`), whose TS had moved on by 56 backend commits (CC 2.1.300 to 2.1.312, SDK 0.3.299 to 0.3.312): 66 backend files, +4182/-570 lines. Every module ported before 2026-10-31 matches the old TS, and so do its golden fixtures. Found while doing G07d: `scheduler-golden.mjs` no longer records the same output twice, because current runs stamp `pid`. Tasks started on 2026-11-01 (batches 1 and 2) read the current TS.
- Commit list: `git log 811d393b..ebff55b0~1 -- lib/server lib/shared app/api`; per file: `git diff 860dd77c -- <file>`.
- Client-only, no Rust work: `math-delimiters`, `lone-backslash`, `diff-overlay`, `compact-summary-tools`, `session-start-error`, `voice-stop-notice`, `effort-wait-note`, `auto-compact-window`.
- Covered by in-flight route tasks that read the current TS: voice (D25), feedback (G10), updater changelog (D27a), cost overview (D18b), files preview (D03c).

- [~] **R01** Scheduler: 33f463e5 + f5f80836 (CC 2.1.302: `lastSkipReason` / `lastSkipAt`, the missing-folder skip and its notification, `pid`-stamped runs, interrupted-run recovery at boot, `session_ended_without_result`), 58509ba3 + 5cebcacc (2.1.312: the job's `effort`, `schedule-form.ts` validation), and ecab6369's `session-loops/cancel` part. Sources: `scheduler.ts`, `scheduler-store.ts`, `lib/shared/schedule-skip.ts`, `lib/shared/schedule-form.ts` and the schedule routes. Normalize the run `pid` in the recorders, then re-record the scheduler, schedule-routes and schedule-stream goldens. deps: G07c
- [~] **R02** Session cost and usage fold:
  - Confirmed current 2026-11-04 by D18a: the 1h cache-write commits are ported (`cost_from_usage` prices the 1h slice at twice the tiered input rate), `model-pricing-override.ts` is ported too, and the pricing golden re-records byte-identically. So only `session.ts`'s 5m / 1h cache-creation split (40466e39) is left here.
  - Already ported 2026-10-27 (S17 follow-up): 191008d9 + a79c2c60 (and their merge, 204e2da5), including `sdk-cost-state.ts` and migration 025.
  - Left: 40466e39, in which `session.ts` accumulates the 5m / 1h cache-creation split. Also check the fold against the current `session.ts`.
  - The 1h cache-write rate commits (348fb993, 162bef99, 6def0e6c) touch only Cost-page modules (`cost-aggregate.ts`, `litellm-pricing.ts`, `model-pricing-override.ts`). D18a and D18b port those from the current TS.
- [~] **R03** Dead-session restart: 464b3dfe, 7e183a25, ecab6369 and 7d75710b. Sources: `session-manager.ts`, `session-resume.ts`, the `input`, `stream`, `queue/send-all` and `queue/[uuid]/send-now` routes, `session.ts`, `events.ts`.
- [~] **R04** Session features:
  - 5956c440 + 5f772b65: fast mode turns off when credits are rejected.
  - 68548d17: CronCreate `nextFireAt`, in `session-loops.ts`.
  - 6d757e88 + 2672dd71: a permission prompt says when a hook asked; the compaction-row path, incl. the `stream` route.
  - f74984c2: the compaction row in a resumed session.
  - c5c2b43f + ecab6369's ultrathink part: `ultrathink-keyword.ts`.
  - 8bbf10c0: the auto-mode settings keys (`settings.ts`, `auto-mode-disabled.ts`).
  - fa8904ea: `usage-behaviors.ts`.
  - a0d75d3e: symlinked-file permission prompts (`permission-symlink.ts`).
- [~] **R05** The CC 2.1.309 set: a99e6eb6, caf46433 and bff8370b, minus their voice and feedback-route parts (D25, G10) and their sign-in parts (R08). Sources: `sessions-db.ts`, `session-history.ts`, `dangerous-rm-deny.ts`, the session half of `feedback-refusal.ts`, the `sessions/all`, `sessions/rename` and `move-sessions` routes, `workspace-relocate.ts`.
- [x] **R06** Files, fs and search: fe320250 + 5246c455 (the `files` and `fs/list` routes, `fs-list.ts`, `file-types.ts`), and 49c5f28e + 554b9a9f (`sessions/search` skips `api-request*` entries).
  — done 2026-11-04 (background agent, merged by the loop): no new route, so `ROUTES.md` is unchanged.
    - fe320250 + 5246c455: new `claudius_core::file_types` (`BINARY_EXTS`, `isKnownBinaryPath`; the preview half is client-only). The files route now answers a known binary extension from `stat` alone — **before** the 2 MiB cap, so a real `.parquet` / `.heic` gets the placeholder rather than a 413 — and anything that NUL-sniffs as binary gets `{content: "", binary: true, encoding: "unsupported", encodingLabel: "binary", editable: false, readOnlyReason: "Binary file — not shown as text."}`. `?serve=1` still wins above it (415 for a non-image extension), and the extension is lowercased by JS `toLowerCase`, so a Kelvin-sign `MKV` counts.
    - A search whose own folder can't be read now fails instead of answering "no matches": `workspace_files::{search_files, search_contents}` and `fs_list::walk` return the root's `readdir` error (a sub-folder's is still swallowed), worded through the shared `claudius_server::fs_routes::search_failed` — 403 `Search failed: permission denied — can't read this folder (EACCES|EPERM)`, else 500 `Search failed: <node's scandir message>`. `listFs` therefore returns `io::Result`.
    - 49c5f28e + 554b9a9f: `session_search::first_hit` takes the first match that isn't on a raw JSONL line carrying the constant `"type":"api-request` (so `api-request-shape` / `-blob` / `-request` are skipped, jumping past the whole line as the TS moves `lastIndex`), and the snippet window is clamped to the matched line, so it never bleeds into the neighbouring entry.
    - Goldens re-recorded on the current TS, twice byte-identical: workspace-files (+87 steps, +179 `isKnownBinaryPath` paths and `BINARY_EXTS` in order as a new `pure` section), fs-list (a new `listfail` scenario: unreadable / file / missing root and the skipped child; `args` now recorded for 403/500 so the walk replays in process), and session-search (its block slicer fixed for the now-typed TS via `stripTypeScriptTypes`, +22 pure cases and a 9-transcript `api-request` world in the real 2.1.300 shapes).
    - Client-only, not mirrored: `BinaryFilePlaceholder`, `FileTree` / `FileEditor` / `FindInFolder`, and the `@`-picker's error row.
    - Mutation: skipped (speed). Flake 3/3 on all six test binaries. Verified green in main after the merge.
    - No e2e: `cc-parity-2.1.301-files-binary-search`, `cc-parity-2.1.280-at-mention-filename-ranking` and `composer-picker-key-select` would cover it.
- [~] **R07** Bash mode: 5a49e9b0 + f890f27b. `process-group.ts`, `bash-mode.ts`, `shell.ts`: SIGKILL the process group 1.5 s after SIGTERM.
- [~] **R08** Sign-in, hooks and skills:
  - eb115398 + b94df4fc: `account-oauth.ts`, a refused pasted sign-in code.
  - The sign-in parts of a99e6eb6 + caf46433 + bff8370b: `account-oauth.ts`, `account-profile.ts`, `tls-cert-hint.ts`.
  - 6ae15e48 + f2356f3c: `hook-events.ts` + `hooks.ts`, agent hooks saved as `{prompt, model}`, and their timeouts.
  - 1a748905: `skills.ts` writeSkill containment.
- [~] **R09** SDK 0.3.299 to 0.3.312. `rust/scripts/sdk-diff.sh` reports `ui_prompt_paint` (host-handled), `submit_survey_feedback` (host-sent), and `readsStartupMarks` + `CLAUDE_CODE_SDK_READS_STARTUP_MARKS`. Mirror them, re-record the section-2 wire goldens on 0.3.312, bump `SDK_VERSION`, and run `sdk-diff.sh --update`.
- [ ] **R10** Drift net: re-run every `rust/scripts/*-golden.mjs` on the current TS. A fixture that changes is unported drift: fix it, or add a task. deps: R01, R02, R03, R04, R05, R06, R07, R08, R09

## 6. Retire the Next.js server (keep the React UI, drop Node at runtime)

- [x] **N01** Audit the server components that import `lib/server`: `app/page.tsx`, `app/[workspaceId]/layout.tsx`, ~20 pages (`database`, `pipeline`, `schedule`, `settings`, `memory`, `keybindings`, `docker`, `cost`, `plugins`, `workspace`, `[workspaceId]/{schedule,keybindings,cost,workspace,mcp,agents,hooks,assets}`, …). Classify each as redirect-only, server data fetch or type-only. Write the list to `rust/parity/server-components.md`.
  — done 2026-11-01 (background agent, read-only audit; written by the merge loop): `rust/parity/server-components.md`. All 73 non-API files under `app/` plus `proxy.ts` (Next 16.4.3):
    - 26 server components, nearly all redirect-only. The only real server read is `customize/[id]/chat` (it needs `srcDir`, which no endpoint returns yet, so N03 must add one).
    - The `claudius.workspace` cookie sync in `proxy.ts` is load-bearing: most workspace pages read the cookie, not the URL.
    - Under `output: "export"` a leftover server component runs once at build time and bakes its redirect into the HTML, so each must be converted or deleted.
    - The five `useParams()` / `use(params)` readers must parse `usePathname()` before N04's placeholder params.
    - The rules must also cover router payload fetches (`.txt`, `_rsc`).
    - The doc has the N02 rule table (R1-R6) and the N03 conversion table. No e2e covers the `/welcome` or `customize/<id>/chat` redirects.
- [x] **N02** Move `proxy.ts` (the workspace cookie and bare-path redirects) and the redirects in `app/page.tsx` / `[workspaceId]/layout.tsx` into axum middleware. Also `lib/server/redirect-to-workspace.ts` (split from D26).
  — done 2026-11-04 (merge loop): new `claudius_server::pages`, the router's fallback. It answers N01's six rules and hands everything else to `proxy::handler`, so pages, assets and the HMR socket still reach Next:
    - **R1** `/` → the active workspace (cookie, then the store's `activeId`, then the first), else `/welcome`. The query survives except on the `/welcome` leg, as `redirect()` drops it.
    - **R2** a bare scoped path (`/git`) → under the cookie's id with no store check (proxy.ts job 2, any depth), else — only where a stub exists (the 18 one-page stubs, or any depth under the `sessions` / `dev` catch-alls) — under the active workspace's id, else `/` (`redirectToWorkspaceRoute`).
    - **R3** `/<wks_id>/…` writes the id back to the `claudius.workspace` cookie, in the same `Set-Cookie` form `POST …/select` builds, and passes the request through.
    - **R4** an id the store doesn't have → `/` (the cookie is still written, since the proxy runs first).
    - **R5** `/welcome` with any workspace → `/`. **R6** `/customize/<id>/chat` for an unknown customization → `/customize`.
    - Deliberate differences: always a 307 (Next sends the server components' `redirect()` as a 200 with a meta refresh, or a flight redirect on a router fetch; no test pins the page status); R3 and R2 run for every method as Next's proxy does, while the store-reading rules stand in for a page render and so run only for GET/HEAD; a failed store read is a plain 500.
    - `_rsc` survives a redirect that drops the rest of the query, since Next 16 validates it.
    - The TS is left in place for now: Next answering the same redirect behind Rust is harmless, and N03 is what deletes `proxy.ts`, the 20 stubs, `redirect-to-workspace.ts` and the three redirect-only server components.
      - One transitional wrinkle: on a request Rust passes through, `proxy.ts` sets the same cookie again, so the response carries two identical `claudius.workspace` headers (`append`, so neither is lost). The browser applies the same value twice. It resolves itself when N03 deletes `proxy.ts`.
    - Tests: 14 unit tests over a fake store cover every rule, the `wks_<12 hex>` shape, the matcher and the non-page methods, plus `a_scoped_name_per_workspace_route`, which keeps the `SCOPED` list equal to the directories under `app/[workspaceId]/`. `claudius-server/tests/pages.rs` drives the real router in front of a stub Next: the fall-through, each redirect's `Location`, and the exact `Set-Cookie`.
    - E2E deferred to the section-exit parity runs. `workspace-route-memory`, `workspace-cwd-binding`, `community-nav` and the 136 specs that `goto("/")` all exercise these rules.
- [ ] **N03** Convert data-fetching server components to client fetches against the API, or to a Rust-served bootstrap JSON. This needs edits in `app/` that keep the UI behaviour identical; verify with e2e.
- [ ] **N04** Static build of the UI (`output: "export"` or an equivalent pipeline). Handle dynamic segments (`[workspaceId]`, `sessions/[[...rest]]`, `customize/[id]`, `dev/[[...rest]]`) with an SPA fallback in axum.
  Carried over from N01's audit and N02:
  - Export mode rejects a dynamic page without `generateStaticParams`, and that export can't come from a `"use client"` file, so each segment needs a server layout with one placeholder param (`__ws__`, `__sid__`, `__cust__`) and `dynamicParams = false`. axum then maps real ids onto the placeholder's files.
  - The five `useParams()` / `use(params)` readers must parse `usePathname()` first (N03), or they read the placeholder: `[workspaceId]/page.tsx`, `[workspaceId]/sessions/page.tsx`, `[workspaceId]/sessions/[id]/page.tsx`, `customize/[id]/page.tsx`, `components/chat/SystemPill.tsx`.
  - `claudius_server::pages` (N02) only answers document paths today: its matcher drops anything with a `.` in it, so the router payload URLs (`<p>.txt`, `/index.txt`, `<p>/__next.<segments>.txt`) fall through. In export mode they must go through the same rules, with the suffix stripped and re-appended.
- [ ] **N05** Serve the static UI from axum (`tower-http` `ServeDir` in dev, `rust-embed` in release) with correct cache headers and an SPA fallback.
- [ ] **N06** Dev workflow: `next dev` stays available for UI HMR behind the proxy; the production binary has no Node dependency. Document both in README.
- [ ] **N07** Full e2e suite against the Rust-only server (no Next) → `rust/parity/e2e-status.md` at 100% (or documented exceptions).
- [ ] **N08** Electron: `electron/server.ts` spawns the `claudius` binary instead of the Next standalone server (port selection, health check on `/api/rust/health`, logs, shutdown); update `electron/proxy.ts`.
- [ ] **N09** Packaging:
  - `release.yml` builds `claudius` for darwin arm64 + x64 (lipo to universal) and adds it to electron-builder `extraResources`
  - codesign the binary, notarize
  - keep the `latest-mac.yml` manifest flow intact (see the release-manifest memories)
- [ ] **N10** Drop `better-sqlite3`, native-abi hooks and the Next standalone payload from the packaged app once nothing at runtime needs them.
- [x] **N11** Add Rust to `codeql.yml`; port the CLAUDE.md security rules (path injection, regex injection, randomness) to Rust guidance in PORT_PLAN.
  — done 2026-11-01 (merge loop):
    - `.github/workflows/codeql.yml`'s matrix is now `include:` with `javascript-typescript` and `rust`, both `build-mode: none` (passed to `init`). Rust is extracted from source: rust-analyzer runs the build scripts, with no cargo build.
    - PORT_PLAN's Parity rules have a "Security rules" block for Rust: paths (`node_path::resolve` + an inline `starts_with(base + "/")` at the sink, no `Path::join` or `canonicalize` unless the TS does), regexes (never compile request data; `regex::escape` or a literal match; no backtracking engine), randomness (OS randomness for security values, rejection sampling, cosmetic picks untouched), processes (argv only) and no `re2`.
    - Not run locally (no CodeQL CLI here). The first CI scan on a public repo verifies the Rust extraction; triage its `rust/*` alerts with the security-triage skill.
- [ ] **N12** `bin/claudiusd` and the Makefile `run`/`up`/`down`/`status`/`logs` targets drive the Rust binary.

## 7. Native Rust UI (replaces React + Electron)

- [?] **U00** **DECISION — ask the user.** Choose the UI toolkit. Spike 2–3 candidates (e.g. Dioxus, GPUI, Slint, egui; Tauri+React as an incremental bridge), each rendering a live transcript + composer from `claudius-core`. Compare:
  - markdown and code rendering, text selection, IME, accessibility
  - HTML previews (AskUserQuestion `previewFormat: "html"` needs an HTML surface)
  - performance on 10k-event transcripts, packaging size

  Write `rust/docs/adr-ui-toolkit.md` and present it. **The loop stops here until the user decides.**
- [ ] **U01** `claudius-client` crate: port `lib/client/use-session.ts` (7.1k lines) as a pure Rust state machine over server events, with types from `lib/client/types.ts` (1.5k) and `lib/shared/*`. Accept: replay recorded SSE logs (capture fixtures from the React app) and assert the derived state. deps: U00
- [ ] **U02** Transport trait: in-process (`claudius-core` subscribe, no HTTP) and remote (SSE + REST against a `claudius` server). deps: U01
- [ ] **U03** Design system: tokens from `app/globals.css` `@theme` (colors, type, spacing, radii), icons, light/dark, density. deps: U00
- [ ] **U04** App shell: window, sidebar nav (`components/nav`), workspace switcher, session tabs (open tabs), routing between screens. deps: U02, U03
- [ ] **U05** Chat transcript (`components/chat`, 58 files / 19k lines):
  - virtualized message list, user/assistant bubbles, streaming text
  - markdown (`pulldown-cmark`), code highlighting (`syntect`/tree-sitter replacing shiki)
  - system rows, hooks rows, peer messages, verbose mode

  deps: U04
- [ ] **U06** Tool call cards: Bash, Edit/Write (diff), Read, Grep/Glob, Task/subagents, Workflow, WebFetch/Search, MCP tools, elapsed timers; diff overlay. deps: U05
- [ ] **U07** Composer:
  - editing: multiline editor, history, drafts (prompt-draft), prompt color
  - pickers: slash commands (fuzzy, highlight), `@` file/agent mentions, emoji shortcodes
  - input: image paste/drop, inline pastes, voice (`useVoice`)
  - queue: queue strip (edit/move/send-now), `!` bash mode

  deps: U05
- [ ] **U08** Prompts: permission card (rule preview, auto-mode tip, deny with feedback), AskUserQuestion (multi-question, HTML preview), plan approval (edit/reject), elicitation forms (schema-driven). deps: U05
- [ ] **U09** Status line + session card:
  - pickers: model, effort, advisor, mode, fast, output style
  - meters: context bar, cost/usage
  - panels: goal banner, todos panel, tools panel, tasks/subagents, activity feed (`components/panels`)

  deps: U05
- [ ] **U10** Overlays (`components/overlays`, 16 files): context, skills, diff, transcript viewer, transcript search (client-side regex is OK here), keyboard shortcuts (`lib/client/shortcuts.ts`, 871), command palette. deps: U05
- [ ] **U11** Sessions browser: list/search/filter, fork, resume, rename, export, delete. deps: U04
- [ ] **U12** Git UI (`components/git`, 3.5k lines) and the files browser + preview (`components/files`). deps: U04
- [ ] **U13** Settings and config screens: settings (all scopes), permissions, hooks, keybindings, skills, memory, MCP, plugins, agents, CLAUDE.md editor, customize-settings. deps: U04
- [ ] **U14** Cost, usage, limits, schedule (runs + live stream), doctor, docker, notebooks, tracker, pipeline, database, release notes, welcome/onboarding. Decide per page whether it survives; dev preview pages are `[-]`. deps: U04
- [ ] **U15** Notifications center + OS notifications + dock badge (replaces `electron/ipc/notifications.ts`, `badge.ts`). deps: U04
- [ ] **U16** Community (`components/community`, `use-community.ts` 922, `use-dms.ts` 390, community notifications 773) against the chat server. deps: U04
- [ ] **U17** Customize UI (customizations list, preview, publish, diff, chat). deps: U04
- [ ] **U18** Native platform features (replace `electron/ipc/*`): menus (`menu.ts`), deep links, context menus, dialogs, in-app browser (webview), link targets, permission priming, release counter, self-replace, splash. deps: U04
- [ ] **U19** Auto-update for the native app (replace electron-updater: Sparkle-style appcast or `self_update`), keeping the release manifest contract. deps: U18
- [ ] **U20** Packaging: macOS bundle, signing, notarization, DMG (Windows/Linux optional, `[?]` for the user). deps: U19
- [ ] **U21** UI test strategy: state-machine snapshot tests (U01) + a scripted driver over the accessibility tree. Port the highest-value Playwright specs, and track them in `rust/parity/native-ui-status.md`. deps: U05
- [ ] **U22** Accessibility (VoiceOver), IME and keyboard-only parity pass. deps: U10

## 8. Cutover and cleanup

- [ ] **T01** Parity sign-off: web UI on Rust at 100% e2e; native UI checklist complete; live smoke green.
- [ ] **T02** Release the Rust backend in the desktop app (feature flag → default), keeping a fallback release channel on the TS backend for one cycle.
- [ ] **T03** Remove the TS backend (`lib/server`, `app/api`) after the fallback cycle, and later the React UI once the native UI ships.
- [ ] **T04** Docs: README, CLAUDE.md (Rust conventions, security rules), PORT_PLAN marked complete.
- [ ] **T05** Dev automation (`make sdk-update-*`, `cc-parity-*`, `heartbeat-*`, `update-*`): keep it in TS/bash or port it; it must target the Rust SDK host (A06). `[?]` scope for the user.
- [ ] **T06** `chat-server/` (Bun, 2.3k lines) → axum port. Optional, `[?]` for the user.
- [ ] **T07** Telemetry (the PostHog proxy) and the marketing screenshots pipeline (`site/`) for the native app.
- [ ] **T08** Fix the TS bugs the port mirrors on purpose (PORT_PLAN "Mirrored TS bugs"), on both sides at once so parity holds. First: TaskCreate's "already promoted" dedupe never matches a promoted id, so a re-broadcast TaskCreate duplicates its to-do. `[?]` for the user: fix in TS now, or after cutover.
  - [?] **T08b** **A live information leak in the shipping TS, found by D03c. Ask the user before editing (TS outside `rust/`).** `app/api/workspaces/[id]/files/preview/[...path]/route.ts:119` answers with `new Blob([content.buffer as ArrayBuffer])`. `content` is the `Buffer` `fh.readFile()` returned, and `.buffer` is the whole `ArrayBuffer` it is a view onto — for an empty file that is the 64 KiB `allocUnsafeSlow` scratch chunk, so the response body is 65 536 bytes of uninitialized process memory (whatever that memory last held) instead of nothing. The fix is to pass `content`, the view, rather than `content.buffer`. Rust already serves the empty body, so fixing the TS brings them into agreement rather than breaking parity. No spec loads the preview iframe, so no test pins the current bytes.
  - [x] **T08a** **Decided 2026-10-29 (user): keep TS behaviour.** Symlink containment in the ported file routes: `fs/dirs` (D04), `agents` (G05) and `memory/auto` / `memory/rules` (G08) check containment on the path text only and follow symlinks, as TS does. A repo that ships e.g. `.claude/rules/x.md` as a symlink to `~/.zshrc`, plus a forged cross-origin `PATCH`, overwrites that file. Proposed fix (both sides at once): refuse when the resolved target leaves the resolved folder. It breaks rule / agent / memory files that are themselves symlinks into a dotfiles repo, so it needs the user's call.
    — decided 2026-10-29: keep the TS behaviour on both sides (containment on the path text, symlinks followed). No code change; the ported routes keep mirroring TS and list it under PORT_PLAN "Mirrored TS bugs". Revisit only if the TS side changes.

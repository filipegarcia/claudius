# Claude Code 2.1.208 → 2.1.288 parity audit — TODO

The local `claude` CLI jumped from **2.1.208 → 2.1.288** (baseline proven from the
`version` field of the last interactive-CLI transcripts before the upgrade). That
range is 68 published releases / ~3,040 changelog bullets (1,531 `Fixed`, 220
`Added`, ~1,290 Improved/Changed/…), sourced from
<https://code.claude.com/docs/en/changelog> (generated from upstream `CHANGELOG.md`).

Every non-`Fixed` bullet was re-classified against the **actual code** (not the
hourly cc-parity bot's run-notes, which turned out to contain several phantom
implementations and false-rationale skips). `Fixed` bullets were only flagged when
they name a surface Claudius reimplements itself (bucket **F**) — engine fixes
already arrive with the SDK 0.3.288 bump (#282).

Buckets: **A** engine behaviour, works with zero Claudius code · **B** product
surface Claudius must reimplement · **C** terminal/CLI/IDE/cloud-only · **F** a
CLI bug fix whose bug Claudius's own reimplementation shares.

Per-release evidence tables (every non-Fixed bullet, bucket, status, file:line /
grep evidence): [`audit/chunk0.md`](audit/chunk0.md) (2.1.285–288) …
[`audit/chunk7.md`](audit/chunk7.md) (2.1.209–217).

| range | rows | A | B | C | F |
|---|---|---|---|---|---|
| 2.1.285–288 | 153 (+13 F checked) | 53 | 16 | 84 | 13 |
| 2.1.281–284 | 178 | 64 | 31 | 81 | 2 |
| 2.1.274–280 | 136 | 43 | 19 | 62 | 9 |
| 2.1.267–273 | 150 | 52 | 25 | 71 | 2 |
| 2.1.251–266 | 140 | 55 | 31 | 44 | 5 |
| 2.1.235–250 | 136 | 49 | 34 | 33 | 15 |
| 2.1.218–234 | 180 | 84 | 41 | 52 | 0 |
| 2.1.209–217 | 76 | 30 | 25 | 17 | 4 |

### Bot pipeline findings (why this audit was needed)

- **Phantom implementations** (run-note says shipped, no code on any branch):
  2.1.215 "Session limits" settings + "Needs input" status · 2.1.220 `strictAllowlist` ·
  2.1.271 `modelPricing` multiplier (writes keys the engine never reads) ·
  2.1.274 memory-critical banner · 2.1.281 `AttributionCatalogField` ·
  2.1.282 `maxProseWidth` slider / Ultracode plain styling.
- **Built but never merged** (stranded on bot branches): `c7e56ec`+`8513ab2`
  (2.1.218), `3b66af8` (2.1.277), `c8cdef2` (2.1.284).
- **False-rationale skips**: 2.1.257 Fable 5.1 pricing/labels, 2.1.247 SendFeedback
  card + spinnerTipsOverride fields, 2.1.268 credits copy, 2.1.280 large-paste
  marking, 2.1.285 System tasks, 2.1.221 `/fork` worktree.

---

## Wave 0 — land stranded bot work

- [x] **O1** [2.1.218] Cherry-pick `c7e56ec`+`8513ab2`: MCP config hidden-whitespace warning, agent `name:` colon validation, fast-mode notice on model switch
- [x] **O2** [2.1.277] Cherry-pick `3b66af8`: AGENTS.md fallback on the Memory page, hold prompts with invisible Unicode for review (reuse `lib/shared/invisible-unicode.ts`, drop the duplicate `sanitize-prompt.ts`), deprecate `taskOutputMaxChars`
- [x] **O3** [2.1.284] Cherry-pick `c8cdef2`: `/mcp` "Reconnect all" + `/rate-limit-options`

## A — Security & permissions

- [x] **A1** [2.1.235] **Security:** "Always allow" saves a whole-tool rule (`Bash` for `git status`). Use the SDK's `ctx.suggestions` (narrow rules) and show them in the prompt; never silently fall back to a whole-tool rule
- [x] **A2** [2.1.211 F] Permission prompt shows bidi-override / zero-width chars raw — render them as visible escapes
- [x] **A3** [2.1.248] Restricted mode is partial: engine-level enforcement (verify `CLAUDE_CODE_RESTRICTED`), block `Monitor`/`TaskStop`, drop stale tool names
- [x] **A4** [2.1.259] Pass `permissionPrompts: "none"` to unattended runs (scheduler, updater apply)
- [x] **A5** [2.1.280] Hooks editor: disallow/flag `agent`-type hooks on `PermissionRequest`
- [x] **A6** [2.1.212] Auto-mode tab: "Reset to defaults" with confirmation
- [x] **A7** [2.1.219] Sandbox `network.allowedDomains` + `network.strictAllowlist` in the workspace sandbox settings
- [x] **A8** [2.1.212] WebSearch/subagent per-session caps: forward the `CLAUDE_CODE_MAX_*_PER_SESSION` env, fix `Task`→`Agent` tool-name matching
- [x] **A9** [2.1.260 low] Permission-rule lint: flag ambiguous `\(` in Windows paths

## B — SDK message plumbing (session.ts ↔ use-session.ts)

- [x] **B1** [2.1.267/2.1.274 F] Render `system/notification` text (priority-coloured) and `system/local_command_output` content instead of a bare label
- [x] **B2** [2.1.217] Map system message `level` to pill tone; hide `info`-level lines
- [x] **B3** [2.1.284] Safety-block notice: handle `model_refusal_fallback` / `model_refusal_no_fallback`, explanation + "Edit & retry"
- [x] **B4** [2.1.288] MCP URL elicitation: "I'm done, continue" when there is no `elicitationId`; handle `elicitation_complete`
- [x] **B5** [2.1.271] Hook-running feedback: `includeHookEvents`, "Running <event> hook · Ns" in the status line
- [x] **B6** [2.1.212] "Needs input" session status when a turn is blocked on a prompt
- [x] **B7** [2.1.288 F] Don't fire "Claude finished" (`session_idle`) while background agents are still running
- [x] **B8** [2.1.216 F] Slash-command list goes stale after reload (update the init snapshot on `commands_changed`)
- [x] **B9** [2.1.273/2.1.288] MCP server drops mid-session / asks for more OAuth scope → re-show the disconnected / needs-auth notice
- [x] **B10** [2.1.275] Sent messages render dimmed until the model receives them
- [x] **B11** [2.1.284 low] Monitor events: show `<task-notification>` output instead of dropping it

## C — Tasks & transcript rendering

- [x] **C1** [2.1.271] Task status `paused` (+ `total_paused_ms`) — keep paused workflow agents visible
- [x] **C2** [2.1.285] Fold Claude Code's own housekeeping tasks (`skip_transcript`) under a "System tasks" group
- [x] **C3** [2.1.243 F] Error-tagged assistant replies (`server_error`, `billing_error`, …) get error styling
- [x] **C4** [2.1.271] "Deep in thought" only while no tool is running; "Picking the thought back up" after `max_output_tokens`
- [x] **C5** [2.1.243] Show each subagent's model / effort in the task block and Activity panel _(model only; effort has no SDK source — `AgentInput` carries only `model`, task messages carry neither)_
- [x] **C6** [2.1.280 F] Strip the internal "[Subagent hand-back]" frame from subagent results
- [x] **C7** [2.1.257 low] Coalesce hook-completion notices
- [x] **C8** [2.1.243 low] Compaction stall hint

## D — Composer & slash dispatch

- [x] **D1** [2.1.248] `/loop` is wired to the Schedule page and drops its arguments — forward to the SDK
- [x] **D2** [2.1.246 F] Prompts that start with `/` but aren't commands (`/--`, `/usr/bin/x …`) are swallowed as "Unknown command"
- [x] **D3** [2.1.287 F] A user command with the same name as a built-in (`/usage`, `/context`, …) should run the user's command
- [x] **D4** [2.1.265] Slash suggestions mid-prompt; plugin skills selectable by bare name
- [x] **D5** [2.1.288] ↑ on an empty composer restores a draft cleared with Ctrl+C / Esc-Esc (incl. images)
- [x] **D6** [2.1.280] Mark large pastes (`inline_pastes`) so Claude can tell them from typed text
- [ ] **D7** [2.1.232] `@`-mention another live session _(BLOCKED — delivery is engine-gated: the `@`-mention's only purpose is to trigger the agent's `SendMessage` tool, but it can't be confirmed that outbound `SendMessage` is live in a Claudius SDK session (init `tools` isn't persisted to transcripts; not in `RESTRICTED_MODE_DISALLOWED_TOOLS`, so plausibly present but unverified) and the CLI's session-mention token contract isn't extractable from the native binary. Building the picker on an unconfirmed delivery path = phantom risk. Needs a live-session `GET /api/sessions/<id>/commands` (or init `tools`) check to confirm `SendMessage`, and the CC token format, before building.)_
- [x] **D8** [2.1.259] `/install-github-app` in a GitLab repo → GitLab CI/CD docs
- [x] **D9** [2.1.286 low] Slash picker: match descriptions by word prefix, not loose letter-sequence
- [x] **D10** [2.1.223 low] `/review` description is stale (now an alias of `/code-review`)
- [ ] **D11** [2.1.265 low] Toast when an oversized image is dropped
- [ ] **D12** [2.1.278 low] `@./src` — normalise the leading `./` in file mentions
- [ ] **D13** [2.1.286 low] `/output-style` picker instead of a toast
- [ ] **D14** [2.1.285 low F] User text after a leading `<command-name>`/`<local-command-stdout>` tag is lost

## E — Models, pricing, usage & limits

- [ ] **E1** [2.1.257/2.1.284/2.1.219/2.1.280] Pricing for Fable 5.1, Sonnet 5.5, Opus 5 / 5.5 (`cost-pricing.ts`, LiteLLM fallback + bundled snapshot)
- [ ] **E2** [2.1.257/2.1.284/2.1.219] Model lists/labels: Sonnet 5.5 + Opus 5 probe rows, Fable 5.1 labels, overload nudge → `sonnet` alias
- [ ] **E3** [2.1.284/2.1.282] Ultracode is an independent toggle at any effort, plain styling, `/effort` args handled
- [ ] **E4** [2.1.257] `/effort` "this session only"
- [ ] **E5** [2.1.267 low] Respect `maxEffortLevel` in the model picker
- [ ] **E6** [2.1.261] Friendly model names in session/status pills
- [ ] **E7** [2.1.271] `modelPricing`: real keys (`multiplier`, `overrides`) and the managed source via `resolveSettings()`
- [ ] **E8** [2.1.236] `/usage` usage-credits row (`extra_usage`)
- [ ] **E9** [2.1.284] Usage-limit panel: no "upgrade" for Team/Enterprise, usage-credits link
- [ ] **E10** [2.1.268] 1M-context credits notice: credits take effect after a restart + restart button
- [ ] **E11** [2.1.234] `autoContinueAtUsageLimit` setting + "Continuing automatically at HH:MM · Cancel"
- [ ] **E12** [2.1.239 low] Cost page: 1.1× US-only `inference_geo` premium
- [ ] **E13** [2.1.283 low] `deniedModels` must hide always-shown aliases
- [ ] **E14** [2.1.273 low F] Auth-failed copy for Bedrock / gateway (403)

## F — Markdown, settings page & chrome

- [ ] **F1** [2.1.281/2.1.274 F] Ordered lists keep their `start` number (and the user's typed numbers)
- [ ] **F2** [2.1.216 F] Right-to-left text (`dir="auto"`)
- [ ] **F3** [2.1.282] `maxProseWidth` actually caps prose width
- [ ] **F4** [2.1.257] `timeFormat` / `timeZone` drive Claudius's own clocks
- [ ] **F5** [2.1.239] Middle-truncate long paths on tool rows (keep the filename)
- [ ] **F6** [2.1.216] `/context` overlay: "over the window" callout with `/compact`/`/clear`
- [ ] **F7** [2.1.281] `attribution: false` settings row; mark `includeCoAuthoredBy` deprecated
- [ ] **F8** [2.1.288] Per-model `autoCompactWindow` overrides in Settings
- [ ] **F9** [2.1.287 low F] Respect `prefers-reduced-motion` / `prefersReducedMotion`
- [ ] **F10** [2.1.247] SendFeedback draft card reads `title`/`details`
- [ ] **F11** [2.1.261 low] `forceLoginMethod: "gateway"` option
- [ ] **F12** [2.1.280 low] `effortLevel` settings description (ignored for new models)
- [ ] **F13** [2.1.269/2.1.271 low] Tips for `/focus` and `/desktop`

## G — Plugins, marketplaces, agents/skills/memory files

- [ ] **G1** [2.1.223/2.1.232/2.1.238] Marketplace settings editor corrupts `settings.json` (`extraKnownMarketplaces` map, `strict`/`blocked` source objects, `headersHelper`, archive/command sources, `owner/*`)
- [ ] **G2** [2.1.265 F] Plugin descriptions fall back to `plugin.json`; Installed rows show descriptions
- [ ] **G3** [2.1.285] Plugin options form (`userConfig` → `pluginConfigs`)
- [ ] **G4** [2.1.239 F] Agent/skill files with a UTF-8 BOM lose their frontmatter
- [ ] **G5** [2.1.214 F] Auto-memory frontmatter is written unquoted (YAML injection / truncation)
- [ ] **G6** [2.1.247] `spinnerTipsOverride`: `tipsFile`, `label`, `priority`, `cooldownSessions`, `id`
- [ ] **G7** [2.1.268 low] Plugin list refreshes after an install finishes
- [ ] **G8** [2.1.248 low] `experimental.cacheTtl` agent-frontmatter hint/badge

## H — Sessions, doctor, diff, workflows

- [ ] **H1** [2.1.287/2.1.288] Sessions page: ranked name search, Enter opens best match, rebindable "find session" shortcut
- [ ] **H2** [2.1.281] Doctor: combined CLAUDE.md size incl. `@`-imports, local/user/rules
- [ ] **H3** [2.1.283] Prompt audit: stale `/command` references + contradicting instruction files
- [ ] **H4** [2.1.261] `/skill-doctor`: "unused (7d)" skills
- [ ] **H5** [2.1.260/2.1.269] `/diff` beside the chat, refreshing as Claude edits
- [ ] **H6** [2.1.265] Workflow per-agent detail (tool-call status, task list)
- [ ] **H7** [2.1.234] PR/MR badge (GitHub + GitLab)
- [ ] **H8** [2.1.236 low F] Cap session recaps at 400 chars
- [ ] **H9** [2.1.243 low F] Session list: load more than 200
- [ ] **H10** [2.1.273 low] Schedule form: "Discard unsaved changes?"
- [ ] **H11** [2.1.286 low] Schedule: late runs don't show a past "next run"
- [ ] **H12** [2.1.271 low] `/mobile` QR code
- [ ] **H13** [2.1.282 low] Doctor: telemetry env vars in project settings are ignored
- [ ] **H14** [2.1.219 low] Workflow row shows the size guideline

---

## DEC — decided (owner chose full CC parity, 2026-10-04)

These reverse deliberate Claudius choices; the repo owner chose the parity
direction for each on 2026-10-04.

- [ ] **DEC1** [2.1.236/239/246] **`/goal` → forward to the engine.** Retire Claudius's own `/goal` (`claudius_goal` MCP tool + DB), drive `GoalBanner` from the engine's `active_goal`, and surface the engine's check-in cadence (30m→1h→2h, max 3). _(Chosen: "Forward to engine".)_
- [ ] **DEC2** [2.1.283/284] **Auto mode as the new-workspace default.** Switch new workspaces from `bypassPermissions` to auto mode. _(Chosen: "Switch to auto mode".)_
- [ ] **DEC3** [2.1.221 + 2.1.212/216] **`/fork` → own git worktree + one-line confirmation.** _(Chosen: "Add worktree + confirm".)_
- [ ] **DEC4** [2.1.273] **Broaden the claude.ai OAuth scope** beyond `user:inference` so plugins work. _(Chosen: "Request broader scope".)_
- Sensitive plugin options — not a decision: keep the CLI's secure-storage behaviour; G3 writes only non-sensitive values (documented default).

## Blocked / out of scope (documented, not built)

- Spend-limit bar + `period` (2.1.251/284) and "auto mode server" `/status` row (2.1.278): no SDK 0.3.288 type/signal.
- Host memory-critical monitor (2.1.274) beyond B1's notification rendering.
- Artifacts surface, `/btw` side panel, bookmarks, session groups, per-turn focus summaries, keyless Console sign-in, managed-settings diagnostics, `/hooks` & `/permissions` managed/plugin read-only views, prompt-cache warm/cold cause, suggestion throttling, org-blocked MCP tools, `encodeProjectDir` collisions: new features or no reliable signal — follow-ups.
- `instructionFiles` modes other than the default (`claude-md`, `claude-md-and-agents-md`, `managed-only`) — in 2.1.288 this is an option of a built-in plugin (`pluginConfigs`), not a top-level setting; O2 implements the default `claude-md-or-agents-md` behaviour only.

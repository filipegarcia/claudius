# Bridge Multi-Session Capacity Meter

**Source:** Claude Code TUI — bridge-remote
**Status:** NOT_APPLICABLE

## What it is
When the Remote Control bridge is launched with `--capacity > 1`, the status panel renders a `Capacity: N/M` line followed by a bullet list of every currently-attached web session, each with an OSC-8-wrapped hyperlink to its per-session claude.ai URL and a live tool-activity hint ("Editing src/foo.ts"). `bridge/bridgeUI.ts` spells out the composition: `if (sessionMax > 1) { … writeStatus(\`    ${chalk.dim(\`Capacity: ${sessionActive}/${sessionMax} · ${modeHint}\`)}\\n\`) for (const [, info] of sessionDisplayInfo) { const titleText = info.title ? truncatePrompt(info.title, 35) : chalk.dim('Attached'); const titleLinked = wrapWithOsc8Link(titleText, info.url) … }`. Sessions are added and removed live as web users connect/disconnect, and the title falls back to the first user message when no explicit title has been set.

## Claudius today
Not surfaced in Claudius. The natural locus would be the same `external`-tagged platform commands in `lib/shared/slash-commands.ts` — `remote-control` (line 145), `teleport` (line 144), `remote-env` (line 146), `web-setup` (line 137) — which Claudius already classifies as awareness-only because they delegate to claude.ai's hosted bridge rather than the locally-launched SDK. Claudius does have a multi-session strip (`components/chat/SessionTabs.tsx`) showing every locally-resident session across the workspace, but those are SDK sessions spawned by clicking the in-app composer, not inbound attachments from a remote queue with their own per-session web URLs.

## Decision
NOT_APPLICABLE. The `Capacity: N/M` meter and its attached-session bullet list in `bridge/bridgeUI.ts` are a claude.ai-hosted bridge concern — they live in the same `--remote` / `remote-control` / `teleport` family that Claudius already classifies as `external` (see the prior notes at `docs/cheatsheet-features/cli-flags/21-remote-flag.md`, `docs/cheatsheet-features/workflows-tips/26-web-session.md`, and the sibling bridge entries `docs/cheatsheet-features/tui-microfeatures/85-bridge-environment-resume.md` and `docs/cheatsheet-features/tui-microfeatures/91-bridge-spawn-mode-toggle.md`). Claudius is a local-first wrapper over the Agent SDK with no inbound web-session queue to meter, so there is no Claudius surface for this capacity readout. Deferred — would need the hosted bridge transport, not a UI gap.

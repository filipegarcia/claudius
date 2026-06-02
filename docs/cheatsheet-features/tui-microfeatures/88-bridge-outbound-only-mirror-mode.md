# Bridge Outbound-Only Mirror Mode

**Source:** Claude Code TUI — bridge-remote
**Status:** NOT_APPLICABLE

## What it is
The Remote Control bridge can attach in an outbound-only mode where it mirrors local session events outward to the hosted backend but refuses inbound prompts and control. When a peer's `SendMessage` targets a session running in this mode, the bridge rejects it and surfaces the canned reason from `bridge/replBridgeTransport.ts`: `"This session is outbound-only. Enable Remote Control locally to allow inbound control."` The companion local setting gates cross-machine peer calls behind explicit approval, so a curious viewer cannot drive the session without the operator opting in.

## Claudius today
Not surfaced in Claudius. The natural locus would be the same `external`-tagged platform commands in `lib/shared/slash-commands.ts` — `remote-control` (line 145), `teleport` (line 144), `remote-env` (line 146), `web-setup` (line 137) — which Claudius already classifies as awareness-only because they delegate to claude.ai's hosted bridge rather than the locally-launched SDK. Claudius has no inbound-prompt channel from another machine in the first place: every session is driven by the local renderer talking to the local `SessionManager` (`lib/server/session-manager.ts`, `lib/server/session.ts`) over same-origin SSE, with no peer `SendMessage` surface that would need an outbound-only veto. The community DM transport (`chat-server/`, `lib/client/use-community.ts`) is a chat channel, not a session-control channel — it cannot inject prompts into a session, so there is nothing for an outbound-only flag to gate.

## Decision
Not applicable. The outbound-only mirror mode and the "Enable Remote Control locally to allow inbound control" rejection string in `bridge/replBridgeTransport.ts` are a claude.ai-hosted bridge concern — they live in the same `--remote` / `remote-control` / `teleport` family that Claudius already classifies as `external` (see the prior notes at `docs/cheatsheet-features/cli-flags/21-remote-flag.md`, `docs/cheatsheet-features/workflows-tips/26-web-session.md`, and the sibling bridge entries `docs/cheatsheet-features/tui-microfeatures/85-bridge-environment-resume.md` and `docs/cheatsheet-features/tui-microfeatures/91-bridge-spawn-mode-toggle.md`). Claudius is a local-first wrapper over the Agent SDK with no inbound peer-control channel to selectively disable, so there is no Claudius surface for this mode. Deferred — would need the hosted bridge transport, not a UI gap.
